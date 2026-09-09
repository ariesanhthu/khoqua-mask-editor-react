import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const pending = new Map<string, Promise<Buffer>>();
let active = 0;
const waiting: Array<() => void> = [];

// Bound decoding work when a page requests many uncached source images at once.
async function withWorker<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try { return await work(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

export async function getThumbnail(
  reference: string,
  loadSource: () => Promise<Uint8Array>,
  version = '',
  cacheRoot = path.join(process.env.VERCEL ? os.tmpdir() : process.cwd(), 'annotation-storage', 'thumbnails'),
): Promise<Buffer> {
  // Local source changes invalidate both pre-generated and on-demand thumbnails.
  if (path.isAbsolute(reference)) {
    const source = await stat(/* turbopackIgnore: true */ reference);
    version = `${source.size}:${source.mtimeMs}`;
  }
  const key = createHash('sha256').update(`webp-v1:640:72:${reference}:${version}`).digest('hex');
  const target = path.join(cacheRoot, `${key}.webp`);
  const existing = pending.get(target);
  if (existing) return existing;
  const task = (async () => {
    try { return await readFile(/* turbopackIgnore: true */ target); }
    catch { /* Cache miss: generate from the original source. */ }
    return withWorker(async () => {
      const bytes = await sharp(await loadSource())
        .rotate()
        .resize({ width: 640, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72, effort: 4 })
        .toBuffer();
      // Caching is optional on read-only hosts; the preview still works.
      await mkdir(cacheRoot, { recursive: true })
        .then(() => writeFile(/* turbopackIgnore: true */ target, bytes))
        .catch(() => undefined);
      return bytes;
    });
  })();
  pending.set(target, task);
  try { return await task; }
  finally { pending.delete(target); }
}
