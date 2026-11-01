import postgres from 'postgres';
import { put } from '@vercel/blob';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { rasterizePolygons } from '../src/lib/mask-pixels.ts';

const [backupDir, datasetDir, mode] = process.argv.slice(2);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const backup = JSON.parse(await readFile(path.join(backupDir, 'backup-report.json'), 'utf8'));
const databaseBytes = await readFile(path.join(backupDir, 'database.json'));
if (!backup.complete || hash(databaseBytes) !== backup.databaseSha256) throw Error('Verified backup required');
const original = JSON.parse(databaseBytes);
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
const prefix = `datasets/${manifest.dataset_version}`;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const prepared = [];
try {
  if (manifest.items.length !== original.dataset_files.length) throw Error('Notebook dataset must cover all existing images');
  const [admin] = await sql`select id from users where role = 'ADMIN' order by created_at limit 1`;
  if (!admin) throw Error('ADMIN required');
  for (const item of manifest.items) {
    const matches = original.dataset_files.filter((f) => f.external_key === item.id);
    if (matches.length !== 1) throw Error('Ambiguous file mapping');
    const file = matches[0];
    const assets = {};
    for (const field of ['image', 'prediction', 'prelabel']) {
      if (path.isAbsolute(item[field]) || item[field].split(/[\\/]/).includes('..')) throw Error('Unsafe asset path');
      assets[field] = { pathname: `${prefix}/${item[field]}`, bytes: await readFile(path.join(datasetDir, item[field])) };
    }
    if (hash(assets.image.bytes) !== item.imageSha256 || hash(assets.prediction.bytes) !== item.maskSha256) throw Error('Notebook asset checksum mismatch');
    const image = await sharp(assets.image.bytes).metadata();
    const { data: mask, info } = await sharp(assets.prediction.bytes).greyscale().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (image.width !== item.width || image.height !== item.height || info.width !== item.width || info.height !== item.height) throw Error('Crop mismatch');
    const payload = JSON.parse(assets.prelabel.bytes);
    if (payload.width !== item.width || payload.height !== item.height || payload.schemaVersion !== 'bitter-melon-prelabel-1.1') throw Error('Invalid prelabel');
    const polygons = payload.maskOperations[0].polygons;
    if (!Buffer.from(rasterizePolygons(polygons, item.width, item.height)).equals(mask)) throw Error(`Contour changed pixels: ${item.id}`);
    const ids = new Set();
    for (const polygon of polygons) {
      if (!/^w[1-9]\d*$/.test(polygon.label) || !polygon.id || ids.has(polygon.id)) throw Error('Invalid instance');
      ids.add(polygon.id);
      for (const ring of [polygon.nodes, ...(polygon.holes || [])]) {
        if (ring.length < 3) throw Error('Invalid ring');
        for (const p of ring) {
          if (!p.id || ids.has(p.id) || p.x < 0 || p.y < 0 || p.x > item.width || p.y > item.height) throw Error('Invalid node');
          ids.add(p.id);
        }
      }
    }
    const savedAnnotation = original.annotations.find((a) => a.dataset_file_id === file.id);
    const oldPrelabel = !savedAnnotation && file.prelabel_storage_ref
      ? JSON.parse(await readFile(path.join(backupDir, 'blobs', file.prelabel_storage_ref.replace(/^blob:/, '')), 'utf8')) : null;
    prepared.push({ file, item, payload, assets, oldPrelabel });
  }
  const validateServer = async (tx, lock = false) => {
    for (const { file } of prepared) {
      const [current] = lock ? await tx`select * from dataset_files where id = ${file.id} for update` : await tx`select * from dataset_files where id = ${file.id}`;
      if (current.latest_revision !== file.latest_revision || current.latest_version_number !== file.latest_version_number || current.image_drive_file_id !== file.image_drive_file_id) throw Error(`Server changed after backup: ${file.external_key}`);
      const locks = await tx`select dataset_file_id from file_locks where dataset_file_id = ${file.id} and expires_at > ${new Date().toISOString()}`;
      if (locks.length) throw Error(`Active editor: ${file.external_key}`);
    }
  };
  await validateServer(sql);
  console.log(JSON.stringify(prepared.map(({ file, item, payload }) => ({ image: item.id, notebook: item.notebook, oldSize: [file.width, file.height], newSize: [item.width, item.height], polygons: payload.maskOperations[0].polygons.length }))));
  if (mode !== '--apply') { console.log('DRY RUN OK'); } else {
    const assets = prepared.flatMap((p) => Object.values(p.assets));
    for (let i = 0; i < assets.length; i += 4) {
      await Promise.all(assets.slice(i, i + 4).map((asset) => put(asset.pathname, asset.bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: asset.pathname.endsWith('.json') ? 'application/json' : 'image/png' })));
      console.log(`Uploaded ${Math.min(i + 4, assets.length)}/${assets.length}`);
    }
    const manifestRef = `blob:${prefix}/manifest.json`;
    await put(`${prefix}/manifest.json`, JSON.stringify(manifest), { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' });
    const report = await sql.begin(async (tx) => {
      await validateServer(tx, true);
      const result = [];
      const now = new Date().toISOString();
      for (const { file, item, payload, assets, oldPrelabel } of prepared) {
        const [annotation] = await tx`select * from annotations where dataset_file_id = ${file.id}`;
        const oldAssets = JSON.stringify({ image: file.image_drive_file_id, prediction: file.prediction_drive_file_id, width: file.width, height: file.height });
        await tx`update annotation_versions set asset_snapshot_json = ${oldAssets} where dataset_file_id = ${file.id} and asset_snapshot_json is null`;
        const oldSeg = annotation?.segmentation_json || JSON.stringify({ humanAction: 'UNTOUCHED', sourcePredictionDriveFileId: file.prediction_drive_file_id, maskOperations: oldPrelabel?.maskOperations || [] });
        const oldBp = annotation?.breakpoints_json || JSON.stringify({ state: 'NOT_ANNOTATED', points: [] });
        const freshAssets = { image: `blob:${assets.image.pathname}`, prediction: `blob:${assets.prediction.pathname}`, width: item.width, height: item.height };
        const segmentation = JSON.stringify({ humanAction: 'MODIFIED', sourcePredictionDriveFileId: freshAssets.prediction, maskStorageKey: assets.prediction.pathname,
          maskOperations: payload.maskOperations, wartPoints: { state: 'NOT_ANNOTATED', points: [] }, sourceNotebook: item.notebook, sourceImageSha256: item.sourceSha256, notebookSha256: item.notebookSha256 });
        const breakpoints = JSON.stringify({ state: 'NOT_ANNOTATED', points: [] });
        const oldVersion = Number(file.latest_version_number) + 1, newVersion = oldVersion + 1, revision = Number(file.latest_revision) + 1;
        for (const entry of [
          { number: oldVersion, label: 'Bản đã chỉnh sửa trước NB27/NB29', segmentation: oldSeg, breakpoints: oldBp, assets: oldAssets },
          { number: newVersion, label: `Notebook ${item.notebook} · crop gốc · contour`, segmentation, breakpoints, assets: JSON.stringify(freshAssets) },
        ]) await tx`insert into annotation_versions (id,dataset_file_id,version_number,base_revision,segmentation_json,breakpoints_json,created_by,created_at,asset_snapshot_json,version_label)
          values (${randomUUID()},${file.id},${entry.number},${file.latest_revision},${entry.segmentation},${entry.breakpoints},${admin.id},${now},${entry.assets},${entry.label})`;
        await tx`insert into annotations (dataset_file_id,revision,status,segmentation_json,breakpoints_json,last_edited_by,updated_at)
          values (${file.id},${revision},'DRAFT',${segmentation},${breakpoints},${admin.id},${now})
          on conflict(dataset_file_id) do update set revision=excluded.revision,status=excluded.status,segmentation_json=excluded.segmentation_json,breakpoints_json=excluded.breakpoints_json,last_edited_by=excluded.last_edited_by,updated_at=excluded.updated_at`;
        await tx`update dataset_files set latest_revision=${revision},latest_version_number=${newVersion},annotation_state='DRAFT',
          image_drive_file_id=${freshAssets.image},prediction_drive_file_id=${freshAssets.prediction},prelabel_storage_ref=${'blob:'+assets.prelabel.pathname},
          image_filename=${path.basename(item.image)},prediction_filename=${path.basename(item.prediction)},prelabel_filename=${path.basename(item.prelabel)},width=${item.width},height=${item.height},updated_at=${now} where id=${file.id}`;
        result.push({ image: item.id, fileId: file.id, preservedVersion: oldVersion, newVersion, notebook: item.notebook, revision });
      }
      const datasetIds = [...new Set(prepared.map((p) => p.file.dataset_id))];
      if (datasetIds.length !== 1) throw Error('Expected one dataset');
      const dataset = original.datasets.find((d) => d.id === datasetIds[0]);
      await tx`update datasets set manifest_drive_file_id=${manifestRef},dataset_version=${manifest.dataset_version},algorithm_version=${manifest.algorithm_version},updated_at=${now} where id=${dataset.id}`;
      await tx`update projects set drive_folder_id=${manifestRef},updated_at=${now} where id=${dataset.project_id}`;
      return result;
    });
    await writeFile(path.join(backupDir, 'import-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} finally { await sql.end(); }
