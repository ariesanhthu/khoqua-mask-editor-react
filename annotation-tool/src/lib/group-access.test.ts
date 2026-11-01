import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Phân công theo nhóm: người không phải ADMIN chỉ thấy và chỉ mở được ảnh thuộc nhóm được giao.
 * Chạy route handler thật trên PGlite trong bộ nhớ; chỉ giả lập người đang đăng nhập.
 */
const session = vi.hoisted(() => ({ user: { userId: 'admin', displayName: 'Admin', role: 'ADMIN' } }));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: async () => session.user }));

import { getDb } from './db';
import { autoGroupProject, listGroups } from './group-service';
import { GET as listProjects } from '../app/api/projects/route';
import { GET as listFiles } from '../app/api/projects/[projectId]/files/route';
import { GET as getGroups } from '../app/api/projects/[projectId]/groups/route';
import { PUT as putAssignees } from '../app/api/projects/[projectId]/groups/[groupId]/assignees/route';
import { POST as autoGroup } from '../app/api/projects/[projectId]/groups/auto/route';
import { POST as lockFile } from '../app/api/files/[fileId]/lock/route';
import { GET as editorBootstrap } from '../app/api/files/[fileId]/editor/route';

const as = (userId: string, role = 'ANNOTATOR') => { session.user = { userId, displayName: userId, role }; };
const request = (url: string, init?: RequestInit) => new Request(`https://test${url}`, init);
const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const fileParams = (fileId: string) => ({ params: Promise.resolve({ fileId }) });
const fileKeys = async (url: string) => ((await (await listFiles(request(url), projectParams('p1'))).json()) as { items: Array<{ externalKey: string }> })
  .items.map((item) => item.externalKey);

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  for (const [id, role] of [['admin', 'ADMIN'], ['an', 'ANNOTATOR'], ['binh', 'ANNOTATOR'], ['reviewer', 'REVIEWER']]) {
    await db.prepare('INSERT INTO users (id, display_name, hashed_password, role) VALUES (?, ?, ?, ?)').run(id, id, 'test', role);
  }
  for (const project of ['p1', 'p2']) {
    await db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, '2026-10-25')").run(project, project);
    await db.prepare('INSERT INTO datasets (id, project_id, name) VALUES (?, ?, ?)').run(`d-${project}`, project, project);
  }
  await db.prepare("INSERT INTO file_groups (id, project_id, name) VALUES ('g8582', 'p1', '8582'), ('gdc3', 'p1', 'DC3'), ('gp2', 'p2', 'VIN005')").run();
  const files = [
    ['f1', 'd-p1', '8582_01', 'g8582', 'UNSTARTED'], ['f2', 'd-p1', '8582_02', 'g8582', 'DRAFT'], ['f3', 'd-p1', '8582_10', 'g8582', 'DONE'],
    ['f4', 'd-p1', 'DC3_01', 'gdc3', 'UNSTARTED'],
    ['f5', 'd-p1', 'Draco_01', null, 'UNSTARTED'], ['f6', 'd-p1', 'Draco_02', null, 'UNSTARTED'], ['f7', 'd-p1', 'loose', null, 'UNSTARTED'],
    ['f8', 'd-p2', 'VIN005_01', 'gp2', 'UNSTARTED'],
  ];
  for (const [id, dataset, key, group, state] of files) {
    await db.prepare(`INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id,
      image_filename, prediction_filename, width, height, group_id, annotation_state)
      VALUES (?, ?, ?, 'image', 'mask', 'image.png', 'mask.png', 8, 6, ?, ?)`).run(id, dataset, key, group, state);
  }
  await db.prepare("INSERT INTO group_assignments (group_id, user_id) VALUES ('g8582', 'an')").run();
}, 30_000);

