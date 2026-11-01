import 'server-only';

import crypto from 'crypto';
import sharp from 'sharp';
import { getDb } from './db';
import { getObject, putObject } from './object-store';

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

  await putObject(storageKey, normalized, 'image/png');
  return storageKey;
}

export async function readStoredMask(storageKey: string): Promise<Buffer> {
  const bytes = await getObject(storageKey);
  if (!bytes) throw new Error('Stored mask not found');
  return bytes;
}
