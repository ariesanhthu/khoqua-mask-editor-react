// Adds NEW images from a dataset built by build-surface-dataset.mjs to the existing production dataset.
// Insert-only: never updates or deletes existing rows, never overwrites a Blob, does not change the
// project's source manifest. Run only after backup-server.mjs completes; dry run unless --apply.
//
//   node --experimental-strip-types --env-file=.env.local scripts/import-surface-dataset.mjs <backupDir> <datasetDir> [--replace] [--apply]
//
// --replace swaps the assets (image, prediction, prelabel, width/height) of images that already exist, e.g.
// the cropped rebuild of an earlier import. Allowed only while nobody has touched them: UNSTARTED, revision 0,
// no annotation, no version, no session, no live lock. New Blobs go under a new prefix; old ones are kept.
//
// Rows match what "Đồng bộ nguồn" (syncProjectFromDrive) inserts for a new manifest item: blob: references,
// file names, width/height, annotation_state UNSTARTED; everything else keeps its column default.
import { get, list, put } from '@vercel/blob';
import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { rasterizePolygons } from '../src/lib/mask-pixels.ts';

const [backupDir, datasetArg, ...flags] = process.argv.slice(2);
if (!backupDir || !datasetArg || flags.some((flag) => !['--apply', '--replace'].includes(flag))) {
  throw Error('Usage: import-surface-dataset.mjs <backupDir> <datasetDir> [--replace] [--apply]');
}
const apply = flags.includes('--apply');
const replace = flags.includes('--replace');
const datasetDir = path.resolve(datasetArg);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const databaseBytes = await readFile(path.join(backupDir, 'database.json'));
const backup = JSON.parse(await readFile(path.join(backupDir, 'backup-report.json'), 'utf8'));
if (!backup.complete || hash(databaseBytes) !== backup.databaseSha256) throw Error('Verified backup required');
const snapshot = JSON.parse(databaseBytes);
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
if (!/^[A-Za-z0-9._-]+$/.test(manifest.dataset_version || '')) throw Error('Unsafe dataset_version');
const prefix = `datasets/${manifest.dataset_version}`;
if (snapshot.projects.length !== 1 || snapshot.datasets.length !== 1) throw Error('Expected exactly one project and one dataset');
const [dataset] = snapshot.datasets;
const existingKeys = new Set(snapshot.dataset_files.map((file) => file.external_key));

