import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: vi.fn() }));
import { requireAuth } from './auth';
import { getDb } from './db';
import { acquireLock } from './lock-service';
import { readAnnotationBody, readJsonBody } from './request-body';
import { POST as uploadChunk } from '../app/api/files/[fileId]/upload-chunks/route';

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  await db.prepare("INSERT INTO users (id, display_name, hashed_password, role) VALUES ('owner', 'Owner', 'test', 'ANNOTATOR'), ('other', 'Other', 'test', 'ANNOTATOR')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p', 'test')").run();
  await db.prepare("INSERT INTO datasets (id, project_id, name) VALUES ('d', 'p', 'test')").run();
  await db.prepare(`INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, image_filename, prediction_filename, width, height)
    VALUES ('f', 'd', 'f', 'image', 'mask', 'image.png', 'mask.png', 8, 6)`).run();
}, 30000);

const payload = { baseRevision: 3, segmentation: { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: [] }] } };

describe('readJsonBody', () => {
  it('reads plain JSON bodies unchanged', async () => {
    const request = new Request('https://test', { method: 'PATCH', body: JSON.stringify(payload) });
    expect(await readJsonBody(request)).toEqual(payload);
  });

  it('gunzips bodies the client compressed to stay under the platform size limit', async () => {
    const request = new Request('https://test', {
      method: 'PATCH', body: gzipSync(JSON.stringify(payload)), headers: { 'X-Body-Encoding': 'gzip' },
    });
    expect(await readJsonBody(request)).toEqual(payload);
  });

  it('refuses a compressed body that expands beyond the cap', async () => {
    const bomb = gzipSync(JSON.stringify({ padding: 'x'.repeat(200_000) }));
    const request = new Request('https://test', { method: 'PATCH', body: bomb, headers: { 'X-Body-Encoding': 'gzip' } });
    await expect(readJsonBody(request, 50_000)).rejects.toThrow();
  });
});

describe('chunked save bodies', () => {
  it('assembles parts only for the uploading user and file, once, and requires the edit lock per part', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'owner', displayName: 'Owner', role: 'ANNOTATOR' });
    const lock = await acquireLock('f', 'owner');
    if (!lock || lock.denied) throw Error('Lock required');
    const gz = gzipSync(JSON.stringify(payload));
    const middle = Math.floor(gz.length / 2);
    const uploadId = crypto.randomUUID();
    const context = { params: Promise.resolve({ fileId: 'f' }) };
    const part = (index: number, bytes: Uint8Array, token = lock.lockToken) => uploadChunk(new Request(
      `https://test/api/files/f/upload-chunks?uploadId=${uploadId}&index=${index}`,
      { method: 'POST', body: new Uint8Array(bytes), headers: { 'X-Annotation-Lock-Token': token } },
    ), context);

    expect((await part(0, gz.subarray(0, middle), 'wrong-token')).status).toBe(409);
    expect((await part(0, gz.subarray(0, middle))).status).toBe(200);
    expect((await part(1, gz.subarray(middle))).status).toBe(200);

    const save = () => new Request('https://test/api/files/f/annotation', {
      method: 'PATCH', headers: { 'X-Body-Encoding': 'gzip', 'X-Body-Upload': uploadId, 'X-Body-Chunks': '2' },
    });
    await expect(readAnnotationBody(save(), 'f', 'other')).rejects.toThrow();
    await expect(readAnnotationBody(new Request('https://test', {
      method: 'PATCH', headers: { 'X-Body-Upload': uploadId, 'X-Body-Chunks': '3' },
    }), 'f', 'owner')).rejects.toThrow();
    expect(await readAnnotationBody(save(), 'f', 'owner')).toEqual(payload);
    await expect(readAnnotationBody(save(), 'f', 'owner')).rejects.toThrow();
  });
});
