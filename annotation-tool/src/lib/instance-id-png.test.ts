import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { instanceIdPng } from './instance-id-png';

describe('16-bit instance ID PNG', () => {
  it('decodes IDs across the 8-bit boundary without scaling or truncation', async () => {
    const values = [0, 1, 255, 256, 556, 65535];
    const png = instanceIdPng(Uint32Array.from(values), 3, 2);
    expect(await sharp(png).metadata()).toMatchObject({ width: 3, height: 2, depth: 'ushort' });
    const { data, info } = await sharp(png).pipelineColourspace('grey16').toColourspace('grey16')
      .raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(1);
    expect([...new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)]).toEqual(values);
  });
  it('fails explicitly instead of truncating unsupported IDs', () => {
    expect(() => instanceIdPng(Uint32Array.of(65536), 1, 1)).toThrow('65535');
  });
});
