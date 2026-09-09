import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { getThumbnail } from './thumbnails';

const directories: string[] = [];
async function cacheDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'annotation-thumbnail-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('dashboard thumbnails', () => {
  it('compresses and preserves the whole portrait image without upscaling', async () => {
    const source = await sharp({ create: { width: 1200, height: 2400, channels: 3, background: '#75a744' } }).png().toBuffer();
    const bytes = await getThumbnail('portrait', async () => source, '', await cacheDirectory());
    const image = await sharp(bytes).metadata();
    expect(image.format).toBe('webp');
    expect([image.width, image.height]).toEqual([200, 400]);
    expect(bytes.length).toBeLessThan(source.length);
  });

  it('shares concurrent conversion and reuses disk cache without downloading the original', async () => {
    const source = await sharp({ create: { width: 80, height: 50, channels: 3, background: '#75a744' } }).png().toBuffer();
    const load = vi.fn(async () => source);
    const directory = await cacheDirectory();
    const [first, second] = await Promise.all([
      getThumbnail('shared', load, 'v1', directory), getThumbnail('shared', load, 'v1', directory),
    ]);
    expect(first.equals(second)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    await getThumbnail('shared', load, 'v1', directory);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await sharp(first).metadata()).width).toBe(80);
    await getThumbnail('shared', load, 'v2', directory);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('allows a retry after an unavailable original', async () => {
    const directory = await cacheDirectory();
    await expect(getThumbnail('retry', async () => { throw new Error('offline'); }, '', directory)).rejects.toThrow('offline');
    const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await getThumbnail('retry', async () => source, '', directory)).length).toBeGreaterThan(0);
  });
});
