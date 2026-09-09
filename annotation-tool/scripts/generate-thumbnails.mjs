import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getThumbnail } from '../src/lib/thumbnails.ts';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(process.argv[2] || path.join(appRoot, '..', 'drive', 'prelabel-dataset', 'images'));
const cacheRoot = path.join(appRoot, 'annotation-storage', 'thumbnails');
const files = (await readdir(source)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
let originalBytes = 0;
let thumbnailBytes = 0;
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < files.length) {
    const reference = path.join(source, files[cursor++]);
    const thumbnail = await getThumbnail(reference, () => readFile(reference), '', cacheRoot);
    originalBytes += (await stat(reference)).size;
    thumbnailBytes += thumbnail.length;
  }
}));
console.log(JSON.stringify({ images: files.length, originalBytes, thumbnailBytes,
  reduction: `${(100 * (1 - thumbnailBytes / originalBytes)).toFixed(1)}%`, cacheRoot }, null, 2));
