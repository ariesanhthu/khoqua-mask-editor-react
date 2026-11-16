import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { AnnotationPolygon } from '@/types';

const mocks = vi.hoisted(() => ({
  user: { userId: 'labeler', role: 'ANNOTATOR', displayName: 'Test' },
  authenticated: true,
  source: vi.fn<(ref: string) => Promise<Uint8Array>>(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./drive-service', () => ({ fetchDatasetAsset: mocks.source }));
vi.mock('./auth', () => ({ requireAuth: async () => {
  if (!mocks.authenticated) throw Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
  return mocks.user;
} }));

import { getDb } from './db';
import { createCompletedProjectExportArchive } from './completed-export-service';
import { GET } from '../app/api/projects/[projectId]/export/completed/route';

const ring = (left: number, top: number, right: number, bottom: number) => [
  { id: 'a', x: left, y: top }, { id: 'b', x: right, y: top },
  { id: 'c', x: right, y: bottom }, { id: 'd', x: left, y: bottom },
];
const polygons: AnnotationPolygon[] = [
  { id: 'original-id', label: 'r7', nodes: ring(0.25, 0.25, 9.75, 9.75), holes: [ring(3, 3, 7, 7)], meta: { semantic: 'main_flesh_band' } },
  { id: 'overlap-id', label: 'w2', nodes: ring(1, 1, 4, 4), meta: { semantic: 'wart_flesh' } },
];
const segmentation = JSON.stringify({ humanAction: 'MODIFIED', maskStorageKey: 'must-not-read-raster',
  maskOperations: [{ type: 'POLYGON_SET', polygons }] });
let image: Buffer;
const download = () => GET(new Request('https://test/api/projects/p/export/completed'), { params: Promise.resolve({ projectId: 'p' }) });
const archiveFor = async (userId = 'labeler') => (await createCompletedProjectExportArchive('p', userId))!;

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  for (const [id, role] of [['admin', 'ADMIN'], ['labeler', 'ANNOTATOR'], ['reviewer', 'REVIEWER'], ['outsider', 'ANNOTATOR']]) {
    await db.prepare('INSERT INTO users (id, display_name, hashed_password, role) VALUES (?, ?, ?, ?)').run(id, id, 'test', role);
  }
  for (const project of ['p', 'other']) {
    await db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(project, project);
    await db.prepare('INSERT INTO datasets (id, project_id, name) VALUES (?, ?, ?)').run(project, project, project);
  }
  await db.prepare("INSERT INTO datasets (id, project_id, name) VALUES ('p-extra', 'p', 'Extra dataset')").run();
  await db.prepare("INSERT INTO file_groups (id, project_id, name) VALUES ('assigned', 'p', 'Assigned'), ('hidden', 'p', 'Hidden'), ('other', 'other', 'Other')").run();
  for (const userId of ['labeler', 'reviewer']) {
    await db.prepare("INSERT INTO group_assignments (group_id, user_id) VALUES ('assigned', ?)").run(userId);
  }
  for (const [id, project, group] of [
    ['done', 'p', 'assigned'], ['draft', 'p', 'assigned'], ['unstarted', 'p', 'assigned'],
    ['hidden', 'p', 'hidden'], ['loose', 'p', null], ['other', 'other', 'other'],
  ]) {
    await db.prepare(`INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id,
      image_filename, prediction_filename, width, height, group_id, annotation_state)
      VALUES (?, ?, ?, ?, 'never-fetch-prediction', 'original.jpg', 'prediction.png', 10, 10, ?, 'DONE')`)
      .run(id, id === 'hidden' ? 'p-extra' : project, id, `image-${id}`, group);
    if (id !== 'unstarted') await db.prepare(`INSERT INTO annotations
      (dataset_file_id, revision, status, segmentation_json, last_edited_by) VALUES (?, 7, ?, ?, 'admin')`)
      .run(id, id === 'draft' ? 'DRAFT' : 'DONE', segmentation);
  }
  // A historical completed version does not qualify an image whose current annotation is a draft.
  await db.prepare(`INSERT INTO annotation_versions
    (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, version_label)
    VALUES ('historical', 'draft', 99, 1, ?, '{}', 'admin', 'Hoàn tất')`).run(segmentation);
  image = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).jpeg().toBuffer();
}, 30_000);

beforeEach(async () => {
  mocks.authenticated = true;
  mocks.user = { userId: 'labeler', role: 'ANNOTATOR', displayName: 'Test' };
  mocks.source.mockReset().mockResolvedValue(image);
  const db = await getDb();
  await db.prepare("UPDATE annotations SET status = 'DONE', segmentation_json = ? WHERE dataset_file_id = 'done'").run(segmentation);
  await db.prepare("UPDATE dataset_files SET external_key = id, width = 10, height = 10").run();
});

describe('completed-only download', () => {
  it('filters current DONE in SQL, ignores historical completion and exports exact image/vector bytes', async () => {
    const db = await getDb();
    const before = await db.prepare('SELECT * FROM annotations ORDER BY dataset_file_id').all();
    const result = await archiveFor();
    const zip = await JSZip.loadAsync(await result.archive.generateAsync({ type: 'uint8array' }));
    expect(result.exported).toBe(1);
    expect(Object.values(zip.files).filter((file) => !file.dir).map((file) => file.name).sort())
      .toEqual(['coco.json', 'images/done.jpg', 'polygons/done.json']);
    expect(await zip.file('images/done.jpg')!.async('nodebuffer')).toEqual(image);
    const vectors = JSON.parse(await zip.file('polygons/done.json')!.async('string'));
    expect(vectors).toMatchObject({ status: 'DONE', revision: 7, width: 10, height: 10 });
    expect(vectors.maskOperations).toEqual(JSON.parse(segmentation).maskOperations);
    const coco = JSON.parse(await zip.file('coco.json')!.async('string'));
    expect(coco.images).toEqual([expect.objectContaining({ id: 1, file_name: 'images/done.jpg', status: 'DONE' })]);
    expect(coco.annotations.map((a: { id: number; image_id: number }) => [a.id, a.image_id])).toEqual([[1, 1], [2, 1]]);
    expect(coco.annotations[0]).toMatchObject({ area: 84, bbox: [0, 0, 10, 10], attributes: { polygon_id: 'original-id', label: 'r7' } });
    // Decode column-major RLE independently; the inner hole and overlap stay independent.
    const decoded = coco.annotations.map((a: { segmentation: { counts: number[] } }) => {
      const pixels: number[] = [];
      a.segmentation.counts.forEach((count, index) => pixels.push(...Array(count).fill(index % 2)));
      expect(pixels).toHaveLength(100);
      return pixels;
    });
    expect(decoded[0][4 * 10 + 4]).toBe(0);
    expect(decoded[0][2 * 10 + 2]).toBe(1);
    expect(decoded[1][2 * 10 + 2]).toBe(1);
    expect(mocks.source.mock.calls).toEqual([['image-done']]);
    expect(await db.prepare('SELECT * FROM annotations ORDER BY dataset_file_id').all()).toEqual(before);
  });

  it('allows all roles with assigned groups and reads ADMIN authority from the database', async () => {
    expect((await archiveFor('reviewer')).exported).toBe(1);
    expect((await archiveFor('admin')).exported).toBe(3);
    mocks.user.role = 'ADMIN'; // Forged/stale JWT cannot broaden database permissions.
    const response = await download();
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(JSON.parse(await zip.file('coco.json')!.async('string')).images).toHaveLength(1);
  });

  it('returns 404 outside assigned projects, including unknown projects and deleted accounts', async () => {
    expect(await createCompletedProjectExportArchive('missing', 'admin')).toBeNull();
    expect(await createCompletedProjectExportArchive('other', 'labeler')).toBeNull();
    expect(await createCompletedProjectExportArchive('p', 'deleted-account')).toBeNull();
    mocks.user.userId = 'outsider';
    expect((await download()).status).toBe(404);
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it('streams a ZIP with download headers and preserves authentication errors', async () => {
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="p-completed.zip"');
    expect((await JSZip.loadAsync(await response.arrayBuffer())).file('coco.json')).not.toBeNull();
    mocks.authenticated = false;
    expect((await download()).status).toBe(401);
  });

  it('reports no completed images instead of silently returning an empty archive', async () => {
    await (await getDb()).prepare("UPDATE annotations SET status = 'DRAFT' WHERE dataset_file_id = 'done'").run();
    const response = await download();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('Chưa có ảnh đã hoàn tất') });
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it('keeps an explicitly empty polygon set as a completed negative example', async () => {
    await (await getDb()).prepare("UPDATE annotations SET segmentation_json = ? WHERE dataset_file_id = 'done'")
      .run(JSON.stringify({ maskOperations: [{ type: 'POLYGON_SET', polygons: [] }] }));
    const result = await archiveFor();
    expect(result.exported).toBe(1);
    expect(JSON.parse(await result.archive.file('coco.json')!.async('string')).annotations).toEqual([]);
  });

  it.each([{ maskOperations: [] }, { maskOperations: [{ type: 'POLYGON_SET', polygons }, { type: 'RESET_TO_PREDICTION' }] }])
    ('rejects missing or stale polygons without reading prediction/raster: %j', async ({ maskOperations }) => {
      await (await getDb()).prepare("UPDATE annotations SET segmentation_json = ? WHERE dataset_file_id = 'done'")
        .run(JSON.stringify({ maskOperations }));
      await expect(archiveFor()).rejects.toThrow('done: Chưa có polygon hiện hành');
      expect(mocks.source).not.toHaveBeenCalled();
    });

  it('fails before sending ZIP bytes if any source image cannot be fetched', async () => {
    mocks.source.mockRejectedValueOnce(new Error('Source missing'));
    const response = await download();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: 'done: Source missing' });
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('rejects image dimensions that differ from saved coordinates', async () => {
    await (await getDb()).prepare("UPDATE dataset_files SET width = 9 WHERE id = 'done'").run();
    await expect(archiveFor()).rejects.toThrow('done: Kích thước ảnh gốc không khớp');
  });

  it('rejects filename collisions across datasets rather than overwriting images or JSON', async () => {
    await (await getDb()).prepare("UPDATE dataset_files SET external_key = 'done' WHERE id = 'hidden'").run();
    await expect(archiveFor('admin')).rejects.toThrow('Trùng tên tệp xuất: done');
  });
});
