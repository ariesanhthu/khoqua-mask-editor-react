import postgres from 'postgres';
import { put } from '@vercel/blob';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { rasterizePolygons } from '../src/lib/mask-pixels.ts';

const [backupDir, datasetDir, originalBackupDir, mode] = process.argv.slice(2);
const hash = b => createHash('sha256').update(b).digest('hex');
const bytes = await readFile(path.join(backupDir, 'database.json'));
const backupReport = JSON.parse(await readFile(path.join(backupDir, 'backup-report.json'), 'utf8'));
if (!backupReport.complete || backupReport.databaseSha256 !== hash(bytes)) throw Error('Complete verified backup required');
const backup = JSON.parse(bytes);
const original = JSON.parse(await readFile(path.join(originalBackupDir, 'database.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
if (manifest.items.length !== backup.dataset_files.length) throw Error('Incomplete native Drive rerun');
const prefix = `datasets/${manifest.dataset_version}`;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const [admin] = await sql`select id from users where role='ADMIN' order by created_at limit 1`;
  const prepared = [];
  for (const item of manifest.items) {
    if (item.preprocessing !== 'native_drive_pixels_no_crop_no_resize' || item.imageSha256 !== item.sourceSha256) throw Error('Native Drive input required');
    const file = backup.dataset_files.find(f => f.external_key === item.id);
    const candidates = backup.annotation_versions.filter(v => v.dataset_file_id === file.id).sort((a,b) => b.version_number-a.version_number);
    let target;
    for (const version of candidates) {
      if (!version.asset_snapshot_json) continue;
      const assets = JSON.parse(version.asset_snapshot_json);
      if (assets.width !== item.width || assets.height !== item.height) continue;
      const image = await readFile(path.join(backupDir, 'blobs', assets.image.replace(/^blob:/, '')));
      if (hash(image) === item.sourceSha256) { target = { version, assets }; break; }
    }
    if (!target) throw Error(`No exact native Drive history for ${item.id}`);
    const prediction = await readFile(path.join(datasetDir, item.prediction));
    const prelabelBytes = await readFile(path.join(datasetDir, item.prelabel));
    const payload = JSON.parse(prelabelBytes);
    const mask = await sharp(prediction).greyscale().removeAlpha().raw().toBuffer();
    if (hash(prediction) !== item.maskSha256 || !Buffer.from(rasterizePolygons(payload.maskOperations[0].polygons,item.width,item.height)).equals(mask)) throw Error('Raster/contour mismatch');
    const initialFile = original.dataset_files.find(f=>f.external_key===item.id);
    prepared.push({ item, file, target, initialFile, payload, prediction, prelabelBytes });
  }
  const check = async (tx, lock = false) => {
    for (const { file } of prepared) {
      const [current] = lock ? await tx`select * from dataset_files where id=${file.id} for update` : await tx`select * from dataset_files where id=${file.id}`;
      if (current.latest_revision!==file.latest_revision || current.latest_version_number!==file.latest_version_number) throw Error(`Concurrent change: ${file.external_key}`);
      const locks = await tx`select * from file_locks where dataset_file_id=${file.id} and expires_at>${new Date().toISOString()}`;
      if (locks.length) throw Error(`Active editor: ${file.external_key}`);
    }
  };
  await check(sql);
  console.log(JSON.stringify(prepared.map(({item,target})=>({image:item.id,nativeSize:[item.width,item.height],restoreVersion:target.version.version_number,restoredPolygons:JSON.parse(target.version.segmentation_json).maskOperations?.at(-1)?.polygons?.length,newPolygons:item.polygonCount}))));
  if (mode !== '--apply') { console.log('DRY RUN PASS'); }
  else {
    for (const p of prepared) {
      await put(`${prefix}/${p.item.prediction}`,p.prediction,{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'image/png'});
      await put(`${prefix}/${p.item.prelabel}`,p.prelabelBytes,{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});
    }
    await put(`${prefix}/manifest.json`,JSON.stringify(manifest),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});
    const report = await sql.begin(async tx => {
      await check(tx,true);
      const result=[]; const now=new Date().toISOString();
      for (const {file,item,target,initialFile,payload} of prepared) {
        const [current]=await tx`select * from annotations where dataset_file_id=${file.id}`;
        const oldAssets=JSON.stringify({image:file.image_drive_file_id,prediction:file.prediction_drive_file_id,width:file.width,height:file.height});
        const nativeAssets=JSON.stringify({...target.assets,prediction:`blob:${prefix}/${item.prediction}`});
        const generated=JSON.stringify({humanAction:'MODIFIED',maskOperations:payload.maskOperations,maskStorageKey:`${prefix}/${item.prediction}`,sourcePredictionDriveFileId:`blob:${prefix}/${item.prediction}`,sourceNotebook:item.notebook,sourceImageSha256:item.sourceSha256,preprocessing:item.preprocessing});
        const base=Number(file.latest_version_number); const revision=Number(file.latest_revision)+1;
        const entries=[
          {number:base+1,label:'Bảo toàn bản trước khi khôi phục ảnh Drive',seg:current.segmentation_json,bp:current.breakpoints_json,assets:oldAssets},
          {number:base+2,label:`Notebook ${item.notebook} chạy lại trên ảnh Drive gốc`,seg:generated,bp:JSON.stringify({state:'NOT_ANNOTATED',points:[]}),assets:nativeAssets},
          {number:base+3,label:`Polygon đã chỉnh trên ảnh Drive · từ v${target.version.version_number}`,seg:target.version.segmentation_json,bp:target.version.breakpoints_json,assets:target.version.asset_snapshot_json},
        ];
        for (const e of entries) await tx`insert into annotation_versions(id,dataset_file_id,version_number,base_revision,segmentation_json,breakpoints_json,created_by,created_at,asset_snapshot_json,version_label)
          values(${randomUUID()},${file.id},${e.number},${file.latest_revision},${e.seg},${e.bp},${admin.id},${now},${e.assets},${e.label})`;
        // Restore raw human geometry; the new detector is a separate, reviewable version.
        await tx`update annotations set revision=${revision},status='DRAFT',segmentation_json=${target.version.segmentation_json},breakpoints_json=${target.version.breakpoints_json},last_edited_by=${admin.id},updated_at=${now} where dataset_file_id=${file.id}`;
        await tx`update dataset_files set latest_revision=${revision},latest_version_number=${base+3},annotation_state='DRAFT',
          image_drive_file_id=${target.assets.image},prediction_drive_file_id=${target.assets.prediction},width=${item.width},height=${item.height},
          image_filename=${initialFile.image_filename},prediction_filename=${initialFile.prediction_filename},prelabel_storage_ref=${initialFile.prelabel_storage_ref},prelabel_filename=${initialFile.prelabel_filename},updated_at=${now} where id=${file.id}`;
        result.push({image:item.id,fileId:file.id,revision,restoredFrom:target.version.version_number,preservedVersion:base+1,generatedVersion:base+2,activeVersion:base+3,sourceSha256:item.sourceSha256});
      }
      for (const d of original.datasets) await tx`update datasets set manifest_drive_file_id=${d.manifest_drive_file_id},dataset_version=${d.dataset_version},algorithm_version=${d.algorithm_version},updated_at=${now} where id=${d.id}`;
      for (const p of original.projects) await tx`update projects set drive_folder_id=${p.drive_folder_id},updated_at=${now} where id=${p.id}`;
      return result;
    });
    await writeFile(path.join(backupDir,'drive-import-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }
} finally { await sql.end(); }
