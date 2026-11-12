import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { getDb } from './db';
import { acquireLock, heartbeat, releaseLock } from './lock-service';
import { getAnnotation, saveDraft, submitDone } from './annotation-service';

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  for (const id of ['a', 'b']) await db.prepare('INSERT INTO users (id, display_name, hashed_password) VALUES (?, ?, ?)').run(id, id, 'test');
  await db.prepare("INSERT INTO projects (id, name) VALUES ('project', 'Test')").run();
  await db.prepare("INSERT INTO datasets (id, project_id, name) VALUES ('dataset', 'project', 'Test')").run();
  for (const id of ['race', 'revisions', 'expiry', 'parallel', 'preservation', 'takeover', 'keep-mine']) await db.prepare(`INSERT INTO dataset_files
    (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, image_filename, prediction_filename)
    VALUES (?, 'dataset', ?, 'image', 'mask', 'image.png', 'mask.png')`).run(id, id);
}, 30_000);

describe('exclusive edit locks and revisions', () => {
  it('keeps exact vector coordinates, labels, holes and custom metadata through save and Done', async () => {
    const lock = await acquireLock('preservation', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    const nodes = [{ id: 'n1', x: 0.125, y: 0.75 }, { id: 'n2', x: 9.875, y: 0.5 }, { id: 'n3', x: 3.5, y: 9.25 }];
    const segmentation = { humanAction: 'MODIFIED', boundarySetting: 0.125, maskOperations: [{ type: 'POLYGON_SET', polygons: [
      { id: 'original', label: 'my-label', nodes, holes: [nodes], meta: { locked: true, note: 'preserve' } },
    ] }] };
    const breakpoints = { state: 'ANNOTATED', points: [{ id: 'bp', x: 1.25, y: 7.75 }], custom: 'original' };
    expect(await saveDraft('preservation', 'a', lock.lockToken, 0, segmentation, breakpoints)).toMatchObject({ revision: 1 });
    expect(await getAnnotation('preservation')).toMatchObject({ segmentation, breakpoints });
    expect(await submitDone('preservation', 'a', lock.lockToken, 1, segmentation, breakpoints)).toMatchObject({ revision: 2 });
    const db = await getDb();
    const version = await db.prepare('SELECT segmentation_json, breakpoints_json FROM annotation_versions WHERE dataset_file_id = ?').get('preservation');
    expect(JSON.parse(String(version?.segmentation_json))).toMatchObject(segmentation);
    expect(JSON.parse(String(version?.breakpoints_json))).toEqual(breakpoints);
  });
  it('allows one simultaneous writer and denies another account', async () => {
    const results = await Promise.all([acquireLock('race', 'a'), acquireLock('race', 'b')]);
    expect(results.filter((result) => result && !result.denied)).toHaveLength(1);
    const index = results.findIndex((result) => result && !result.denied);
    const owner = index === 0 ? 'a' : 'b';
    const other = index === 0 ? 'b' : 'a';
    const lock = results[index]!;
    if (lock.denied) throw Error('Expected lock');
    expect(await acquireLock('race', other)).toMatchObject({ denied: true });
    expect(await acquireLock('race', owner, lock.lockToken)).toMatchObject({ denied: false, lockToken: lock.lockToken, takenOver: false });
    expect(await heartbeat('race', lock.lockToken, other)).toBeNull();
    expect(await saveDraft('race', other, lock.lockToken, 0, { humanAction: 'ACCEPTED' }, {})).toBe('LOCK_LOST');
    expect(await releaseLock('race', 'invalid')).toBe(false);
  });

  // Người dùng xác nhận 2026-11-07: cùng tài khoản mở ở tab/thiết bị/origin khác (localhost vs Vercel) vẫn được sửa.
  // Phiên mới nhận khóa, phiên cũ mất token nên lưu nhận LOCK_LOST và phải tự chọn giữa hai bản.
  it('lets another session of the same account take over, and the old session can no longer write', async () => {
    const first = await acquireLock('takeover', 'a');
    if (!first || first.denied) throw Error('Expected lock');
    expect(await saveDraft('takeover', 'a', first.lockToken, 0, { humanAction: 'ACCEPTED' }, {})).toMatchObject({ revision: 1 });

    const second = await acquireLock('takeover', 'a');
    if (!second || second.denied) throw Error('Expected same-account takeover');
    expect(second).toMatchObject({ takenOver: true, baseRevision: 1 });
    expect(second.lockToken).not.toBe(first.lockToken);

    expect(await heartbeat('takeover', first.lockToken, 'a')).toBeNull();
    expect(await saveDraft('takeover', 'a', first.lockToken, 1, { humanAction: 'MODIFIED' }, {})).toBe('LOCK_LOST');
    expect(await submitDone('takeover', 'a', first.lockToken, 1, {}, {})).toBe('LOCK_LOST');
    expect(await heartbeat('takeover', second.lockToken, 'a')).not.toBeNull();
    expect(await acquireLock('takeover', 'b')).toMatchObject({ denied: true, lockedBy: { userId: 'a' } });

    const db = await getDb();
    const sessions = await db.prepare<{ id: string; close_reason: string | null }>(
      "SELECT id, close_reason FROM annotation_sessions WHERE dataset_file_id = 'takeover' ORDER BY opened_at",
    ).all();
    expect(sessions.find((session) => session.id === first.sessionId)?.close_reason).toBe('TAKEN_OVER');
    expect(sessions.find((session) => session.id === second.sessionId)?.close_reason).toBeNull();
  });

  it('keeps the other session version in history when the user keeps their own copy after a conflict', async () => {
    const tabA = await acquireLock('keep-mine', 'a');
    if (!tabA || tabA.denied) throw Error('Expected lock');
    const original = { humanAction: 'MODIFIED', marker: 'A1' };
    expect(await saveDraft('keep-mine', 'a', tabA.lockToken, 0, original, {})).toMatchObject({ revision: 1, versionNumber: 1 });

    const tabB = await acquireLock('keep-mine', 'a');
    if (!tabB || tabB.denied) throw Error('Expected lock');
    const fromB = { humanAction: 'MODIFIED', marker: 'B' };
    // Lưu tiếp của cùng người, cùng dữ liệu gốc: gộp vào version đang có như trước.
    expect(await saveDraft('keep-mine', 'a', tabB.lockToken, 1, fromB, {})).toMatchObject({ revision: 2, versionNumber: 1 });

    // Tab A chọn "giữ bản của tôi": lấy lại khóa rồi lưu với newVersion, bản của tab B phải còn trong lịch sử.
    const retake = await acquireLock('keep-mine', 'a');
    if (!retake || retake.denied) throw Error('Expected lock');
    const fromA = { humanAction: 'MODIFIED', marker: 'A2' };
    expect(await saveDraft('keep-mine', 'a', retake.lockToken, retake.baseRevision, fromA, {}, { newVersion: true }))
      .toMatchObject({ revision: 3, versionNumber: 2 });

    const db = await getDb();
    const versions = await db.prepare<{ version_number: number; segmentation_json: string }>(
      "SELECT version_number, segmentation_json FROM annotation_versions WHERE dataset_file_id = 'keep-mine' ORDER BY version_number",
    ).all();
    expect(versions.map((version) => [version.version_number, JSON.parse(version.segmentation_json).marker])).toEqual([[1, 'B'], [2, 'A2']]);
    expect(await getAnnotation('keep-mine')).toMatchObject({ revision: 3, segmentation: { marker: 'A2' } });
  });

  it('preserves wart and legacy points, rejects stale revisions, and releases only on successful Done', async () => {
    const lock = await acquireLock('revisions', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    const wartPoints = { state: 'ANNOTATED', points: [{ id: 'wart', x: 20, y: 30 }] };
    const legacy = { state: 'ANNOTATED', points: [{ id: 'legacy', x: 2, y: 3 }] };
    const segmentation = { humanAction: 'ACCEPTED', wartPoints };
    expect(await saveDraft('revisions', 'a', lock.lockToken, 0, segmentation, legacy)).toMatchObject({ revision: 1 });
    expect(await saveDraft('revisions', 'a', lock.lockToken, 0, segmentation, legacy)).toMatchObject({ conflict: true, serverRevision: 1 });
    expect(await getAnnotation('revisions')).toMatchObject({ segmentation: { wartPoints }, breakpoints: legacy });
    expect(await submitDone('revisions', 'a', lock.lockToken, 1, segmentation, legacy)).toMatchObject({ revision: 2, annotationState: 'DONE' });
    expect(await saveDraft('revisions', 'a', lock.lockToken, 2, segmentation, legacy)).toBe('LOCK_LOST');
    expect(await acquireLock('revisions', 'b')).toMatchObject({ denied: false, baseRevision: 2 });
  });

  it('serialises two simultaneous saves from one token so neither write is silently lost', async () => {
    const lock = await acquireLock('parallel', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    const results = await Promise.all([
      saveDraft('parallel', 'a', lock.lockToken, 0, { humanAction: 'ACCEPTED' }, {}),
      saveDraft('parallel', 'a', lock.lockToken, 0, { humanAction: 'MODIFIED' }, {}),
    ]);
    expect(results.filter((result) => result && typeof result === 'object' && 'revision' in result)).toHaveLength(1);
    expect(results.filter((result) => result && typeof result === 'object' && 'conflict' in result)).toHaveLength(1);
    expect(await getAnnotation('parallel')).toMatchObject({ revision: 1 });
  });

  it('rejects the old writer after expiry and reacquisition', async () => {
    const lock = await acquireLock('expiry', 'a');
    if (!lock || lock.denied) throw Error('Expected lock');
    const db = await getDb();
    await db.prepare("UPDATE file_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE dataset_file_id = 'expiry'").run();
    expect(await acquireLock('expiry', 'b')).toMatchObject({ denied: false });
    expect(await heartbeat('expiry', lock.lockToken, 'a')).toBeNull();
    expect(await submitDone('expiry', 'a', lock.lockToken, 0, {}, {})).toBe('LOCK_LOST');
  });
});
