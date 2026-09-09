import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  remote: new Map<string, string>(),
  upload: vi.fn(async () => ({ id: 'uploaded' })),
  source: vi.fn(async () => new Uint8Array([1, 2, 3])),
  stored: vi.fn(async () => Buffer.from([9, 9, 9])),
}));
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ getDb: async () => ({ prepare: (query: string) => ({
  get: async () => ({ id: 'p', name: 'Test', export_drive_folder_id: 'folder' }),
  all: async () => {
    if (query.includes("annotation_state = 'DONE'")) throw Error('Drafts must be included');
    return mocks.rows;
  },
}) }) }));
vi.mock('./drive-service', () => ({
  ensureDriveFolder: async () => 'masks', normalizeDriveFolderId: (value: string) => value,
  readDriveTextFile: async (name: string) => mocks.remote.get(name) ?? null,
  upsertDriveFile: mocks.upload, fetchDatasetAsset: mocks.source,
}));
vi.mock('./storage', () => ({ readStoredMask: mocks.stored }));
import { createProjectExportArchive, syncProjectAnnotationsToDrive } from './export-service';

beforeEach(() => {
  vi.clearAllMocks(); mocks.remote.clear();
  mocks.rows = [{ file_id: 'f', external_key: 'file', prediction_ref: 'blob:source.png',
    segmentation_json: JSON.stringify({ humanAction: 'ACCEPTED', wartPoints: { state: 'ANNOTATED', points: [{ id: 'wart', x: 1, y: 2 }] } }),
    breakpoints_json: JSON.stringify({ state: 'CONFIRMED_NONE', points: [] }),
    revision: 4, latest_version_number: 0, annotation_status: 'DRAFT', width: 10, height: 10 }];
});

describe('explicit Drive exports', () => {
  it('exports saved drafts, keeps legacy points separate and skips an unchanged second export', async () => {
    const first = await syncProjectAnnotationsToDrive('p');
    expect(first).toMatchObject({ exported: 1, updated: 1, errors: [] });
    expect(mocks.source).toHaveBeenCalledWith('blob:source.png');
    const uploads = mocks.upload.mock.calls as unknown as Array<[string, string, Uint8Array]>;
    for (const [name, , bytes] of uploads) if (name.endsWith('.jsonl')) mocks.remote.set(name, new TextDecoder().decode(bytes));
    expect(JSON.parse(mocks.remote.get('wart-points.jsonl')!)).toMatchObject({ points: [{ id: 'wart', x: 1, y: 2 }] });
    expect(JSON.parse(mocks.remote.get('breakpoints.jsonl')!)).toMatchObject({ points: [] });
    expect(JSON.parse(mocks.remote.get('manifest.jsonl')!)).toMatchObject({ revision: 4, annotation_status: 'DRAFT' });
    vi.clearAllMocks();
    expect(await syncProjectAnnotationsToDrive('p')).toMatchObject({ updated: 0, skipped: 1 });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('renders older draft polygons instead of exporting a stale raster mask', async () => {
    mocks.rows[0].segmentation_json = JSON.stringify({ humanAction: 'MODIFIED', maskStorageKey: 'old', maskOperations: [{ type: 'POLYGON_SET', polygons: [{ id: 'p', nodes: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }] }] }] });
    const result = await createProjectExportArchive('p');
    expect(result?.errors).toEqual([]);
    const zip = await JSZip.loadAsync(result!.bytes);
    const mask = await zip.file('masks/file.png')!.async('nodebuffer');
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(10);
    expect(data[0]).toBe(0);
    expect(data[(5 * info.width + 5) * info.channels]).toBe(255);
    expect(mocks.stored).not.toHaveBeenCalled();
    expect(zip.file('wart-points.jsonl')).not.toBeNull();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('reports per-file errors without publishing a manifest that claims success', async () => {
    mocks.source.mockRejectedValueOnce(new Error('Source missing'));
    const result = await syncProjectAnnotationsToDrive('p');
    expect(result?.errors).toEqual([{ id: 'file', message: 'Source missing' }]);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
