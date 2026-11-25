import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { getDb } from './db';
import { acquireLock } from './lock-service';
import { reviewAnnotation, saveDraft, submitDone } from './annotation-service';
import { listGroups } from './group-service';

/**
 * Duyệt theo ẢNH (người dùng xác nhận 2026-11-17): Hoàn tất gán nhãn → `REVIEW` (Cần review); duyệt Đạt → `DONE`
 * (Hoàn thành), Cần sửa → `DRAFT`. Chỉ đổi nhãn trạng thái: không bảng mới, không revision/version mới.
 * Chạy trên PGlite trong bộ nhớ như lock-service.test.ts.
 */
const segmentation = { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: [
  { id: 'p1', label: 'r1', nodes: [{ id: 'n1', x: 1, y: 1 }, { id: 'n2', x: 9, y: 1 }, { id: 'n3', x: 5, y: 9 }] },
] }] };
const breakpoints = { state: 'NOT_ANNOTATED', points: [] };
const files = ['approve', 'reject', 'stale', 'locked', 'twice', 'outsider', 'draft-only', 'reedit', 'counts', 'draft-approve', 'draft-expired'];

async function state(fileId: string) {
  const db = await getDb();
  const file = await db.prepare<{ annotation_state: string; latest_revision: number; latest_version_number: number }>(
    'SELECT annotation_state, latest_revision, latest_version_number FROM dataset_files WHERE id = ?').get(fileId);
  const annotation = await db.prepare<{ status: string; revision: number; segmentation_json: string }>(
    'SELECT status, revision, segmentation_json FROM annotations WHERE dataset_file_id = ?').get(fileId);
  const versions = await db.prepare<{ total: number | string }>('SELECT COUNT(*) AS total FROM annotation_versions WHERE dataset_file_id = ?').get(fileId);
  return { file: file!, annotation, versions: Number(versions!.total) };
}

/** Người gán nhãn `a` sửa rồi bấm Hoàn tất; trả revision sau Hoàn tất. */
async function complete(fileId: string) {
  const lock = await acquireLock(fileId, 'a');
  if (!lock || lock.denied) throw Error('Expected lock');
  await saveDraft(fileId, 'a', lock.lockToken, 0, segmentation, breakpoints);
  const done = await submitDone(fileId, 'a', lock.lockToken, 1, segmentation, breakpoints);
  if (!done || done === 'LOCK_LOST' || 'conflict' in done) throw Error('Expected Done');
  return done;
}

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  for (const [id, role] of [['a', 'ANNOTATOR'], ['b', 'REVIEWER'], ['c', 'ANNOTATOR'], ['root', 'ADMIN']]) {
    await db.prepare('INSERT INTO users (id, display_name, hashed_password, role) VALUES (?, ?, ?, ?)').run(id, id, 'test', role);
  }
  await db.prepare("INSERT INTO projects (id, name) VALUES ('project', 'Test')").run();
  await db.prepare("INSERT INTO datasets (id, project_id, name) VALUES ('dataset', 'project', 'Test')").run();
  await db.prepare("INSERT INTO file_groups (id, project_id, name) VALUES ('g1', 'project', 'G1')").run();
  // a (người gán nhãn) và b (người duyệt) được giao nhóm; c không được giao.
  for (const userId of ['a', 'b']) await db.prepare("INSERT INTO group_assignments (group_id, user_id) VALUES ('g1', ?)").run(userId);
  for (const id of files) await db.prepare(`INSERT INTO dataset_files
    (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, image_filename, prediction_filename, group_id)
    VALUES (?, 'dataset', ?, 'image', 'mask', 'image.png', 'mask.png', 'g1')`).run(id, id);
}, 30_000);

