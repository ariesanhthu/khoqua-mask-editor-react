import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  versions: [] as Record<string, unknown>[],
  remote: new Map<string, string>(),
  upload: vi.fn(async () => ({ id: 'uploaded' })),
  source: vi.fn(async () => new Uint8Array([1, 2, 3])),
  stored: vi.fn(async () => Buffer.from([9, 9, 9])),
}));
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ getDb: async () => ({ prepare: (query: string) => ({
  get: async () => ({ id: 'p', name: 'Test', export_drive_folder_id: 'folder' }),
  all: async () => {
    if (query.includes('FROM annotation_versions')) return mocks.versions;
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
  mocks.versions = [];
  mocks.rows = [{ file_id: 'f', external_key: 'file', prediction_ref: 'blob:source.png',
    image_ref: 'blob:image.png',
    segmentation_json: JSON.stringify({ humanAction: 'ACCEPTED', wartPoints: { state: 'ANNOTATED', points: [{ id: 'wart', x: 1, y: 2 }] } }),
    breakpoints_json: JSON.stringify({ state: 'CONFIRMED_NONE', points: [] }),
    revision: 4, latest_version_number: 0, annotation_status: 'DRAFT', width: 10, height: 10 }];
  mocks.source.mockImplementation(async () => sharp({ create: { width: Number(mocks.rows[0].width), height: Number(mocks.rows[0].height), channels: 3, background: '#ffffff' } }).png().toBuffer());
});

describe('explicit Drive exports', () => {
  it('includes historical raw annotations and original crops only when requested', async () => {
    const raw = JSON.stringify({ humanAction: 'ACCEPTED', custom: 'old edits', maskOperations: [] }, null, 2);
    mocks.versions = [{ id: 'v', external_key: 'file', version_number: 2, segmentation_json: raw, breakpoints_json: '{}',
      asset_snapshot_json: JSON.stringify({ image: 'old-image', prediction: 'old-mask', width: 8, height: 6 }) }];
    const currentOnly = await JSZip.loadAsync((await createProjectExportArchive('p'))!.bytes);
    expect(currentOnly.file('versions/file/v2/segmentation.json')).toBeNull();
    const full = await JSZip.loadAsync((await createProjectExportArchive('p', true))!.bytes);
    expect(await full.file('versions/file/v2/segmentation.json')!.async('string')).toBe(raw);
    expect(JSON.parse(await full.file('versions/file/v2/annotation.json')!.async('string'))).toMatchObject({ width: 8, height: 6 });
    expect(mocks.source).toHaveBeenCalledWith('old-image');
    expect(mocks.source).toHaveBeenCalledWith('old-mask');
  });
  it('downloads raw saved mask, image and all annotation data without rebuilding polygons', async () => {
    const savedMask = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).png().toBuffer();
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    mocks.stored.mockResolvedValueOnce(savedMask);
    mocks.source.mockResolvedValueOnce(image);
    const nodes = [{ id: 'n1', x: 0.125, y: 0.875 }, { id: 'n2', x: 9.625, y: 1.25 }, { id: 'n3', x: 4.75, y: 8.875 }];
    const segmentation = { humanAction: 'ACCEPTED', maskStorageKey: 'saved', customBoundarySetting: 2.75,
      maskOperations: [{ type: 'POLYGON_SET', polygons: [{ id: 'p', label: 'w7', nodes, holes: [], meta: { locked: true, note: 'keep exactly' } }] }],
      wartPoints: { state: 'ANNOTATED', points: [{ id: 'point', x: 1.125, y: 3.5 }] } };
    mocks.rows[0].segmentation_json = JSON.stringify(segmentation, null, 2);
    const zip = await JSZip.loadAsync((await createProjectExportArchive('p'))!.bytes);
    expect(await zip.file('masks/file.png')!.async('nodebuffer')).toEqual(savedMask);
    expect(await zip.file('images/file.jpg')!.async('nodebuffer')).toEqual(image);
    expect(await zip.file('saved/file/segmentation.json')!.async('string')).toBe(mocks.rows[0].segmentation_json);
    const annotation = JSON.parse(await zip.file('annotations/file.json')!.async('string'));
    expect(annotation.segmentation).toEqual(segmentation);
    expect(annotation.maskOperations).toEqual(segmentation.maskOperations);
    expect(await zip.file('boundaries/file.svg')!.async('string')).toContain('M0.125,0.875 L9.625,1.25 L4.75,8.875');
    expect(await zip.file('overlays/file.svg')!.async('string')).toContain('data:image/jpeg;base64,');
  });
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

  it('renders a supplementary raster only when no saved mask exists', async () => {
    mocks.rows[0].segmentation_json = JSON.stringify({ humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: [{ id: 'p', nodes: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }] }] }] });
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
    expect(zip.file('images/file.png')).not.toBeNull();
    const annotation = JSON.parse(await zip.file('annotations/file.json')!.async('string'));
    expect(annotation).toMatchObject({ schemaVersion: 'bitter-melon-prelabel-1.1', width: 10, height: 10, status: 'DRAFT' });
    expect(annotation.maskOperations[0].polygons).toHaveLength(1);
    const coco = JSON.parse(await zip.file('coco.json')!.async('string'));
    expect(coco.images[0]).toMatchObject({ file_name: 'images/file.png', width: 10, height: 10 });
    expect(coco.annotations[0]).toMatchObject({ image_id: 1, area: 49, bbox: [1, 1, 7, 7], iscrowd: 0 });
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('reports per-file errors without publishing a manifest that claims success', async () => {
    mocks.source.mockRejectedValueOnce(new Error('Source missing'));
    const result = await syncProjectAnnotationsToDrive('p');
    expect(result?.errors).toEqual([{ id: 'file', message: 'Source missing' }]);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('exports inner rings as empty pixels while preserving another mask inside the hole', async () => {
    const ring = (left: number, top: number, right: number, bottom: number) => [
      { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
    ];
    mocks.rows[0].width = 50;
    mocks.rows[0].height = 50;
    mocks.rows[0].segmentation_json = JSON.stringify({ humanAction: 'MODIFIED', maskOperations: [{
      type: 'POLYGON_SET', polygons: [
        { id: 'island', nodes: ring(22, 22, 28, 28) },
        { id: 'connected', nodes: ring(1, 1, 49, 49), holes: [ring(10, 10, 40, 40)] },
      ],
    }] });
    const result = await createProjectExportArchive('p');
    expect(result?.errors).toEqual([]);
    const zip = await JSZip.loadAsync(result!.bytes);
    const mask = await zip.file('masks/file.png')!.async('nodebuffer');
    const { data, info } = await sharp(mask).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(pixel(5, 25)).toBe(255);
    expect(pixel(15, 25)).toBe(0);
    expect(pixel(25, 25)).toBe(255);
  });

  it('includes an unstarted image with its own annotation and mask', async () => {
    mocks.rows[0].annotation_status = 'UNSTARTED';
    mocks.rows[0].segmentation_json = '{"humanAction":"UNTOUCHED"}';
    const result = await createProjectExportArchive('p');
    const zip = await JSZip.loadAsync(result!.bytes);
    const annotation = JSON.parse(await zip.file('annotations/file.json')!.async('string'));
    expect(annotation.status).toBe('UNSTARTED');
    expect(annotation.maskOperations).toEqual([]);
    expect(zip.file('masks/file.png')).not.toBeNull();
    expect(zip.file('images/file.png')).not.toBeNull();
  });

  it('fails the download explicitly instead of silently omitting images whose assets cannot load', async () => {
    mocks.source.mockRejectedValueOnce(new Error('Source missing'));
    await expect(createProjectExportArchive('p')).rejects.toThrow('Source missing');
  });

  it('does not reuse masks rendered by the previous antialiased exporter', async () => {
    await syncProjectAnnotationsToDrive('p');
    const uploads = mocks.upload.mock.calls as unknown as Array<[string, string, Uint8Array]>;
    for (const [name, , bytes] of uploads) if (name.endsWith('.jsonl')) mocks.remote.set(name, new TextDecoder().decode(bytes));
    const previous = JSON.parse(mocks.remote.get('manifest.jsonl')!);
    delete previous.mask_encoding;
    mocks.remote.set('manifest.jsonl', JSON.stringify(previous));
    expect(await syncProjectAnnotationsToDrive('p')).toMatchObject({ updated: 1, skipped: 0 });
  });
});
