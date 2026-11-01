import crypto from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import postgres from 'postgres';

const reportPath = process.argv[2];
const outPath = process.argv[3] || path.join(path.dirname(reportPath || '.'), 'activate-native-generated-report.json');

if (!reportPath) {
  console.error('Usage: node --env-file=.env.local scripts/activate-native-generated.mjs <drive-import-report.json> [out-report.json]');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const sql = postgres(connectionString, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 15 });

const now = new Date().toISOString();
const adminId = await findAdmin();
const result = [];

try {
  await sql.begin(async tx => {
    for (const item of report) {
      const [file] = await tx`
        select * from dataset_files
        where id = ${item.fileId}
        for update
      `;
      if (!file) throw new Error(`Missing dataset file for ${item.image}`);

      const [lock] = await tx`
        select * from file_locks
        where dataset_file_id = ${item.fileId}
      `;
      if (lock && new Date(String(lock.expires_at)) > new Date()) {
        throw new Error(`Active edit lock exists for ${item.image}`);
      }

      const [current] = await tx`
        select * from annotations
        where dataset_file_id = ${item.fileId}
      `;
      if (!current) throw new Error(`Missing current annotation for ${item.image}`);

      const [generated] = await tx`
        select * from annotation_versions
        where dataset_file_id = ${item.fileId}
          and version_number = ${item.generatedVersion}
      `;
      if (!generated) throw new Error(`Missing generated version ${item.generatedVersion} for ${item.image}`);

      const generatedSegmentation = JSON.parse(String(generated.segmentation_json));
      if (
        generatedSegmentation.preprocessing !== 'native_drive_pixels_no_crop_no_resize' ||
        ![27, 29].includes(Number(generatedSegmentation.sourceNotebook)) ||
        generatedSegmentation.sourceImageSha256 !== item.sourceSha256
      ) {
        throw new Error(`Version ${item.generatedVersion} is not the native Drive notebook output for ${item.image}`);
      }

      const assets = generated.asset_snapshot_json
        ? JSON.parse(String(generated.asset_snapshot_json))
        : {
            image: file.image_drive_file_id,
            prediction: file.prediction_drive_file_id,
            width: file.width,
            height: file.height,
          };

      const maxRows = await tx`
        select coalesce(max(version_number), 0)::int as max_version
        from annotation_versions
        where dataset_file_id = ${item.fileId}
      `;
      let nextVersion = Number(maxRows[0].max_version);
      const baseRevision = Number(file.latest_revision);
      const currentAssets = JSON.stringify({
        image: file.image_drive_file_id,
        prediction: file.prediction_drive_file_id,
        width: file.width,
        height: file.height,
      });

      const currentVersion = ++nextVersion;
      await tx`
        insert into annotation_versions (
          id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json,
          created_by, created_at, asset_snapshot_json, version_label
        ) values (
          ${crypto.randomUUID()}, ${item.fileId}, ${currentVersion}, ${baseRevision},
          ${String(current.segmentation_json)}, ${String(current.breakpoints_json)},
          ${adminId}, ${now}, ${currentAssets},
          ${'Manual/server annotation before activating native notebook mask'}
        )
      `;

      const activatedVersion = ++nextVersion;
      await tx`
        insert into annotation_versions (
          id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json,
          created_by, created_at, asset_snapshot_json, version_label
        ) values (
          ${crypto.randomUUID()}, ${item.fileId}, ${activatedVersion}, ${baseRevision},
          ${String(generated.segmentation_json)}, ${String(generated.breakpoints_json)},
          ${adminId}, ${now}, ${JSON.stringify(assets)},
          ${`Active native notebook mask from v${item.generatedVersion}`}
        )
      `;

      const nextRevision = baseRevision + 1;
      await tx`
        update annotations
        set revision = ${nextRevision},
            status = 'DRAFT',
            segmentation_json = ${String(generated.segmentation_json)},
            breakpoints_json = ${String(generated.breakpoints_json)},
            last_edited_by = ${adminId},
            updated_at = ${now}
        where dataset_file_id = ${item.fileId}
      `;

      await tx`
        update dataset_files
        set latest_revision = ${nextRevision},
            latest_version_number = ${activatedVersion},
            annotation_state = 'DRAFT',
            image_drive_file_id = ${assets.image},
            prediction_drive_file_id = ${assets.prediction},
            width = ${Number(assets.width)},
            height = ${Number(assets.height)},
            image_filename = ${String(assets.image).split('/').at(-1) || file.image_filename},
            prediction_filename = ${String(assets.prediction).split('/').at(-1) || file.prediction_filename},
            updated_at = ${now}
        where id = ${item.fileId}
      `;

      const operation = generatedSegmentation.maskOperations?.at(-1);
      result.push({
        image: item.image,
        fileId: item.fileId,
        sourceNotebook: generatedSegmentation.sourceNotebook,
        generatedVersion: item.generatedVersion,
        oldActiveSavedAs: currentVersion,
        newActiveVersion: activatedVersion,
        revision: nextRevision,
        polygons: operation?.polygons?.length || 0,
      });
    }
  });

  await writeFile(outPath, JSON.stringify({ result: 'PASS', activatedAt: now, files: result }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', files: result.length, outPath }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}

async function findAdmin() {
  const [admin] = await sql`
    select id from users
    where role = 'ADMIN'
    order by created_at asc
    limit 1
  `;
  if (!admin) throw new Error('No ADMIN user found');
  return String(admin.id);
}