describe('what a labeler can see', () => {
  it('lists only projects with a group assigned to the user; ADMIN sees every project', async () => {
    as('an');
    expect(((await (await listProjects(request('/api/projects'))).json()) as Array<{ id: string }>).map((p) => p.id)).toEqual(['p1']);
    as('binh');
    expect(await (await listProjects(request('/api/projects'))).json()).toEqual([]);
    as('admin', 'ADMIN');
    expect(((await (await listProjects(request('/api/projects'))).json()) as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('returns only assigned groups with progress, without assignees or ungrouped images', async () => {
    as('an');
    const body = await (await getGroups(request('/api/projects/p1/groups'), projectParams('p1'))).json();
    expect(body).toEqual({ ungrouped: 0, groups: [
      { id: 'g8582', name: '8582', total: 3, unstarted: 1, draft: 1, done: 1, locked: 0, assignees: [] },
    ] });
  });

  it('gives ADMIN every group, the assignees and the ungrouped count', async () => {
    as('admin', 'ADMIN');
    const body = await listGroups('p1', 'admin');
    expect(body?.ungrouped).toBe(3);
    expect(body?.groups.map((group) => [group.name, group.total, group.assignees.map((user) => user.userId)])).toEqual([
      ['8582', 3, ['an']], ['DC3', 1, []],
    ]);
    expect(await listGroups('missing', 'admin')).toBeNull();
  });

  it('filters the file list by assignment, group and several states at once', async () => {
    as('an');
    expect(await fileKeys('/api/projects/p1/files')).toEqual(['8582_01', '8582_02', '8582_10']);
    expect(await fileKeys('/api/projects/p1/files?groupId=gdc3')).toEqual([]);
    expect(await fileKeys('/api/projects/p1/files?groupId=ungrouped')).toEqual([]);
    expect(await fileKeys('/api/projects/p1/files?annotationState=UNSTARTED,DRAFT')).toEqual(['8582_01', '8582_02']);
    expect(await fileKeys('/api/projects/p1/files?annotationState=DONE')).toEqual(['8582_10']);
    as('reviewer', 'REVIEWER');
    expect(await fileKeys('/api/projects/p1/files')).toEqual([]);
    as('admin', 'ADMIN');
    expect(await fileKeys('/api/projects/p1/files?groupId=ungrouped')).toEqual(['Draco_01', 'Draco_02', 'loose']);
    const all = await (await listFiles(request('/api/projects/p1/files?groupId=g8582&pageSize=1'), projectParams('p1'))).json();
    expect(all).toMatchObject({ total: 3, items: [{ externalKey: '8582_01', group: { id: 'g8582', name: '8582' } }] });
  });

  it('trusts the role stored in the database, not the one in the token', async () => {
    as('an', 'ADMIN');
    expect(await fileKeys('/api/projects/p1/files?groupId=gdc3')).toEqual([]);
    const response = await putAssignees(request('/x', { method: 'PUT', body: JSON.stringify({ userIds: ['an'] }) }),
      { params: Promise.resolve({ projectId: 'p1', groupId: 'gdc3' }) });
    expect(response.status).toBe(403);
  });
});

describe('opening an image outside the assigned groups', () => {
  it('refuses the edit lock and the editor bootstrap but allows assigned images', async () => {
    as('an');
    expect((await lockFile(request('/api/files/f4/lock', { method: 'POST' }), fileParams('f4'))).status).toBe(403);
    const denied = await editorBootstrap(request('/api/files/f4/editor'), fileParams('f4'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    const lock = await lockFile(request('/api/files/f1/lock', { method: 'POST' }), fileParams('f1'));
    expect(lock.status).toBe(200);
    const { lockToken } = await lock.json() as { lockToken: string };
    const bootstrap = await editorBootstrap(request('/api/files/f1/editor', { headers: { 'X-Annotation-Lock-Token': lockToken } }), fileParams('f1'));
    expect(await bootstrap.json()).toMatchObject({ readOnly: false, file: { externalKey: '8582_01' } });
    expect((await lockFile(request('/api/files/missing/lock', { method: 'POST' }), fileParams('missing'))).status).toBe(404);
  });

  it('lets ADMIN open any image, including ungrouped ones', async () => {
    as('admin', 'ADMIN');
    expect((await editorBootstrap(request('/api/files/f7/editor'), fileParams('f7'))).status).toBe(200);
  });
});

describe('assigning groups', () => {
  const put = (groupId: string, userIds: unknown) => putAssignees(
    request('/x', { method: 'PUT', body: JSON.stringify({ userIds }) }),
    { params: Promise.resolve({ projectId: 'p1', groupId }) },
  );

  it('replaces the assignee list and immediately changes what the labeler sees', async () => {
    as('admin', 'ADMIN');
    const response = await put('gdc3', ['binh', 'an', 'binh']);
    expect(await response.json()).toEqual({ assignees: [{ userId: 'an', displayName: 'an' }, { userId: 'binh', displayName: 'binh' }] });
    as('binh');
    expect(await fileKeys('/api/projects/p1/files')).toEqual(['DC3_01']);
    as('admin', 'ADMIN');
    await put('gdc3', []);
    as('binh');
    expect(await fileKeys('/api/projects/p1/files')).toEqual([]);
  });

  it('rejects unknown users, groups of another project and malformed bodies', async () => {
    as('admin', 'ADMIN');
    expect((await put('gdc3', ['ghost'])).status).toBe(400);
    expect((await put('gp2', ['an'])).status).toBe(404);
    expect((await put('gdc3', 'an')).status).toBe(400);
    as('an');
    expect((await put('gdc3', ['an'])).status).toBe(403);
  });
});

describe('automatic grouping of existing images', () => {
  it('groups ungrouped images by name prefix only, once, without touching grouped images', async () => {
    as('an');
    expect((await autoGroup(request('/x', { method: 'POST' }), projectParams('p1'))).status).toBe(403);
    as('admin', 'ADMIN');
    const db = await getDb();
    const before = await db.prepare("SELECT updated_at FROM dataset_files WHERE id = 'f5'").get();
    const response = await autoGroup(request('/x', { method: 'POST' }), projectParams('p1'));
    expect(await response.json()).toEqual({ groupsCreated: 1, filesGrouped: 2, skipped: 1 });
    const rows = await db.prepare(`SELECT df.id, g.name FROM dataset_files df LEFT JOIN file_groups g ON g.id = df.group_id
      WHERE df.id IN ('f1', 'f4', 'f5', 'f6', 'f7') ORDER BY df.id`).all();
    expect(rows.map((row) => [row.id, row.name])).toEqual([['f1', '8582'], ['f4', 'DC3'], ['f5', 'Draco'], ['f6', 'Draco'], ['f7', null]]);
    expect(await db.prepare("SELECT updated_at FROM dataset_files WHERE id = 'f5'").get()).toEqual(before);
    expect(await autoGroupProject('p1')).toEqual({ groupsCreated: 0, filesGrouped: 0, skipped: 1 });
    expect((await autoGroup(request('/x', { method: 'POST' }), projectParams('missing'))).status).toBe(404);
  });
});
