import { get } from '@vercel/blob';
import crypto from 'node:crypto';
import path from 'node:path';
import postgres from 'postgres';

const manifestRef = process.argv[2] || 'blob:datasets/bitter-melon-v7-2026-08-20/manifest.json';
const projectName = process.argv[3] || 'Bitter Melon V7 Prelabel';
if (!manifestRef.startsWith('blob:') || !manifestRef.endsWith('/manifest.json') || manifestRef.includes('..')) {
  throw new Error('Manifest ref phải có dạng blob:.../manifest.json.');
}
const connection = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!connection) throw new Error('Thiếu DATABASE_URL.');

const result = await get(manifestRef.slice('blob:'.length), { access: 'private', useCache: false });
if (!result || result.statusCode !== 200 || !result.stream) throw new Error('Không đọc được private Blob manifest.');
const manifest = await new Response(result.stream).json();
if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error('Manifest không có items.');
const baseRef = manifestRef.slice(0, -'manifest.json'.length);
const sql = postgres(connection, { max: 1, prepare: false });
const now = new Date().toISOString();

try {
  await sql.begin(async (tx) => {
    await tx`alter table dataset_files add column if not exists prelabel_storage_ref text`;
    await tx`alter table dataset_files add column if not exists prelabel_filename text`;

    let [project] = await tx`select * from projects where drive_folder_id = ${manifestRef} limit 1`;
    if (!project) {
      project = {
        id: crypto.randomUUID(),
        name: projectName,
        drive_folder_id: manifestRef,
        export_drive_folder_id: process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID || '',
      };
      await tx`insert into projects (id, name, drive_folder_id, export_drive_folder_id, created_at, updated_at)
        values (${project.id}, ${project.name}, ${project.drive_folder_id}, ${project.export_drive_folder_id}, ${now}, ${now})`;
    }

    let [dataset] = await tx`select * from datasets where project_id = ${project.id} order by created_at limit 1`;
    if (!dataset) {
      dataset = { id: crypto.randomUUID() };
      await tx`insert into datasets
        (id, project_id, name, dataset_version, algorithm_version, manifest_drive_file_id, last_drive_sync_at, created_at, updated_at)
        values (${dataset.id}, ${project.id}, ${projectName + ' Dataset'}, ${manifest.dataset_version || null},
          ${manifest.algorithm_version || null}, ${manifestRef}, ${now}, ${now}, ${now})`;
    }

    let added = 0;
    let updated = 0;
    for (const item of manifest.items) {
      if (!item.id || !item.image || !item.prediction || !item.prelabel) throw new Error(`Item ${item.id || '?'} thiếu asset.`);
      for (const relative of [item.image, item.prediction, item.prelabel]) {
        if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`Path không an toàn: ${relative}`);
      }
      const [existing] = await tx`select id from dataset_files where dataset_id = ${dataset.id} and external_key = ${item.id}`;
      const refs = {
        image: `${baseRef}${item.image}`,
        prediction: `${baseRef}${item.prediction}`,
        prelabel: `${baseRef}${item.prelabel}`,
      };
      if (existing) {
        await tx`update dataset_files set image_drive_file_id = ${refs.image}, prediction_drive_file_id = ${refs.prediction},
          prelabel_storage_ref = ${refs.prelabel}, image_filename = ${path.posix.basename(item.image)},
          prediction_filename = ${path.posix.basename(item.prediction)}, prelabel_filename = ${path.posix.basename(item.prelabel)},
          width = ${item.width || null}, height = ${item.height || null}, asset_state = 'READY', updated_at = ${now}
          where id = ${existing.id}`;
        updated += 1;
      } else {
        await tx`insert into dataset_files
          (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, prelabel_storage_ref,
           image_filename, prediction_filename, prelabel_filename, width, height, annotation_state, created_at, updated_at)
          values (${crypto.randomUUID()}, ${dataset.id}, ${item.id}, ${refs.image}, ${refs.prediction}, ${refs.prelabel},
            ${path.posix.basename(item.image)}, ${path.posix.basename(item.prediction)}, ${path.posix.basename(item.prelabel)},
            ${item.width || null}, ${item.height || null}, 'UNSTARTED', ${now}, ${now})`;
        added += 1;
      }
    }
    await tx`update datasets set dataset_version = ${manifest.dataset_version || null}, algorithm_version = ${manifest.algorithm_version || null},
      manifest_drive_file_id = ${manifestRef}, last_drive_sync_at = ${now}, updated_at = ${now} where id = ${dataset.id}`;
    await tx`update projects set updated_at = ${now} where id = ${project.id}`;
    console.log(`PROJECT_ID=${project.id}`);
    console.log(`ADDED=${added}`);
    console.log(`UPDATED=${updated}`);
  });
  console.log('STATUS: DATABASE READY');
} finally {
  await sql.end();
}
