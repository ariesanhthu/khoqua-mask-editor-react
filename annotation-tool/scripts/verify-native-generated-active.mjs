import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import assert from 'assert/strict';
import postgres from 'postgres';

const reportPath = process.argv[2];
const manifestPath = process.argv[3];
const outPath = process.argv[4] || path.join(path.dirname(reportPath || '.'), 'verify-native-generated-active.json');

if (!reportPath || !manifestPath) {
  console.error('Usage: node --env-file=.env.local scripts/verify-native-generated-active.mjs <activate-report.json> <native-manifest.json> [out-report.json]');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const activation = JSON.parse(await readFile(reportPath, 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const items = new Map(manifest.items.map(item => [item.id, item]));
const sql = postgres(connectionString, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 15 });
const verified = [];

try {
  for (const file of activation.files) {
    const item = items.get(file.image);
    assert.ok(item, `Manifest item missing for ${file.image}`);
    const [row] = await sql`
      select
        df.latest_revision,
        df.latest_version_number,
        df.width,
        df.height,
        df.image_drive_file_id,
        df.prediction_drive_file_id,
        a.revision,
        a.segmentation_json,
        a.breakpoints_json
      from dataset_files df
      join annotations a on a.dataset_file_id = df.id
      where df.id = ${file.fileId}
    `;
    assert.ok(row, `Current annotation missing for ${file.image}`);
    assert.equal(Number(row.latest_revision), file.revision, `${file.image} latest revision`);
    assert.equal(Number(row.revision), file.revision, `${file.image} annotation revision`);
    assert.equal(Number(row.latest_version_number), file.newActiveVersion, `${file.image} latest version`);
    assert.equal(Number(row.width), item.width, `${file.image} width`);
    assert.equal(Number(row.height), item.height, `${file.image} height`);

    const segmentation = JSON.parse(String(row.segmentation_json));
    assert.equal(segmentation.preprocessing, 'native_drive_pixels_no_crop_no_resize', `${file.image} preprocessing`);
    assert.equal(Number(segmentation.sourceNotebook), Number(item.notebook), `${file.image} notebook`);
    assert.equal(segmentation.sourceImageSha256, item.sourceSha256, `${file.image} source sha`);
    const polygons = segmentation.maskOperations?.at(-1)?.polygons || [];
    assert.equal(polygons.length, Number(item.polygonCount), `${file.image} polygon count`);

    const [oldSnapshot] = await sql`
      select id from annotation_versions
      where dataset_file_id = ${file.fileId}
        and version_number = ${file.oldActiveSavedAs}
        and version_label = 'Manual/server annotation before activating native notebook mask'
    `;
    assert.ok(oldSnapshot, `${file.image} old active snapshot`);

    const [newSnapshot] = await sql`
      select id, segmentation_json from annotation_versions
      where dataset_file_id = ${file.fileId}
        and version_number = ${file.newActiveVersion}
        and version_label = ${`Active native notebook mask from v${file.generatedVersion}`}
    `;
    assert.ok(newSnapshot, `${file.image} new active snapshot`);
    assert.equal(String(newSnapshot.segmentation_json), String(row.segmentation_json), `${file.image} active snapshot exact`);

    verified.push({
      image: file.image,
      revision: file.revision,
      activeVersion: file.newActiveVersion,
      oldActiveSavedAs: file.oldActiveSavedAs,
      notebook: Number(item.notebook),
      polygons: polygons.length,
      size: [item.width, item.height],
    });
  }

  const [counts] = await sql`
    select
      (select count(*)::int from annotations) as annotations,
      (select count(*)::int from annotation_versions) as versions
  `;
  const result = { result: 'PASS', counts, verified };
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
