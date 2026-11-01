import postgres from 'postgres';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'download-manifest.json')));
  const rows = await sql.begin('isolation level repeatable read read only', tx => tx`
    SELECT df.external_key, df.width, df.height, a.revision, a.segmentation_json, a.breakpoints_json,
      df.prediction_drive_file_id FROM annotations a JOIN dataset_files df ON df.id = a.dataset_file_id
    WHERE a.status <> 'UNSTARTED' ORDER BY df.external_key`);
  const report = { checkedAt: new Date().toISOString(), source: 'read-only current database annotations', items: [] };
  for (const item of manifest.items) {
    const row = rows.find(row => row.external_key === item.imageId);
    if (!row) throw Error(`Annotation not found: ${item.imageId}`);
    const raw = await readFile(path.join(root, item.imageId, 'segmentation.json'));
    const json = typeof row.segmentation_json === 'string' ? row.segmentation_json : JSON.stringify(row.segmentation_json);
    const saved = JSON.parse(raw);
    const current = JSON.parse(json);
    const polygons = current.maskOperations?.at(-1)?.polygons;
    const same = JSON.stringify(saved) === JSON.stringify(current);
    const source = current.maskStorageKey ? 'stored_raster' : 'initial_prediction_fallback';
    report.items.push({ imageId: item.imageId, exportedRevision: item.revision, databaseRevision: row.revision,
      sameSegmentationBytes: raw.equals(Buffer.from(json)), sameSegmentationObject: same,
      sameDimensions: JSON.parse(await readFile(path.join(root, item.imageId, 'annotation.json'))).width === Number(row.width)
        && JSON.parse(await readFile(path.join(root, item.imageId, 'annotation.json'))).height === Number(row.height),
      exportedSegmentationSha256: hash(raw), databaseSegmentationSha256: hash(Buffer.from(json)),
      databasePolygonCount: polygons?.length ?? 0, savedMaskActualSource: source });
    console.log(`${item.imageId}: revision ${row.revision}, exact JSON bytes=${raw.equals(Buffer.from(json))}, source=${source}`);
  }
  report.allMatch = report.items.every(item => item.sameSegmentationBytes && item.sameDimensions && item.exportedRevision === item.databaseRevision);
  await writeFile(output, JSON.stringify(report, null, 2));
  if (!report.allMatch) process.exitCode = 1;
} finally { await sql.end(); }
