import { beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: vi.fn() }));
import { requireAuth } from './auth';
import { getDb } from './db';
import { activateVersion, deleteVersion, findVersion, requireVersionAdmin, versionAssets } from './version-service';
import { acquireLock, releaseLock } from './lock-service';
import { saveDraft, submitDone } from './annotation-service';
import { GET as list } from '../app/api/files/[fileId]/versions/route';
import { GET as detail, DELETE as remove, POST as activate } from '../app/api/files/[fileId]/versions/[versionId]/route';
import { GET as download } from '../app/api/files/[fileId]/versions/[versionId]/export/route';
import { GET as asset } from '../app/api/files/[fileId]/versions/[versionId]/assets/[assetType]/route';

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  await db.prepare("INSERT INTO users (id, display_name, hashed_password, role) VALUES ('admin', 'Admin', 'test', 'ADMIN'), ('annotator', 'Annotator', 'test', 'ANNOTATOR'), ('reviewer', 'Reviewer', 'test', 'REVIEWER')").run();
  await db.prepare("INSERT INTO projects (id, name) VALUES ('p', 'test')").run();
  await db.prepare("INSERT INTO datasets (id, project_id, name) VALUES ('d', 'p', 'test')").run();
  for (const id of ['one', 'two']) await db.prepare(`INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, image_filename, prediction_filename, latest_version_number, width, height)
    VALUES (?, 'd', ?, 'new-image', 'new-mask', 'image.png', 'mask.png', 4, 1200, 396)`).run(id, id);
  await db.prepare(`INSERT INTO annotations (dataset_file_id, revision, segmentation_json, breakpoints_json, last_edited_by) VALUES ('one', 5, '{"humanAction":"MODIFIED"}', '{}', 'admin')`).run();
  for (const id of ['v1', 'v2']) await db.prepare(`INSERT INTO annotation_versions (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, asset_snapshot_json)
    VALUES (?, 'one', ?, 4, '{}', '{}', 'admin', ?)`).run(id, id === 'v1' ? 3 : 4, JSON.stringify({ image: 'old-image', prediction: 'old-mask', width: 2067, height: 609 }));
}, 30000);

