import 'server-only';

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { getDb } from './db';

const storageRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.ANNOTATION_STORAGE_PATH || path.join(process.cwd(), 'annotation-storage'),
);

export function annotationStorageRoot(): string {
  return storageRoot;
}

function safeStoragePath(storageKey: string): string {
  const resolved = path.resolve(storageRoot, storageKey);
  if (resolved !== storageRoot && !resolved.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error('Invalid storage key');
  }
  return resolved;
}

export async function persistMask(fileId: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) {
    throw new Error('Mask must be between 1 byte and 50 MB');
  }
  const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!pngHeader.every((value, index) => bytes[index] === value)) {
    throw new Error('Mask must be a PNG image');
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT df.dataset_id, df.width, df.height FROM dataset_files df WHERE df.id = ?
  `).get(fileId) as { dataset_id: string; width: number | null; height: number | null } | undefined;
  if (!row) throw new Error('File not found');
  const image = sharp(bytes, { failOn: 'error' });
  const metadata = await image.metadata();
  const pngWidth = metadata.width || 0;
  const pngHeight = metadata.height || 0;
  if (pngWidth <= 0 || pngHeight <= 0 ||
      (row.width && pngWidth !== row.width) || (row.height && pngHeight !== row.height)) {
    throw new Error(`Mask dimensions ${pngWidth}×${pngHeight} do not match the source image.`);
  }

  const relativeKey = path.join(
    row.dataset_id,
    fileId,
    'revisions',
    `${Date.now()}-${crypto.randomUUID()}.png`,
  );
  const target = safeStoragePath(relativeKey);
  await mkdir(path.dirname(target), { recursive: true });
  const normalizedBinaryMask = await image
    .flatten({ background: '#000000' })
    .greyscale()
    .threshold(127)
    .removeAlpha()
    .png()
    .toBuffer();
  await writeFile(/* turbopackIgnore: true */ target, normalizedBinaryMask, { flag: 'wx' });
  return relativeKey.replaceAll(path.sep, '/');
}

export async function readStoredMask(storageKey: string): Promise<Buffer> {
  return readFile(/* turbopackIgnore: true */ safeStoragePath(storageKey));
}
