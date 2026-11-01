import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const target = path.resolve('artifacts/trial-8582-2026-10-04');
const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL, { max: 1, prepare: false, connect_timeout: 20 });
try {
  const rows = await sql`SELECT df.external_key, df.width, df.height, df.latest_version_number,
    a.revision, a.segmentation_json, a.status FROM annotations a
    JOIN dataset_files df ON df.id = a.dataset_file_id WHERE df.external_key = '8582_01'`;
  if (rows.length !== 1) throw Error('Expected exactly one 8582_01 annotation');
  const row = rows[0];
  const original = JSON.parse(await readFile(path.join(target, 'annotation.original.json')));
  const raw = typeof row.segmentation_json === 'string' ? row.segmentation_json : JSON.stringify(row.segmentation_json);
  const originalRaw = await readFile('artifacts/ground-truth-audited-2026-10-04/8582_01/segmentation.json');
  const segmentation = JSON.parse(raw);
  const report = { checkedAt: new Date().toISOString(), imageId: row.external_key, revision: row.revision,
    version: row.latest_version_number, status: row.status, width: row.width, height: row.height,
    sameOriginalSegmentationBytes: originalRaw.equals(Buffer.from(raw)),
    sameOriginalPolygonCoordinates: JSON.stringify(original.maskOperations) === JSON.stringify(segmentation.maskOperations),
    currentPolygonCount: segmentation.maskOperations.at(-1)?.polygons?.length,
    originalSha256: createHash('sha256').update(originalRaw).digest('hex'),
    databaseSha256: createHash('sha256').update(raw).digest('hex'),
    hasStoredRaster: Boolean(segmentation.maskStorageKey) };
  await writeFile(path.join(target, 'live-source-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await sql.end(); }
