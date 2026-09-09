import postgres from 'postgres';
import { normalizeMaskOperationLabels } from '../src/lib/polygon-labels.ts';

const connection = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!connection) throw new Error('Thiếu DATABASE_URL.');

const sql = postgres(connection, { max: 1, prepare: false });
const report = { annotations: 0, versions: 0, polygons: 0, renamed: 0 };

function normalizeSegmentation(raw) {
  const segmentation = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(segmentation?.maskOperations)) return { json: JSON.stringify(segmentation), polygons: 0, renamed: 0 };
  const before = segmentation.maskOperations;
  const after = normalizeMaskOperationLabels(before);
  let polygons = 0;
  let renamed = 0;
  for (let operationIndex = 0; operationIndex < before.length; operationIndex += 1) {
    const oldPolygons = before[operationIndex]?.type === 'POLYGON_SET' ? before[operationIndex].polygons || [] : [];
    const newPolygons = after[operationIndex]?.type === 'POLYGON_SET' ? after[operationIndex].polygons || [] : [];
    polygons += newPolygons.length;
    for (let index = 0; index < newPolygons.length; index += 1) {
      if (oldPolygons[index]?.label !== newPolygons[index]?.label) renamed += 1;
    }
  }
  return { json: JSON.stringify({ ...segmentation, maskOperations: after }), polygons, renamed };
}

try {
  await sql.begin(async (tx) => {
    const annotations = await tx`select dataset_file_id, segmentation_json from annotations for update`;
    for (const row of annotations) {
      const normalized = normalizeSegmentation(row.segmentation_json);
      await tx`update annotations set segmentation_json = ${normalized.json} where dataset_file_id = ${row.dataset_file_id}`;
      report.annotations += 1;
      report.polygons += normalized.polygons;
      report.renamed += normalized.renamed;
    }

    const versions = await tx`select id, segmentation_json from annotation_versions for update`;
    for (const row of versions) {
      const normalized = normalizeSegmentation(row.segmentation_json);
      await tx`update annotation_versions set segmentation_json = ${normalized.json} where id = ${row.id}`;
      report.versions += 1;
      report.polygons += normalized.polygons;
      report.renamed += normalized.renamed;
    }
  });

  const invalid = await sql.unsafe(`
    select count(*)::int as count
    from (
      select jsonb_array_elements(operation->'polygons')->>'label' as label
      from (
        select jsonb_array_elements((segmentation_json::jsonb)->'maskOperations') as operation from annotations
        union all
        select jsonb_array_elements((segmentation_json::jsonb)->'maskOperations') as operation from annotation_versions
      ) operations
      where operation->>'type' = 'POLYGON_SET'
    ) labels
    where label !~ '^(r|w)[1-9][0-9]*$'
  `);
  if (invalid[0].count !== 0) throw new Error(`Còn ${invalid[0].count} label không đúng định dạng.`);
  console.log(JSON.stringify({ ...report, invalidLabels: invalid[0].count, status: 'DATABASE LABELS READY' }, null, 2));
} finally {
  await sql.end();
}
