import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ asset: vi.fn(), annotation: null as Record<string, unknown> | null }));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: async () => ({ userId: 'user' }) }));
vi.mock('./db', () => ({
  hashToken: () => '',
  getDb: async () => ({ prepare: (query: string) => ({ get: async () => (
    query.includes('FROM dataset_files')
      ? { id: 'file', project_id: 'project', external_key: 'image', width: 10, height: 8, prelabel_storage_ref: 'blob:prelabel.json' }
      : undefined
  ) }) }),
}));
vi.mock('./annotation-service', () => ({ getAnnotation: async () => mocks.annotation }));
vi.mock('./drive-service', () => ({ fetchDatasetAsset: mocks.asset }));
import { GET } from '../app/api/files/[fileId]/editor/route';

const polygon = { id: 'polygon', label: 'w3', nodes: [
  { id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 10, y: 8 },
] };
const payload = { schemaVersion: 'bitter-melon-prelabel-1.1', coordinateSpace: 'image_pixels',
  width: 10, height: 8, maskOperations: [{ type: 'POLYGON_SET', polygons: [polygon] }] };
const load = () => GET(new Request('https://test/api/files/file/editor'), { params: Promise.resolve({ fileId: 'file' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.annotation = null;
  mocks.asset.mockResolvedValue(new TextEncoder().encode(JSON.stringify(payload)));
});

describe('editor prelabel bootstrap', () => {
  it('returns 200 for an unannotated image with a 1.1 prelabel', async () => {
    const response = await load();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ prelabelOperations: payload.maskOperations, annotation: null, readOnly: true });
  });

  it.each(['{broken', JSON.stringify({ ...payload, schemaVersion: 'unsupported' }), JSON.stringify({ ...payload, width: 11 })])(
    'returns structured 422 for invalid prelabels without supplying an empty editable mask', async (json) => {
      mocks.asset.mockResolvedValue(new TextEncoder().encode(json));
      const response = await load();
      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data).toMatchObject({ code: 'INVALID_ANNOTATION', message: expect.any(String) });
      expect(data).not.toHaveProperty('prelabelOperations');
    },
  );

  it('returns the saved annotation unchanged and does not download its prelabel', async () => {
    mocks.annotation = { revision: 4, segmentation: { humanAction: 'MODIFIED', maskOperations: [] } };
    const response = await load();
    expect(response.status).toBe(200);
    expect((await response.json()).annotation).toEqual(mocks.annotation);
    expect(mocks.asset).not.toHaveBeenCalled();
  });
});
