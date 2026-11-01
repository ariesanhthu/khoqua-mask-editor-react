import { deflateSync } from 'node:zlib';

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

/** Lossless grayscale 16-bit PNG: one numeric instance ID per pixel (0 is background).
 * Explicit network-order samples avoid implicit 8-bit downconversion in image libraries.
 */
export function instanceIdPng(ids: Uint32Array, width: number, height: number): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || ids.length !== width * height) throw Error('Invalid instance mask dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 16; // bit depth
  header[9] = 0; // grayscale, no palette or alpha
  const rows = Buffer.alloc(height * (1 + width * 2));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const id = ids[y * width + x];
    if (id > 65535) throw Error('16-bit instance mask supports at most 65535 instances');
    rows.writeUInt16BE(id, y * (1 + width * 2) + 1 + x * 2);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
