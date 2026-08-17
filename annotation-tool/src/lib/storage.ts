import 'server-only';

import { get, put } from '@vercel/blob';
import crypto from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { getDb } from './db';

const storageRoot = path.resolve(
  /* turbopackIgnore: true */
  process.env.ANNOTATION_STORAGE_PATH || path.join(process.cwd(), 'annotation-storage'),
);

function usesVercelBlob(): boolean {
  return Boolean(process.env.VERCEL || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
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

  const db = await getDb();
  const row = await db.prepare<{ dataset_id: string; width: number | null; height: number | null }>(
    'SELECT dataset_id, width, height FROM dataset_files WHERE id = ?',
  ).get(fileId);
  if (!row) throw new Error('File not found');

  const image = sharp(bytes, { failOn: 'error' });
  const metadata = await image.metadata();
  const pngWidth = metadata.width || 0;
  const pngHeight = metadata.height || 0;
  if (pngWidth <= 0 || pngHeight <= 0 ||
      (row.width && pngWidth !== row.width) || (row.height && pngHeight !== row.height)) {
    throw new Error(`Mask dimensions ${pngWidth}×${pngHeight} do not match the source image.`);
  }

  const normalized = await image
    .flatten({ background: '#000000' })
    .greyscale()
    .threshold(127)
    .removeAlpha()
    .png()
    .toBuffer();
  const storageKey = `masks/${row.dataset_id}/${fileId}/revisions/${Date.now()}-${crypto.randomUUID()}.png`;

  if (usesVercelBlob()) {
    if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
      throw new Error('A Vercel Blob store is not connected to this project.');
    }
    await put(storageKey, normalized, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'image/png',
    });
  } else {
    const target = safeStoragePath(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(/* turbopackIgnore: true */ target, normalized, { flag: 'wx' });
  }
  return storageKey;
}

export async function readStoredMask(storageKey: string): Promise<Buffer> {
  if (!usesVercelBlob()) return readFile(/* turbopackIgnore: true */ safeStoragePath(storageKey));
  const result = await get(storageKey, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error('Stored mask not found');
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}
