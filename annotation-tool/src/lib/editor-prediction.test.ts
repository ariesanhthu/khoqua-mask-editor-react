import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ file: {} as Record<string, unknown>, prediction: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: async () => ({ userId: 'user', role: 'ANNOTATOR' }) }));
vi.mock('./db', () => ({ getDb: async () => ({ prepare: () => ({ get: async () => mocks.file }) }), hashToken: () => '' }));
vi.mock('./prelabel-service', () => ({ loadPrelabelOperations: mocks.prediction }));
import { GET } from '../app/api/files/[fileId]/editor/route';

beforeEach(() => {
  vi.clearAllMocks();
  // can_access: cột quyền theo nhóm mà truy vấn bootstrap trả về (xem access-service).
  mocks.file = { id: 'file', project_id: 'project', external_key: 'image', width: 1200, height: 400,
    prediction_drive_file_id: 'prediction', prelabel_storage_ref: 'lossy-prelabel', can_access: true };
  mocks.prediction.mockResolvedValue([{ type: 'POLYGON_SET', polygons: [{ id: 'exact', label: 'w1', nodes: [] }] }]);
});

describe('saved annotations are never automatically regenerated', () => {
  const load = async () => (await GET(new Request('https://test'), { params: Promise.resolve({ fileId: 'file' }) })).json();
  it('loads the stored source prelabel for an unstarted image', async () => {
    expect((await load()).prelabelOperations[0].polygons[0].id).toBe('exact');
    expect(mocks.prediction).toHaveBeenCalledWith('lossy-prelabel', 1200, 400);
  });
  it('changes asset URLs when the notebook crop changes but keeps them stable for annotation saves', async () => {
    const initial = (await load()).assets;
    mocks.file.updated_at = 'a-new-save';
    expect((await load()).assets).toEqual(initial);
    mocks.file.image_drive_file_id = 'new-notebook-crop';
    const changed = (await load()).assets;
    expect(changed.imageUrl).not.toBe(initial.imageUrl);
    expect(changed.predictionMaskUrl).not.toBe(initial.predictionMaskUrl);
  });
  it('preserves untouched saved geometry and points without regenerating it', async () => {
    mocks.file.annotation_file_id = 'file';
    mocks.file.annotation_segmentation_json = JSON.stringify({ humanAction: 'UNTOUCHED', maskOperations: [{ type: 'POLYGON_SET', polygons: [] }], wartPoints: { state: 'ANNOTATED', points: [{ id: 'point', x: 1, y: 2 }] } });
    mocks.file.annotation_breakpoints_json = '{}';
    const data = await load();
    expect(data.annotation.segmentation.maskOperations[0].polygons).toEqual([]);
    expect(mocks.prediction).not.toHaveBeenCalled();
    expect(data.annotation.segmentation.wartPoints.points).toHaveLength(1);
  });
  it('preserves manually modified geometry and does not load the prediction', async () => {
    mocks.file.annotation_file_id = 'file';
    mocks.file.annotation_segmentation_json = JSON.stringify({ humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: [] }] });
    mocks.file.annotation_breakpoints_json = '{}';
    const data = await load();
    expect(data.annotation.segmentation.maskOperations[0].polygons).toEqual([]);
    expect(mocks.prediction).not.toHaveBeenCalled();
  });
  it('refuses an image outside the assigned groups before loading any prelabel', async () => {
    mocks.file.can_access = false;
    const response = await GET(new Request('https://test'), { params: Promise.resolve({ fileId: 'file' }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.prediction).not.toHaveBeenCalled();
  });
});
