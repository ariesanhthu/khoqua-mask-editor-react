import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getDb } from './db';
import { DatasetImportError, importDatasetItem } from './dataset-import-service';
import { acquireLock } from './lock-service';
import { rasterizePolygons } from './mask-pixels';
import { loadPrelabelOperations } from './prelabel-service';

let storageRoot = '';

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#4a7' } }).png().toBuffer();
const square = (id: string, label: string, left: number, top: number, size: number) => ({
  id, label, nodes: [[left, top], [left + size, top], [left + size, top + size], [left, top + size]].map(([x, y], i) => ({ id: `${id}-${i}`, x, y })),
});
const prelabel = (imageId: string, width: number, height: number, polygons: unknown[]) => Buffer.from(JSON.stringify({
  schemaVersion: 'bitter-melon-prelabel-1.1', imageId, coordinateSpace: 'image_pixels', width, height,
  maskOperations: [{ type: 'POLYGON_SET', polygons }],
}));
const fileRow = async (key: string) => (await getDb()).prepare(`SELECT df.*, g.name AS group_name FROM dataset_files df
  LEFT JOIN file_groups g ON g.id = df.group_id WHERE df.external_key = ?`).get(key);

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD',
    'STORAGE_BACKEND', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'dataset-import-'));
  vi.stubEnv('ANNOTATION_STORAGE_PATH', storageRoot);
  const db = await getDb();
  await db.prepare("INSERT INTO users (id, display_name, hashed_password, role) VALUES ('editor', 'Editor', 'x', 'ANNOTATOR')").run();
  for (const id of ['upload', 'parallel']) await db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, id);
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('importing one uploaded image', () => {
  it('stores a COCO item with a prediction rendered pixel-exactly from its polygons', async () => {
    const polygons = [square('a', 'r1', 1, 1, 4), square('b', 'w1', 6, 2, 2)];
    const result = await importDatasetItem('upload', {
      externalKey: '8582_01', groupName: ' 8582 ', image: await png(10, 8),
      prelabel: gzipSync(prelabel('8582_01', 10, 8, polygons)),
    });
    expect(result).toMatchObject({ externalKey: '8582_01', groupName: '8582', created: true });
    const row = await fileRow('8582_01');
    expect(row).toMatchObject({ group_name: '8582', width: 10, height: 8, annotation_state: 'UNSTARTED', asset_state: 'READY',
      image_filename: '8582_01.png', prediction_filename: '8582_01.png', prelabel_filename: '8582_01.json' });
    for (const reference of [row!.image_drive_file_id, row!.prediction_drive_file_id, row!.prelabel_storage_ref]) {
      expect(String(reference).startsWith(storageRoot)).toBe(true);
    }
    const { data, info } = await sharp(await readFile(String(row!.prediction_drive_file_id))).greyscale().raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([10, 8, 1]);
    expect(new Uint8Array(data)).toEqual(rasterizePolygons(polygons, 10, 8));
    // Editor đọc lại prelabel qua đúng hàm sẵn có, không cần sửa editor.
    expect(await loadPrelabelOperations(String(row!.prelabel_storage_ref), 10, 8)).toEqual([{ type: 'POLYGON_SET', polygons }]);
  });

  it('keeps the bytes of a default-format prediction and an empty mask when there is nothing to render', async () => {
    const prediction = await png(6, 4);
    await importDatasetItem('upload', { externalKey: 'DC3_01', groupName: 'DC3', image: await png(6, 4), prediction });
    expect(await readFile(String((await fileRow('DC3_01'))!.prediction_drive_file_id))).toEqual(prediction);
    await importDatasetItem('upload', { externalKey: 'blank', groupName: 'DC3', image: await png(3, 2) });
    const blank = await sharp(await readFile(String((await fileRow('blank'))!.prediction_drive_file_id))).greyscale().raw().toBuffer();
    expect([...blank]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('rejects inputs that would misalign labels instead of importing them', async () => {
    const image = await png(6, 4);
    const attempt = (overrides: Record<string, unknown>) => importDatasetItem('upload', { externalKey: 'bad', groupName: 'g', image, ...overrides });
    await expect(attempt({ prediction: await png(5, 4) })).rejects.toThrow(/không khớp/);
    await expect(attempt({ prediction: Buffer.from('not a png') })).rejects.toThrow(/PNG/);
    await expect(attempt({ prelabel: prelabel('bad', 7, 4, []) })).rejects.toThrow(/Kích thước/);
    await expect(attempt({ prelabel: prelabel('bad', 6, 4, [square('x', 'ridge', 0, 0, 2)]) })).rejects.toThrow(/Polygon prelabel/);
    await expect(attempt({ prelabel: Buffer.from('{oops') })).rejects.toThrow(/JSON/);
    await expect(attempt({ image: Buffer.from('nope') })).rejects.toThrow(/ảnh/);
    const rotated = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#fff' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    await expect(attempt({ image: rotated })).rejects.toThrow(/EXIF/);
    await expect(attempt({ externalKey: 'a/b' })).rejects.toThrow(/Tên ảnh/);
    await expect(attempt({ groupName: '  ' })).rejects.toThrow(/Tên nhóm/);
    await expect(importDatasetItem('missing', { externalKey: 'x', groupName: 'g', image })).rejects.toMatchObject({ status: 404 });
    expect(await fileRow('bad')).toBeUndefined();
  });

  it('updates the source of an existing image without touching its saved annotation', async () => {
    const db = await getDb();
    const before = await fileRow('8582_01');
    await db.prepare(`INSERT INTO annotations (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by)
      VALUES (?, 3, 'DRAFT', '{"humanAction":"MODIFIED"}', '{}', 'editor')`).run(before!.id);
    await db.prepare("UPDATE dataset_files SET annotation_state = 'DRAFT' WHERE id = ?").run(before!.id);
    const result = await importDatasetItem('upload', { externalKey: '8582_01', groupName: 'Giống 8582', image: await png(10, 8) });
    expect(result).toMatchObject({ fileId: before!.id, created: false, groupName: 'Giống 8582' });
    const after = await fileRow('8582_01');
    expect(after).toMatchObject({ id: before!.id, annotation_state: 'DRAFT', group_name: 'Giống 8582', prelabel_storage_ref: null });
    expect(after!.image_drive_file_id).not.toBe(before!.image_drive_file_id);
    expect(await db.prepare('SELECT revision FROM annotations WHERE dataset_file_id = ?').get(before!.id)).toEqual({ revision: 3 });

    const resized = importDatasetItem('upload', { externalKey: '8582_01', groupName: '8582', image: await png(12, 8) });
    await expect(resized).rejects.toBeInstanceOf(DatasetImportError);
    await expect(resized).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to replace an image while someone holds its edit lock', async () => {
    const row = await fileRow('DC3_01');
    const lock = await acquireLock(String(row!.id), 'editor');
    expect(lock).toMatchObject({ denied: false });
    await expect(importDatasetItem('upload', { externalKey: 'DC3_01', groupName: 'DC3', image: await png(6, 4) }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Editor/) });
  });

  it('creates a single dataset and group when the first images of a project arrive in parallel', async () => {
    const image = await png(4, 4);
    await Promise.all(['a', 'b', 'c', 'd'].map((key) => importDatasetItem('parallel', { externalKey: key, groupName: 'VIN005', image })));
    const db = await getDb();
    expect(await db.prepare("SELECT COUNT(*) AS total FROM datasets WHERE project_id = 'parallel'").get()).toMatchObject({ total: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS total FROM file_groups WHERE project_id = 'parallel'").get()).toMatchObject({ total: 1 });
  });
});