// 1. Local checks: checksums, sizes, prelabel rules of parsePrelabelOperations, prediction = rasterized prelabel.
const prepared = [];
for (const item of manifest.items) {
  if (!replace && existingKeys.has(item.id)) throw Error(`${item.id} already exists on the server`);
  if (replace && !existingKeys.has(item.id)) throw Error(`${item.id} does not exist on the server`);
  const assets = {};
  for (const field of ['image', 'prediction', 'prelabel']) {
    const relative = item[field];
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Unsafe asset path');
    assets[field] = { relative, bytes: await readFile(path.join(datasetDir, relative)) };
  }
  if (hash(assets.image.bytes) !== item.imageSha256 || hash(assets.prediction.bytes) !== item.maskSha256
    || hash(assets.prelabel.bytes) !== item.prelabelSha256) throw Error(`${item.id}: checksum mismatch`);
  const image = await sharp(assets.image.bytes).metadata();
  if (image.format !== 'jpeg' || image.width !== item.width || image.height !== item.height || (image.orientation ?? 1) !== 1) throw Error(`${item.id}: image size`);
  const { data: mask, info } = await sharp(assets.prediction.bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== item.width || info.height !== item.height || info.channels !== 1) throw Error(`${item.id}: prediction size`);
  const payload = JSON.parse(assets.prelabel.bytes);
  if (payload.schemaVersion !== 'bitter-melon-prelabel-1.1' || payload.coordinateSpace !== 'image_pixels' || payload.imageId !== item.id
    || payload.width !== item.width || payload.height !== item.height || payload.maskOperations?.length !== 1
    || payload.maskOperations[0].type !== 'POLYGON_SET') throw Error(`${item.id}: invalid prelabel`);
  const { polygons } = payload.maskOperations[0];
  const ids = new Set();
  for (const polygon of polygons) {
    if (!/^w[1-9]\d*$/.test(polygon.label) || !polygon.id || ids.has(polygon.id) || polygon.nodes.length < 3) throw Error(`${item.id}: invalid polygon`);
    ids.add(polygon.id);
    for (const ring of [polygon.nodes, ...(polygon.holes ?? [])]) {
      if (ring.length < 3) throw Error(`${item.id}: invalid ring`);
      for (const p of ring) {
        if (!p.id || ids.has(p.id) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > item.width || p.y > item.height) throw Error(`${item.id}: invalid node`);
        ids.add(p.id);
      }
    }
  }
  if (polygons.length !== item.polygons) throw Error(`${item.id}: polygon count`);
  if (!Buffer.from(rasterizePolygons(polygons, item.width, item.height)).equals(mask)) throw Error(`${item.id}: prediction differs from prelabel`);
  prepared.push({ item, assets });
}
const manifestBytes = await readFile(path.join(datasetDir, 'manifest.json'));

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  // 2. Server checks: same project/dataset as the backup, no row added or removed since. With --replace,
  //    every target row must still be untouched and must not point at the new prefix already.
  const checkServer = async (tx, lock) => {
    const [current] = lock
      ? await tx`select id, project_id from datasets where id = ${dataset.id} for update`
      : await tx`select id, project_id from datasets where id = ${dataset.id}`;
    if (!current || current.project_id !== dataset.project_id) throw Error('Dataset changed since backup');
    const keys = (await tx`select external_key from dataset_files where dataset_id = ${dataset.id}`).map((row) => row.external_key);
    if (keys.length !== existingKeys.size || keys.some((key) => !existingKeys.has(key))) throw Error('dataset_files changed since backup');
    if (!replace) return [];
    const targets = prepared.map(({ item }) => item.id);
    const rows = lock
      ? await tx`select * from dataset_files where dataset_id = ${dataset.id} and external_key = any(${targets}) for update`
      : await tx`select * from dataset_files where dataset_id = ${dataset.id} and external_key = any(${targets})`;
    const ids = rows.map((row) => row.id);
    const touched = new Set([
      ...rows.filter((row) => row.annotation_state !== 'UNSTARTED' || Number(row.latest_revision) !== 0 || Number(row.latest_version_number) !== 0
        || row.image_drive_file_id.startsWith(`blob:${prefix}/`)).map((row) => row.id),
      ...(await tx`select dataset_file_id from annotations where dataset_file_id = any(${ids})`).map((row) => row.dataset_file_id),
      ...(await tx`select dataset_file_id from annotation_versions where dataset_file_id = any(${ids})`).map((row) => row.dataset_file_id),
      ...(await tx`select dataset_file_id from annotation_sessions where dataset_file_id = any(${ids})`).map((row) => row.dataset_file_id),
      ...(await tx`select dataset_file_id from file_locks where dataset_file_id = any(${ids}) and expires_at > ${new Date().toISOString()}`).map((row) => row.dataset_file_id),
    ]);
    if (rows.length !== targets.length || touched.size) {
      throw Error(`Cannot replace touched images: ${rows.filter((row) => touched.has(row.id)).map((row) => row.external_key).join(', ') || 'missing rows'}`);
    }
    return rows;
  };
  await checkServer(sql, false);

  // 3. Blob state under the new prefix: absent, or byte-identical from an interrupted earlier run.
  const uploads = [...prepared.flatMap(({ assets }) => Object.values(assets)), { relative: 'manifest.json', bytes: manifestBytes }]
    .map((asset) => ({ ...asset, pathname: `${prefix}/${asset.relative}` }));
  const remote = new Map();
  let cursor;
  do {
    const page = await list({ prefix: `${prefix}/`, cursor, limit: 1000 });
    for (const blob of page.blobs) remote.set(blob.pathname, blob);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const pending = [];
  for (const asset of uploads) {
    const blob = remote.get(asset.pathname);
    if (!blob) { pending.push(asset); continue; }
    const response = await get(blob.url, { access: 'private', useCache: false });
    const bytes = response?.statusCode === 200 && response.stream ? Buffer.from(await new Response(response.stream).arrayBuffer()) : null;
    if (!bytes || hash(bytes) !== hash(asset.bytes)) throw Error(`Different Blob already at ${asset.pathname}`);
  }
  const unknown = [...remote.keys()].filter((pathname) => !uploads.some((asset) => asset.pathname === pathname));
  if (unknown.length) throw Error(`Unexpected Blobs under ${prefix}: ${unknown.slice(0, 3).join(', ')}`);

  const total = (key) => prepared.reduce((sum, { item }) => sum + item[key], 0);
  console.log(JSON.stringify({ project: snapshot.projects[0].name, dataset: dataset.id, existing: existingKeys.size, [replace ? 'replace' : 'add']: prepared.length,
    prefix, blobsToUpload: pending.length, blobsAlreadyThere: uploads.length - pending.length, instances: total('instances'), vertices: total('vertices') }));
  if (!apply) { console.log('DRY RUN OK'); } else {
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map((asset) => put(asset.pathname, asset.bytes, {
        access: 'private', addRandomSuffix: false, allowOverwrite: false,
        contentType: asset.pathname.endsWith('.json') ? 'application/json' : asset.pathname.endsWith('.png') ? 'image/png' : 'image/jpeg',
      })));
      console.log(`Uploaded ${Math.min(i + 4, pending.length)}/${pending.length}`);
    }
    const now = new Date().toISOString();
    const rows = await sql.begin(async (tx) => {
      const targets = await checkServer(tx, true);
      if (replace) {
        const replaced = [];
        for (const { item, assets } of prepared) {
          const row = targets.find((target) => target.external_key === item.id);
          const result = await tx`update dataset_files set image_drive_file_id = ${`blob:${prefix}/${assets.image.relative}`},
              prediction_drive_file_id = ${`blob:${prefix}/${assets.prediction.relative}`}, prelabel_storage_ref = ${`blob:${prefix}/${assets.prelabel.relative}`},
              image_filename = ${path.posix.basename(assets.image.relative)}, prediction_filename = ${path.posix.basename(assets.prediction.relative)},
              prelabel_filename = ${path.posix.basename(assets.prelabel.relative)}, width = ${item.width}, height = ${item.height}, updated_at = ${now}
            where id = ${row.id} and latest_revision = 0`;
          if (result.count !== 1) throw Error(`${item.id}: row changed during replace`);
          replaced.push({ id: row.id, externalKey: item.id, previousImage: row.image_drive_file_id, previousSize: [row.width, row.height], size: [item.width, item.height], crop: item.crop });
        }
        await tx`update projects set updated_at = ${now} where id = ${dataset.project_id}`;
        return replaced;
      }
      const inserted = [];
      for (const { item, assets } of prepared) {
        const id = randomUUID();
        await tx`insert into dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, prelabel_storage_ref,
            image_filename, prediction_filename, prelabel_filename, width, height, annotation_state, created_at, updated_at)
          values (${id}, ${dataset.id}, ${item.id}, ${`blob:${prefix}/${assets.image.relative}`}, ${`blob:${prefix}/${assets.prediction.relative}`},
            ${`blob:${prefix}/${assets.prelabel.relative}`}, ${path.posix.basename(assets.image.relative)}, ${path.posix.basename(assets.prediction.relative)},
            ${path.posix.basename(assets.prelabel.relative)}, ${item.width}, ${item.height}, 'UNSTARTED', ${now}, ${now})`;
        inserted.push({ id, externalKey: item.id, group: item.group, polygons: item.polygons, vertices: item.vertices });
      }
      await tx`update projects set updated_at = ${now} where id = ${dataset.project_id}`;
      return inserted;
    });
    const report = { importedAt: now, mode: replace ? 'replace' : 'insert', prefix, datasetId: dataset.id, manifestSha256: hash(manifestBytes), files: rows };
    const reportFile = path.join(backupDir, replace ? 'surface-replace-report.json' : 'surface-import-report.json');
    await writeFile(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ [replace ? 'replaced' : 'inserted']: rows.length, report: reportFile }));
  }
} finally {
  await sql.end();
}
