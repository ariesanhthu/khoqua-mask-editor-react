import { put } from '@vercel/blob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((value, index, all) => {
  if (!value.startsWith('--')) return [value, true];
  const next = all[index + 1];
  return [value, next && !next.startsWith('--') ? next : true];
}));
const datasetDir = path.resolve(String(args.get('--dataset') || path.join(import.meta.dirname, '../../drive/prelabel-production')));
const prefix = String(args.get('--prefix') || 'datasets/bitter-melon-v7-2026-08-20').replace(/^\/+|\/+$/g, '');
const dryRun = args.has('--dry-run');
const manifest = JSON.parse(await readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));

if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error('manifest.json không có items.');
const relativeFiles = new Set();
for (const item of manifest.items) {
  for (const field of ['image', 'prediction', 'prelabel']) {
    const relative = item[field];
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`${item.id}.${field} không phải relative path an toàn.`);
    }
    relativeFiles.add(relative);
  }
}

const files = [...relativeFiles].sort();
for (const relative of files) await readFile(path.join(datasetDir, ...relative.split('/')));
console.log(`Dataset: ${datasetDir}`);
console.log(`Assets : ${files.length} (${manifest.items.length} images × 3)`);
console.log(`Prefix : ${prefix}`);
if (dryRun) {
  console.log('STATUS: DRY RUN READY');
  process.exit(0);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error('Thiếu BLOB_READ_WRITE_TOKEN. Link Vercel project rồi chạy `vercel env pull .env.local`.');
}

function contentType(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function upload(relative) {
  const pathname = `${prefix}/${relative}`;
  const blob = await put(pathname, await readFile(path.join(datasetDir, ...relative.split('/'))), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType(relative),
  });
  console.log(`UPLOADED ${relative}`);
  return blob;
}

const concurrency = 4;
for (let index = 0; index < files.length; index += concurrency) {
  await Promise.all(files.slice(index, index + concurrency).map(upload));
}
const manifestBlob = await upload('manifest.json');
console.log(`BLOB_MANIFEST_REF=blob:${manifestBlob.pathname}`);
console.log('STATUS: UPLOAD COMPLETE');