describe('duyệt theo ảnh: REVIEW giữa Hoàn tất và Hoàn thành', () => {
  it('Hoàn tất gán nhãn đưa ảnh sang REVIEW (không phải DONE), vẫn nhả khóa và tạo version như cũ', async () => {
    const done = await complete('approve');
    expect(done).toMatchObject({ revision: 2, annotationState: 'REVIEW', lockState: 'AVAILABLE' });
    const current = await state('approve');
    expect(current.file.annotation_state).toBe('REVIEW');
    expect(current.annotation?.status).toBe('REVIEW');
    const db = await getDb();
    expect(await db.prepare('SELECT 1 AS held FROM file_locks WHERE dataset_file_id = ?').get('approve')).toBeFalsy();
  });

  it('Đạt → DONE; chỉ đổi nhãn trạng thái: revision, version và dữ liệu polygon giữ nguyên', async () => {
    const before = await state('approve');
    // Mọi vai trò có quyền xem đều duyệt được: ở đây chính người gán nhãn `a` duyệt.
    expect(await reviewAnnotation('approve', 'a', 'APPROVE', 2)).toEqual({ annotationState: 'DONE', revision: 2 });
    const after = await state('approve');
    expect(after.file.annotation_state).toBe('DONE');
    expect(after.annotation?.status).toBe('DONE');
    expect(after.file.latest_revision).toBe(before.file.latest_revision);
    expect(after.annotation?.revision).toBe(before.annotation?.revision);
    expect(after.file.latest_version_number).toBe(before.file.latest_version_number);
    expect(after.versions).toBe(before.versions);
    expect(after.annotation?.segmentation_json).toBe(before.annotation?.segmentation_json);
  });

  it('Cần sửa → DRAFT, người duyệt (REVIEWER) và ADMIN đều làm được', async () => {
    await complete('reject');
    expect(await reviewAnnotation('reject', 'b', 'REJECT', 2)).toEqual({ annotationState: 'DRAFT', revision: 2 });
    expect((await state('reject')).file.annotation_state).toBe('DRAFT');
    await complete('twice');
    expect(await reviewAnnotation('twice', 'root', 'APPROVE', 2)).toMatchObject({ annotationState: 'DONE' });
  });

  it('ảnh không ở REVIEW không kết luận được: đã duyệt rồi, hoặc mới là bản nháp', async () => {
    expect(await reviewAnnotation('twice', 'b', 'REJECT', 2)).toMatchObject({ error: 'NOT_IN_REVIEW', annotationState: 'DONE' });
    expect((await state('twice')).file.annotation_state).toBe('DONE');
    const lock = await acquireLock('draft-only', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    await saveDraft('draft-only', 'a', lock.lockToken, 0, segmentation, breakpoints);
    expect(await reviewAnnotation('draft-only', 'b', 'APPROVE', 1)).toMatchObject({ error: 'NOT_IN_REVIEW', annotationState: 'DRAFT' });
  });

  it('quyết định gắn với phiên bản đang xem: revision lệch thì từ chối, không đổi trạng thái', async () => {
    await complete('stale');
    expect(await reviewAnnotation('stale', 'b', 'APPROVE', 1)).toEqual({ error: 'REVISION_CONFLICT', serverRevision: 2 });
    expect((await state('stale')).file.annotation_state).toBe('REVIEW');
  });

  it('ảnh đang bị người khác mở để sửa thì không duyệt đè; chính người giữ khóa thì được', async () => {
    await complete('locked');
    const editing = await acquireLock('locked', 'a');
    if (!editing || editing.denied) throw Error('Expected lock');
    expect(await reviewAnnotation('locked', 'b', 'APPROVE', 2)).toEqual({ error: 'FILE_LOCKED' });
    expect((await state('locked')).file.annotation_state).toBe('REVIEW');
    expect(await reviewAnnotation('locked', 'a', 'APPROVE', 2)).toMatchObject({ annotationState: 'DONE' });
  });

  it('người không được giao nhóm bị từ chối; ảnh không tồn tại báo không tìm thấy', async () => {
    await complete('outsider');
    expect(await reviewAnnotation('outsider', 'c', 'APPROVE', 2)).toEqual({ error: 'FORBIDDEN' });
    expect((await state('outsider')).file.annotation_state).toBe('REVIEW');
    expect(await reviewAnnotation('missing', 'b', 'APPROVE', 0)).toEqual({ error: 'NOT_FOUND' });
  });

  it('sửa lại ảnh đã Hoàn thành thì về DRAFT và phải Hoàn tất + duyệt lại', async () => {
    await complete('reedit');
    await reviewAnnotation('reedit', 'b', 'APPROVE', 2);
    const lock = await acquireLock('reedit', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    await saveDraft('reedit', 'a', lock.lockToken, 2, segmentation, breakpoints);
    expect((await state('reedit')).file.annotation_state).toBe('DRAFT');
    // Quyết định cũ không còn hiệu lực với phiên bản mới.
    expect(await reviewAnnotation('reedit', 'b', 'APPROVE', 2)).toMatchObject({ error: 'NOT_IN_REVIEW' });
  });

  // Tab Review trong editor (người dùng xác nhận 2026-11-25): Đạt thẳng từ Bản nháp, chỉ người đang giữ khóa hợp lệ.
  it('Đạt thẳng từ Bản nháp: chỉ khi kèm token khóa hợp lệ của chính người duyệt; Cần sửa vẫn chỉ từ REVIEW', async () => {
    const lock = await acquireLock('draft-approve', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    await saveDraft('draft-approve', 'a', lock.lockToken, 0, segmentation, breakpoints);
    const before = await state('draft-approve');
    expect(before.file.annotation_state).toBe('DRAFT');
    // Không token (trang /review), token sai, hoặc token của người khác: giữ luật cũ.
    expect(await reviewAnnotation('draft-approve', 'a', 'APPROVE', 1)).toMatchObject({ error: 'NOT_IN_REVIEW', annotationState: 'DRAFT' });
    expect(await reviewAnnotation('draft-approve', 'a', 'APPROVE', 1, 'wrong-token')).toMatchObject({ error: 'NOT_IN_REVIEW' });
    expect(await reviewAnnotation('draft-approve', 'b', 'APPROVE', 1, lock.lockToken)).toMatchObject({ error: 'NOT_IN_REVIEW' });
    expect(await reviewAnnotation('draft-approve', 'a', 'REJECT', 1, lock.lockToken)).toMatchObject({ error: 'NOT_IN_REVIEW' });
    expect(await reviewAnnotation('draft-approve', 'a', 'APPROVE', 0, lock.lockToken)).toEqual({ error: 'REVISION_CONFLICT', serverRevision: 1 });
    expect((await state('draft-approve')).file.annotation_state).toBe('DRAFT');

    expect(await reviewAnnotation('draft-approve', 'a', 'APPROVE', 1, lock.lockToken)).toEqual({ annotationState: 'DONE', revision: 1 });
    const after = await state('draft-approve');
    expect(after.file.annotation_state).toBe('DONE');
    expect(after.annotation?.status).toBe('DONE');
    expect(after.file.latest_revision).toBe(before.file.latest_revision);
    expect(after.versions).toBe(before.versions);
    expect(after.annotation?.segmentation_json).toBe(before.annotation?.segmentation_json);
    // Khóa vẫn thuộc editor; editor tự nhả khi chuyển ảnh.
    const db = await getDb();
    expect(await db.prepare('SELECT 1 AS held FROM file_locks WHERE dataset_file_id = ?').get('draft-approve')).toBeTruthy();
  });

  it('Đạt thẳng từ Bản nháp bị từ chối khi khóa đã hết hạn', async () => {
    const lock = await acquireLock('draft-expired', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    await saveDraft('draft-expired', 'a', lock.lockToken, 0, segmentation, breakpoints);
    const db = await getDb();
    await db.prepare("UPDATE file_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE dataset_file_id = ?").run('draft-expired');
    expect(await reviewAnnotation('draft-expired', 'a', 'APPROVE', 1, lock.lockToken)).toMatchObject({ error: 'NOT_IN_REVIEW', annotationState: 'DRAFT' });
    expect((await state('draft-expired')).file.annotation_state).toBe('DRAFT');
  });

  it('tiến độ nhóm đếm riêng ảnh chờ duyệt, không gộp vào Hoàn thành', async () => {
    await complete('counts');
    const groups = await listGroups('project', 'root');
    const group = groups!.groups.find((item) => item.id === 'g1')!;
    expect(group.total).toBe(files.length);
    const db = await getDb();
    const expected = async (value: string) => Number((await db.prepare<{ total: number | string }>(
      "SELECT COUNT(*) AS total FROM dataset_files WHERE group_id = 'g1' AND annotation_state = ?").get(value))!.total);
    expect(group.review).toBe(await expected('REVIEW'));
    expect(group.done).toBe(await expected('DONE'));
    expect(group.review).toBeGreaterThan(0);
    expect(group.done).toBeGreaterThan(0);
    expect(group.unstarted + group.draft + group.review + group.done).toBe(group.total);
  });
});