describe('ADMIN version access', () => {
  it('rejects unauthenticated, annotator, reviewer and stale ADMIN token on all endpoints', async () => {
    const request = new Request('https://test/api/files/one/versions');
    const context = { params: Promise.resolve({ fileId: 'one', versionId: 'v1', assetType: 'image' }) };
    for (const id of ['annotator', 'reviewer', 'missing']) {
      vi.mocked(requireAuth).mockResolvedValue({ userId: id, displayName: id, role: 'ADMIN' });
      for (const handler of [list, detail, remove, asset, activate, download]) expect((await handler(request, context)).status).toBe(403);
    }
    vi.mocked(requireAuth).mockRejectedValue(Response.json({}, { status: 401 }));
    for (const handler of [list, detail, remove, asset, activate, download]) expect((await handler(request, context)).status).toBe(401);
  });
  it('lets an ADMIN view historical dimensions and scopes detail to its file', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'admin', displayName: 'Admin', role: 'ADMIN' });
    await expect(requireVersionAdmin(new Request('https://test'))).resolves.toMatchObject({ userId: 'admin' });
    const row = await findVersion('one', 'v1');
    expect(versionAssets(row!)).toMatchObject({ image: 'old-image', width: 2067, height: 609 });
    expect(await findVersion('two', 'v1')).toBeUndefined();
    const response = await list(new Request('https://test'), { params: Promise.resolve({ fileId: 'one' }) });
    expect((await response.json()).versions).toHaveLength(2);
  });
  it('deletes only the requested history, preserving active annotation, other versions and counter', async () => {
    expect(await deleteVersion('two', 'v1')).toBe(false);
    expect(await deleteVersion('one', 'v1')).toBe(true);
    expect(await deleteVersion('one', 'v1')).toBe(false);
    expect(await findVersion('one', 'v2')).toBeDefined();
    const db = await getDb();
    expect(await db.prepare("SELECT revision FROM annotations WHERE dataset_file_id = 'one'").get()).toMatchObject({ revision: 5 });
    expect(await db.prepare("SELECT latest_version_number FROM dataset_files WHERE id = 'one'").get()).toMatchObject({ latest_version_number: 4 });
  });
  it('activates exact historical polygons with their crop, snapshots current data, and rejects stale or locked changes', async () => {
    const db = await getDb();
    const old = '{ "humanAction":"MODIFIED", "custom":"preserve old raw JSON" }';
    const chosen = '{ "humanAction":"MODIFIED", "maskOperations":[{"type":"POLYGON_SET","polygons":[]}] }';
    await db.prepare('INSERT INTO annotations (dataset_file_id,revision,segmentation_json,breakpoints_json,last_edited_by) VALUES (?,?,?,?,?)').run('two',0,old,'{"custom":2}','admin');
    await db.prepare(`INSERT INTO annotation_versions (id,dataset_file_id,version_number,base_revision,segmentation_json,breakpoints_json,created_by,asset_snapshot_json)
      VALUES ('native','two',4,0,?,'{}','admin',?)`).run(chosen,JSON.stringify({image:'drive-native.jpg',prediction:'drive-native.png',width:8,height:6}));
    await expect(activateVersion('two','native','admin',1)).rejects.toMatchObject({status:409});
    const lock = await acquireLock('two','annotator');
    if (!lock || lock.denied) throw Error('Lock required');
    const denied = await activateVersion('two','native','admin',0).catch((error: Response) => error) as Response;
    expect(denied.status).toBe(409);
    expect((await denied.json()).message).toContain('Annotator');
    await releaseLock('two',lock.lockToken);
    // The ADMIN's own editor lock (e.g. another tab) does not block choosing the main version.
    const own = await acquireLock('two','admin');
    if (!own || own.denied) throw Error('Lock required');
    expect(await activateVersion('two','native','admin',0)).toEqual({revision:1,versionNumber:5,previousVersionNumber:5});
    expect(await db.prepare('SELECT 1 FROM file_locks WHERE dataset_file_id=?').get('two')).toBeUndefined();
    expect(await db.prepare('SELECT segmentation_json FROM annotations WHERE dataset_file_id=?').get('two')).toMatchObject({segmentation_json:chosen});
    expect(await db.prepare('SELECT image_drive_file_id,width,height FROM dataset_files WHERE id=?').get('two')).toMatchObject({image_drive_file_id:'drive-native.jpg',width:8,height:6});
    expect(await db.prepare('SELECT segmentation_json,breakpoints_json FROM annotation_versions WHERE dataset_file_id=? AND version_number=5').get('two')).toMatchObject({segmentation_json:old,breakpoints_json:'{"custom":2}'});
    expect(await findVersion('two','native')).toBeDefined();
    const response = await list(new Request('https://test'), { params: Promise.resolve({ fileId: 'two' }) });
    const body = await response.json();
    expect(body.versions.filter((v: { active: boolean }) => v.active).map((v: { id: string }) => v.id)).toEqual(['native']);
    expect(body.current).toEqual({ revision: 1, lockedBy: null });
  });

  it('shows every successful save as the newest main version, updated in place while the same user keeps saving', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: 'admin', displayName: 'Admin', role: 'ADMIN' });
    const history = async () => (await (await list(new Request('https://test'), { params: Promise.resolve({ fileId: 'one' }) })).json()).versions;
    const before = (await history()).length;
    const db = await getDb();
    // A PNG stored by an older client must stop being "the current mask" once new operations are saved.
    await db.prepare(`UPDATE annotations SET segmentation_json = '{"humanAction":"MODIFIED","maskStorageKey":"masks/old.png"}' WHERE dataset_file_id = 'one'`).run();
    const lock = await acquireLock('one', 'admin');
    if (!lock || lock.denied) throw Error('Lock required');
    const polygons = [{ id: 'p', label: 'w1', nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 4, y: 4 }] }];
    expect(await saveDraft('one', 'admin', lock.lockToken, 0, { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons }] }, {}))
      .toMatchObject({ revision: 1, versionNumber: 5 });
    const stored = await db.prepare("SELECT segmentation_json FROM annotations WHERE dataset_file_id = 'one'").get();
    expect(JSON.parse(String(stored!.segmentation_json)).maskStorageKey).toBeUndefined();
    let versions = await history();
    expect(versions).toHaveLength(before + 1);
    expect(versions[0]).toMatchObject({ versionNumber: 5, label: 'Bản lưu', active: true });

    expect(await saveDraft('one', 'admin', lock.lockToken, 1, { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: [] }] }, {}))
      .toMatchObject({ revision: 2, versionNumber: 5 });
    versions = await history();
    expect(versions).toHaveLength(before + 1);
    expect(versions[0]).toMatchObject({ versionNumber: 5, active: true });
    const saved = await findVersion('one', versions[0].id);
    expect(JSON.parse(String(saved!.segmentation_json)).maskOperations[0].polygons).toEqual([]);

    expect(await submitDone('one', 'admin', lock.lockToken, 2, { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons }] }, {}))
      .toMatchObject({ revision: 3, versionNumber: 5 });
    versions = await history();
    expect(versions).toHaveLength(before + 1);
    expect(versions[0]).toMatchObject({ versionNumber: 5, label: 'Hoàn tất', active: true });
  });
});
