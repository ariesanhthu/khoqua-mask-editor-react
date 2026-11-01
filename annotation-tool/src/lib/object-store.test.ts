import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@vercel/blob', () => blob);

import { datasetObjectReference, getDatasetObject, getObject, putObject, readR2Config, resolveBackend } from './object-store';

const R2_ENV = {
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
  R2_BUCKET: 'annotations',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secret-example',
};
const MANAGED = [
  'STORAGE_BACKEND', 'VERCEL', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'ANNOTATION_STORAGE_PATH',
  ...Object.keys(R2_ENV),
];

function useEnv(values: Record<string, string>) {
  for (const name of MANAGED) delete process.env[name];
  Object.assign(process.env, values);
}

beforeEach(() => {
  blob.get.mockReset();
  blob.put.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of MANAGED) delete process.env[name];
});

describe('resolveBackend', () => {
  it('keeps the historical choice when STORAGE_BACKEND is unset', () => {
    expect(resolveBackend({})).toBe('filesystem');
    expect(resolveBackend({ VERCEL: '1' })).toBe('blob');
    expect(resolveBackend({ BLOB_READ_WRITE_TOKEN: 'x' })).toBe('blob');
    expect(resolveBackend({ BLOB_STORE_ID: 'store_x' })).toBe('blob');
  });

  it('does not switch to R2 just because R2 variables exist', () => {
    expect(resolveBackend({ VERCEL: '1', ...R2_ENV })).toBe('blob');
  });

  it('selects R2 only when requested and fully configured', () => {
    expect(resolveBackend({ STORAGE_BACKEND: 'r2', ...R2_ENV })).toBe('r2');
    expect(() => resolveBackend({ STORAGE_BACKEND: 'r2', R2_ENDPOINT: R2_ENV.R2_ENDPOINT })).toThrow(/R2_BUCKET/);
  });

  it('rejects unknown backends and allows explicit blob/filesystem', () => {
    expect(() => resolveBackend({ STORAGE_BACKEND: 'ftp' })).toThrow(/Unknown STORAGE_BACKEND/);
    expect(resolveBackend({ STORAGE_BACKEND: 'blob' })).toBe('blob');
    expect(resolveBackend({ STORAGE_BACKEND: 'filesystem', VERCEL: '1' })).toBe('filesystem');
  });

  it('normalises the R2 endpoint', () => {
    expect(readR2Config(R2_ENV)?.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
  });
});

describe('R2 backend', () => {
  it('uploads with a signed path-style PUT', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', ...R2_ENV });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await putObject('masks/ds 1/file/revisions/a.png', new Uint8Array([1, 2, 3]), 'image/png');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = (fetchMock.mock.calls[0] as unknown as [Request])[0];
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://acct.r2.cloudflarestorage.com/annotations/masks/ds%201/file/revisions/a.png');
    expect(request.headers.get('content-type')).toBe('image/png');
    expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(blob.put).not.toHaveBeenCalled();
  });

  it('fails loudly when R2 rejects the upload', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', ...R2_ENV });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    await expect(putObject('masks/a.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(/R2 upload failed \(403\)/);
  });

  it('downloads an existing object', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', ...R2_ENV });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 })));
    expect(Array.from((await getObject('masks/a.png'))!)).toEqual([9, 8, 7]);
    expect(blob.get).not.toHaveBeenCalled();
  });

  it('returns null for a missing object when no Blob store is configured', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', ...R2_ENV });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect(await getObject('masks/missing.png')).toBeNull();
    expect(await getDatasetObject('datasets/missing.png')).toBeNull();
  });

  it('falls back to Vercel Blob for objects not copied to R2 yet', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y', ...R2_ENV });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    blob.get.mockResolvedValue({ statusCode: 200, stream: new Response(new Uint8Array([5, 6])).body });

    expect(Array.from((await getObject('masks/old.png'))!)).toEqual([5, 6]);
    expect(blob.get).toHaveBeenCalledWith('masks/old.png', { access: 'private', useCache: false });

    blob.get.mockResolvedValue({ statusCode: 200, stream: new Response(new Uint8Array([4])).body });
    expect(Array.from((await getDatasetObject('datasets/manifest.json'))!)).toEqual([4]);
  });

  it('does not hide R2 errors behind the Blob fallback', async () => {
    useEnv({ STORAGE_BACKEND: 'r2', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y', ...R2_ENV });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(getObject('masks/a.png')).rejects.toThrow(/R2 download failed \(403\)/);
    expect(blob.get).not.toHaveBeenCalled();
  });
});

describe('Vercel Blob backend (unchanged behaviour)', () => {
  it('writes private, non-overwriting objects', async () => {
    useEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y' });
    blob.put.mockResolvedValue({});
    await putObject('masks/a.png', new Uint8Array([1]), 'image/png');
    expect(blob.put).toHaveBeenCalledWith('masks/a.png', expect.any(Buffer), {
      access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'image/png',
    });
  });

  it('reports a missing Blob object as null and requires a connected store to write', async () => {
    useEnv({ STORAGE_BACKEND: 'blob' });
    await expect(putObject('masks/a.png', new Uint8Array([1]), 'image/png')).rejects.toThrow(/not connected/);
    useEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y' });
    blob.get.mockResolvedValue(null);
    expect(await getObject('masks/none.png')).toBeNull();
  });
});

describe('filesystem backend', () => {
  it('round-trips, refuses overwrite and returns null when missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'object-store-'));
    try {
      useEnv({ ANNOTATION_STORAGE_PATH: dir });
      await putObject('masks/ds/f/a.png', new Uint8Array([1, 2]), 'image/png');
      expect(Array.from((await getObject('masks/ds/f/a.png'))!)).toEqual([1, 2]);
      await expect(putObject('masks/ds/f/a.png', new Uint8Array([3]), 'image/png')).rejects.toThrow();
      expect(await getObject('masks/ds/f/none.png')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('dataset references for uploaded datasets', () => {
  it('uses blob: references on Blob/R2 and the absolute stored path on the filesystem', () => {
    useEnv({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x_y' });
    expect(datasetObjectReference('datasets/uploads/p/a/image.jpg')).toBe('blob:datasets/uploads/p/a/image.jpg');
    useEnv({ STORAGE_BACKEND: 'r2', ...R2_ENV });
    expect(datasetObjectReference('datasets/uploads/p/a/image.jpg')).toBe('blob:datasets/uploads/p/a/image.jpg');
    const root = path.join(os.tmpdir(), 'uploads-root');
    useEnv({ ANNOTATION_STORAGE_PATH: root });
    expect(datasetObjectReference('datasets/uploads/p/a/image.jpg')).toBe(path.join(root, 'datasets', 'uploads', 'p', 'a', 'image.jpg'));
    expect(() => datasetObjectReference('datasets/../../x')).toThrow(/Invalid storage key/);
  });
});

describe('key validation', () => {
  it('rejects traversal and empty segments on every backend', async () => {
    useEnv({ ANNOTATION_STORAGE_PATH: os.tmpdir() });
    for (const key of ['../x.png', 'masks/../../x.png', 'masks//x.png', '', '/']) {
      await expect(getObject(key)).rejects.toThrow(/Invalid storage key/);
      await expect(putObject(key, new Uint8Array([1]), 'image/png')).rejects.toThrow(/Invalid storage key/);
    }
  });
});
