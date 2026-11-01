// Local reconstruction from a verified backup; never updates server annotations.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { rasterizePolygons, vectorizeBinaryMask } from '../src/lib/mask-pixels.ts';

const [backupRoot, outputRoot] = process.argv.slice(2);
const report = JSON.parse(await readFile(path.join(backupRoot, 'backup-report.json'), 'utf8'));
if (!report.complete) throw Error('Complete backup required');
const database = JSON.parse(await readFile(path.join(backupRoot, 'database.json'), 'utf8'));
await mkdir(outputRoot, { recursive: false });
for (const directory of ['images', 'predictions', 'prelabels']) await mkdir(path.join(outputRoot, directory));
const items = [];
const audit = [];
for (const file of database.dataset_files) {
  const local = (reference) => {
    if (!reference.startsWith('blob:') || reference.split('/').includes('..')) throw Error('Expected a backed-up Blob asset');
    return path.join(backupRoot, 'blobs', reference.slice(5));
  };
  const { data, info } = await sharp(local(file.prediction_drive_file_id)).flatten({ background: '#000000' }).greyscale().threshold(127).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== file.width || info.height !== file.height) throw Error('Dimensions mismatch');
  const polygons = vectorizeBinaryMask(data, info.width, info.height, file.external_key);
  const reconstructed = rasterizePolygons(polygons, info.width, info.height);
  if (!Buffer.from(reconstructed).equals(data)) throw Error('Lossy polygon conversion');
  const prelabel = { schemaVersion: 'bitter-melon-prelabel-1.1', imageId: file.external_key, coordinateSpace: 'image_pixels', width: info.width, height: info.height, maskOperations: [{ type: 'POLYGON_SET', polygons }] };
  const stem = file.external_key.replace(/[^a-zA-Z0-9._-]/g, '_');
  const image = `images/${stem}${path.extname(file.image_filename)}`;
  const prediction = `predictions/${stem}.png`;
  const label = `prelabels/${stem}.json`;
  await copyFile(local(file.image_drive_file_id), path.join(outputRoot, image));
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toFile(path.join(outputRoot, prediction));
  await writeFile(path.join(outputRoot, label), JSON.stringify(prelabel));
  items.push({ id: file.external_key, image, prediction, prelabel: label, width: info.width, height: info.height });
  audit.push({ image: file.external_key, polygons: polygons.length, differentPixels: 0 });
}
await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify({ dataset_version: 'pixel-exact-20260914', algorithm_version: 'connected-components-4', items }, null, 2));
await writeFile(path.join(outputRoot, 'audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify(audit));
