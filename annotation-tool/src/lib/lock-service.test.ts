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
  for (const id of ['race', 'revisions', 'expiry']) await db.prepare(`INSERT INTO dataset_files
    (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, image_filename, prediction_filename)
    VALUES (?, 'dataset', ?, 'image', 'mask', 'image.png', 'mask.png')`).run(id, id);
}, 30_000);

describe('exclusive edit locks and revisions', () => {
  it('allows one simultaneous writer, denies another account and another session of the same account', async () => {
    const results = await Promise.all([acquireLock('race', 'a'), acquireLock('race', 'b')]);
    expect(results.filter((result) => result && !result.denied)).toHaveLength(1);
    const index = results.findIndex((result) => result && !result.denied);
    const owner = index === 0 ? 'a' : 'b';
    const other = index === 0 ? 'b' : 'a';
    const lock = results[index]!;
    if (lock.denied) throw Error('Expected lock');
    expect(await acquireLock('race', owner)).toMatchObject({ denied: true });
    expect(await acquireLock('race', owner, lock.lockToken)).toMatchObject({ denied: false, lockToken: lock.lockToken });
    expect(await heartbeat('race', lock.lockToken, other)).toBeNull();
    expect(await saveDraft('race', other, lock.lockToken, 0, { humanAction: 'ACCEPTED' }, {})).toBe('LOCK_LOST');
    expect(await releaseLock('race', 'invalid')).toBe(false);
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
