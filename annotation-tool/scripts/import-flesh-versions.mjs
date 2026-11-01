// Run only after backup-server.mjs completes. Adds history and activates the new crop atomically.
import { put } from '@vercel/blob';
import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

const [backupDir, datasetDir, mode] = process.argv.slice(2);
const backup = JSON.parse(await readFile(path.join(backupDir, 'backup-report.json'), 'utf8'));
const databaseBytes = await readFile(path.join(backupDir, 'database.json'));
if (!backup.complete || createHash('sha256').update(databaseBytes).digest('hex') !== backup.databaseSha256) throw Error('Verified backup required');
const original = JSON.parse(databaseBytes);
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const batchId = 'nb29-flesh-20260914';
const prefix = `datasets/${batchId}`;
const prepared = [];
try {
  const [admin] = await sql`select id from users where role = 'ADMIN' order by created_at limit 1`;
  if (!admin) throw Error('An ADMIN account is required');
  for (const item of manifest.items) {
    const key = `${item.id.split('_')[0]}_01`;
    const matches = original.dataset_files.filter((file) => file.external_key === key);
    if (matches.length !== 1) throw Error(`Ambiguous file mapping: ${key}`);
    const file = matches[0];
    const [current] = await sql`select * from dataset_files where id = ${file.id}`;
    if (current.latest_revision !== file.latest_revision || current.image_drive_file_id !== file.image_drive_file_id) throw Error(`Server changed since backup: ${key}`);
    const payload = JSON.parse(await readFile(path.join(datasetDir, item.prelabel), 'utf8'));
    if (payload.schemaVersion !== 'bitter-melon-prelabel-1.1' || payload.coordinateSpace !== 'image_pixels' || payload.width !== item.width || payload.height !== item.height || payload.maskOperations.length !== 1 || payload.maskOperations[0].type !== 'POLYGON_SET') throw Error('Invalid prelabel');
    const ids = new Set();
    const nodeIds = new Set();
    for (const polygon of payload.maskOperations[0].polygons) {
      if (!/^w[1-9]\d*$/.test(polygon.label) || !polygon.id || ids.has(polygon.id) || polygon.meta?.semantic) throw Error('Invalid instance');
      ids.add(polygon.id);
      for (const ring of [polygon.nodes, ...(polygon.holes || [])]) {
        if (ring.length < 3) throw Error('Invalid ring');
        for (const p of ring) {
          if (!p.id || nodeIds.has(p.id) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > item.width || p.y > item.height) throw Error('Invalid node');
          nodeIds.add(p.id);
        }
      }
    }
    const assets = {};
    for (const field of ['image', 'prediction', 'prelabel']) {
      const relative = item[field];
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Unsafe asset path');
      const bytes = await readFile(path.join(datasetDir, relative));
      if (field !== 'prelabel') {
        const metadata = await sharp(bytes).metadata();
        if (metadata.width !== item.width || metadata.height !== item.height) throw Error('Asset dimensions mismatch');
      }
      assets[field] = { bytes, pathname: `${prefix}/${relative}` };
    }
    prepared.push({ file, item, payload, assets });
  }
  console.log(JSON.stringify(prepared.map(({ file, item, payload }) => ({ file: file.external_key, revision: file.latest_revision, oldSize: [file.width, file.height], newSize: [item.width, item.height], polygons: payload.maskOperations[0].polygons.length }))));
  if (mode !== '--apply') { console.log('DRY RUN OK'); } else {
    for (const { assets } of prepared) for (const asset of Object.values(assets)) {
      await put(asset.pathname, asset.bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: asset.pathname.endsWith('.json') ? 'application/json' : 'image/png' });
    }
    // A combined source manifest keeps a later "sync source" from reverting the new crops.
    const datasetIds = [...new Set(prepared.map(({ file }) => file.dataset_id))];
    if (datasetIds.length !== 1) throw Error('Expected one dataset');
    const dataset = original.datasets.find((d) => d.id === datasetIds[0]);
    const mergedItems = original.dataset_files.filter((f) => f.dataset_id === dataset.id).map((file) => {
      const replacement = prepared.find((entry) => entry.file.id === file.id);
      const relative = (reference) => {
        if (!reference.startsWith('blob:datasets/')) throw Error('Unexpected source asset');
        return reference.slice('blob:datasets/'.length);
      };
      return replacement ? { ...replacement.item, id: file.external_key,
        image: relative('blob:' + replacement.assets.image.pathname), prediction: relative('blob:' + replacement.assets.prediction.pathname), prelabel: relative('blob:' + replacement.assets.prelabel.pathname) }
        : { id: file.external_key, image: relative(file.image_drive_file_id), prediction: relative(file.prediction_drive_file_id),
          ...(file.prelabel_storage_ref ? { prelabel: relative(file.prelabel_storage_ref) } : {}), width: file.width, height: file.height };
    });
    await put('datasets/manifest.json', JSON.stringify({ dataset_version: batchId, algorithm_version: 'v7-plus-nb29-flesh', items: mergedItems }), {
      access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json',
    });
    const report = await sql.begin(async (tx) => {
      await tx`alter table annotation_versions add column if not exists asset_snapshot_json text`;
      await tx`alter table annotation_versions add column if not exists version_label text`;
      const result = [];
      for (const { file, item, payload, assets } of prepared) {
        const [current] = await tx`select * from dataset_files where id = ${file.id} for update`;
        if (current.latest_revision !== file.latest_revision || current.image_drive_file_id !== file.image_drive_file_id) throw Error('Concurrent server edit; no data changed');
        const locks = await tx`select * from file_locks where dataset_file_id = ${file.id} and expires_at > ${new Date().toISOString()}`;
        if (locks.length) throw Error(`Image is being edited: ${file.external_key}`);
        const [annotation] = await tx`select * from annotations where dataset_file_id = ${file.id}`;
        if (!annotation) throw Error('Expected server annotation to preserve');
        const existing = await tx`select id from annotation_versions where dataset_file_id = ${file.id} and version_label = ${batchId}`;
        if (existing.length) throw Error('Batch already imported');
        const oldAssets = JSON.stringify({ image: file.image_drive_file_id, prediction: file.prediction_drive_file_id, width: file.width, height: file.height });
        await tx`update annotation_versions set asset_snapshot_json = ${oldAssets} where dataset_file_id = ${file.id} and asset_snapshot_json is null`;
        const now = new Date().toISOString();
        const oldNumber = Number(file.latest_version_number) + 1;
        const newNumber = oldNumber + 1;
        const revision = Number(file.latest_revision) + 1;
        const freshAssets = { image: `blob:${assets.image.pathname}`, prediction: `blob:${assets.prediction.pathname}`, width: item.width, height: item.height };
        const segmentation = JSON.stringify({ humanAction: 'MODIFIED', sourcePredictionDriveFileId: freshAssets.prediction, maskOperations: payload.maskOperations, wartPoints: { state: 'NOT_ANNOTATED', points: [] } });
        const breakpoints = JSON.stringify({ state: 'NOT_ANNOTATED', points: [] });
        for (const version of [
          { number: oldNumber, label: 'Server trước khi nạp flesh mask', segmentation: annotation.segmentation_json, breakpoints: annotation.breakpoints_json, assets: oldAssets },
          { number: newNumber, label: batchId, segmentation, breakpoints, assets: JSON.stringify(freshAssets) },
        ]) await tx`insert into annotation_versions (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, created_at, asset_snapshot_json, version_label)
          values (${randomUUID()}, ${file.id}, ${version.number}, ${file.latest_revision}, ${version.segmentation}, ${version.breakpoints}, ${admin.id}, ${now}, ${version.assets}, ${version.label})`;
        await tx`update annotations set revision = ${revision}, status = 'DRAFT', segmentation_json = ${segmentation}, breakpoints_json = ${breakpoints}, last_edited_by = ${admin.id}, updated_at = ${now} where dataset_file_id = ${file.id}`;
        await tx`update dataset_files set latest_revision = ${revision}, latest_version_number = ${newNumber}, annotation_state = 'DRAFT', image_drive_file_id = ${freshAssets.image}, prediction_drive_file_id = ${freshAssets.prediction}, prelabel_storage_ref = ${'blob:' + assets.prelabel.pathname}, image_filename = ${path.basename(item.image)}, prediction_filename = ${path.basename(item.prediction)}, prelabel_filename = ${path.basename(item.prelabel)}, width = ${item.width}, height = ${item.height}, updated_at = ${now} where id = ${file.id}`;
        result.push({ fileId: file.id, key: file.external_key, serverVersion: oldNumber, fleshVersion: newNumber, revision });
      }
      await tx`update projects set drive_folder_id = 'blob:datasets/manifest.json', updated_at = ${new Date().toISOString()} where id = ${dataset.project_id}`;
      await tx`update datasets set manifest_drive_file_id = 'blob:datasets/manifest.json', dataset_version = ${batchId}, algorithm_version = 'v7-plus-nb29-flesh' where id = ${dataset.id}`;
      return result;
    });
    await writeFile(path.join(backupDir, 'import-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
} finally { await sql.end(); }
