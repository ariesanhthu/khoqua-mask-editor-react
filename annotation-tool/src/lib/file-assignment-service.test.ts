import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Giao việc ở mức từng ảnh (người dùng yêu cầu 2026-11-24): quyền CỘNG THÊM vào phân công theo nhóm, mỗi ảnh tối
 * đa một người phụ trách, chỉ ảnh đã thuộc nhóm. Chạy route handler thật trên PGlite trong bộ nhớ; chỉ giả lập
 * người đang đăng nhập (như group-access.test.ts).
 */
const session = vi.hoisted(() => ({ user: { userId: 'admin', displayName: 'Admin', role: 'ADMIN' } }));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({ requireAuth: async () => session.user }));

import { getDb } from './db';
import { listGroups } from './group-service';
import { reviewAnnotation } from './annotation-service';
import { MAX_FILES_PER_ASSIGNMENT } from './file-assignment-service';
import { PUT as putFileAssignee } from '../app/api/projects/[projectId]/files/assignee/route';
import { GET as listProjects } from '../app/api/projects/route';
import { GET as listFiles } from '../app/api/projects/[projectId]/files/route';
import { GET as getGroups } from '../app/api/projects/[projectId]/groups/route';
import { POST as lockFile } from '../app/api/files/[fileId]/lock/route';
import { GET as editorBootstrap } from '../app/api/files/[fileId]/editor/route';

const as = (userId: string, role = 'ANNOTATOR') => { session.user = { userId, displayName: userId, role }; };
const request = (url: string, init?: RequestInit) => new Request(`https://test${url}`, init);
const projectParams = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const fileParams = (fileId: string) => ({ params: Promise.resolve({ fileId }) });
const assign = (body: unknown, projectId = 'p1') =>
  putFileAssignee(request('/x', { method: 'PUT', body: JSON.stringify(body) }), projectParams(projectId));
const files = async (url = '/api/projects/p1/files') =>
  ((await (await listFiles(request(url), projectParams('p1'))).json()) as { items: Array<{ id: string; assignment?: { userId: string } }> }).items;
const fileIds = async (url?: string) => (await files(url)).map((file) => file.id);
const assignmentRows = async (fileId: string) => {
  const db = await getDb();
  return db.prepare<{ user_id: string; assigned_by: string }>('SELECT user_id, assigned_by FROM assignments WHERE dataset_file_id = ?').all(fileId);
};

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'VERCEL', 'BOOTSTRAP_ADMIN_PASSWORD']) vi.stubEnv(key, '');
  vi.stubEnv('PGLITE_DATA_PATH', 'memory://');
  const db = await getDb();
  for (const [id, role] of [['admin', 'ADMIN'], ['an', 'ANNOTATOR'], ['binh', 'ANNOTATOR'], ['chi', 'ANNOTATOR'], ['rv', 'REVIEWER']]) {
    await db.prepare('INSERT INTO users (id, display_name, hashed_password, role) VALUES (?, ?, ?, ?)').run(id, `Tên ${id}`, 'test', role);
  }
  for (const project of ['p1', 'p2']) {
    await db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, '2026-11-24')").run(project, project);
    await db.prepare('INSERT INTO datasets (id, project_id, name) VALUES (?, ?, ?)').run(`d-${project}`, project, project);
  }
  await db.prepare("INSERT INTO file_groups (id, project_id, name) VALUES ('g1', 'p1', '8582'), ('g2', 'p1', 'DC3'), ('gp2', 'p2', 'VIN')").run();
  const rows = [
    ['f1', 'd-p1', '8582_01', 'g1', 'UNSTARTED'], ['f2', 'd-p1', '8582_02', 'g1', 'DRAFT'], ['f3', 'd-p1', '8582_03', 'g1', 'REVIEW'],
    ['f4', 'd-p1', 'DC3_01', 'g2', 'UNSTARTED'], ['f5', 'd-p1', 'loose', null, 'UNSTARTED'], ['f6', 'd-p2', 'VIN_01', 'gp2', 'UNSTARTED'],
  ];
  for (const [id, dataset, key, group, state] of rows) {
    await db.prepare(`INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id,
      image_filename, prediction_filename, width, height, group_id, annotation_state, latest_revision)
      VALUES (?, ?, ?, 'image', 'mask', 'image.png', 'mask.png', 8, 6, ?, ?, ?)`).run(id, dataset, key, group, state, state === 'REVIEW' ? 2 : 0);
  }
  await db.prepare(`INSERT INTO annotations (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by)
    VALUES ('f3', 2, 'REVIEW', '{"humanAction":"MODIFIED","maskOperations":[]}', '{"state":"NOT_ANNOTATED","points":[]}', 'binh')`).run();
  // binh được giao cả nhóm g1 như trước; an, chi, rv chưa được giao gì.
  await db.prepare("INSERT INTO group_assignments (group_id, user_id) VALUES ('g1', 'binh')").run();
}, 30_000);

describe('giao riêng từng ảnh', () => {
  it('người chưa được giao gì không thấy dự án/nhóm/ảnh nào', async () => {
    as('an');
    expect(await (await listProjects(request('/api/projects'))).json()).toEqual([]);
    expect(await fileIds()).toEqual([]);
  });

  it('ADMIN giao một ảnh: người được giao thấy dự án, nhóm (chỉ đếm ảnh của mình) và đúng ảnh đó', async () => {
    as('admin', 'ADMIN');
    const response = await assign({ fileIds: ['f2'], userId: 'an' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 1, assignee: { userId: 'an', displayName: 'Tên an' } });
    expect(await assignmentRows('f2')).toEqual([{ user_id: 'an', assigned_by: 'admin' }]);

    as('an');
    expect(((await (await listProjects(request('/api/projects'))).json()) as Array<{ id: string }>).map((project) => project.id)).toEqual(['p1']);
    expect(await fileIds()).toEqual(['f2']);
    expect(await fileIds('/api/projects/p1/files?groupId=g1')).toEqual(['f2']);
    const groups = await (await getGroups(request('/api/projects/p1/groups'), projectParams('p1'))).json();
    expect(groups).toEqual({ ungrouped: 0, groups: [
      { id: 'g1', name: '8582', total: 1, unstarted: 0, draft: 1, review: 0, done: 0, locked: 0, assignees: [] },
    ] });
  });

  it('mở/xin khóa được đúng ảnh được giao, ảnh khác cùng nhóm vẫn bị từ chối', async () => {
    as('an');
    expect((await editorBootstrap(request('/api/files/f2/editor'), fileParams('f2'))).status).toBe(200);
    expect((await lockFile(request('/api/files/f2/lock', { method: 'POST' }), fileParams('f2'))).status).toBe(200);
    const denied = await editorBootstrap(request('/api/files/f1/editor'), fileParams('f1'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect((await lockFile(request('/api/files/f1/lock', { method: 'POST' }), fileParams('f1'))).status).toBe(403);
  });

  it('cộng thêm: người được giao cả nhóm vẫn thấy đủ nhóm, số liệu của họ và của ADMIN không đổi', async () => {
    as('binh');
    expect(await fileIds()).toEqual(['f1', 'f2', 'f3']);
    expect((await files()).find((file) => file.id === 'f2')?.assignment).toEqual({ userId: 'an', displayName: 'Tên an' });
    const own = await listGroups('p1', 'binh');
    expect(own?.groups.map((group) => [group.id, group.total])).toEqual([['g1', 3]]);
    const all = await listGroups('p1', 'admin');
    expect(all?.groups.map((group) => [group.id, group.total, group.draft, group.review])).toEqual([['g1', 3, 1, 1], ['g2', 1, 0, 0]]);
    expect(all?.ungrouped).toBe(1);
  });

  it('giao lại thay người cũ (một người mỗi ảnh); bỏ giao thu hồi quyền ở lần mở sau', async () => {
    as('admin', 'ADMIN');
    expect(await (await assign({ fileIds: ['f2', 'f2', 'f1'], userId: 'chi' })).json()).toEqual({ updated: 2, assignee: { userId: 'chi', displayName: 'Tên chi' } });
    expect(await assignmentRows('f2')).toEqual([{ user_id: 'chi', assigned_by: 'admin' }]);
    as('an');
    expect(await fileIds()).toEqual([]);
    expect((await editorBootstrap(request('/api/files/f2/editor'), fileParams('f2'))).status).toBe(403);
    as('chi');
    expect(await fileIds()).toEqual(['f1', 'f2']);

    as('admin', 'ADMIN');
    expect(await (await assign({ fileIds: ['f1', 'f2'], userId: null })).json()).toEqual({ updated: 2, assignee: null });
    expect(await assignmentRows('f1')).toEqual([]);
    as('chi');
    expect(await fileIds()).toEqual([]);
    expect(await (await listProjects(request('/api/projects'))).json()).toEqual([]);
  });

  it('người duyệt được giao riêng ảnh chờ duyệt thì kết luận được ảnh đó', async () => {
    expect(await reviewAnnotation('f3', 'rv', 'APPROVE', 2)).toEqual({ error: 'FORBIDDEN' });
    as('admin', 'ADMIN');
    await assign({ fileIds: ['f3'], userId: 'rv' });
    expect(await reviewAnnotation('f3', 'rv', 'APPROVE', 2)).toEqual({ annotationState: 'DONE', revision: 2 });
  });
});

describe('bỏ giao và chọn ảnh tiếp theo', () => {
  it('bỏ giao lô hỗn hợp chỉ đếm ảnh thực sự có người phụ trách, gọi lại trả về 0', async () => {
    as('admin', 'ADMIN');
    await assign({ fileIds: ['f1'], userId: 'chi' });
    const clear = () => assign({ fileIds: ['f1', 'f2'], userId: null });
    expect(await (await clear()).json()).toEqual({ updated: 1, assignee: null });
    expect(await (await clear()).json()).toEqual({ updated: 0, assignee: null });
    as('binh');
    expect(await fileIds()).toContain('f1'); // Quyền theo nhóm vẫn còn.
  });

  it('lọc người phụ trách trước khi phân trang và ưu tiên ảnh đã giao cho mình', async () => {
    as('admin', 'ADMIN');
    await assign({ fileIds: ['f1'], userId: 'chi' });
    await assign({ fileIds: ['f2'], userId: 'binh' });
    as('binh');
    const next = '/api/projects/p1/files?groupId=g1&assignedTo=next&pageSize=1';
    expect(await fileIds(next)).toEqual(['f2']);
    as('admin', 'ADMIN');
    await assign({ fileIds: ['f1', 'f2'], userId: null });
  });
});

describe('từ chối giao không hợp lệ, không ghi gì', () => {
  it('ảnh chưa thuộc nhóm bị từ chối, kể cả khi lẫn với ảnh hợp lệ (cả lô không ghi)', async () => {
    as('admin', 'ADMIN');
    const response = await assign({ fileIds: ['f4', 'f5'], userId: 'an' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_DATASET' });
    expect(await assignmentRows('f4')).toEqual([]);
  });

  it('ADMIN gỡ được phân công cũ của ảnh chưa phân nhóm', async () => {
    const db = await getDb();
    await db.prepare("INSERT INTO assignments (id, dataset_file_id, user_id) VALUES ('legacy', 'f5', 'chi')").run();
    as('chi');
    expect(await fileIds()).not.toContain('f5');
    expect(await (await listProjects(request('/api/projects'))).json()).toEqual([]);
    as('admin', 'ADMIN');
    expect(await (await assign({ fileIds: ['f5'], userId: null })).json()).toEqual({ updated: 1, assignee: null });
    expect(await assignmentRows('f5')).toEqual([]);
  });

  it('ảnh của dự án khác hoặc không tồn tại → 404; tài khoản lạ, body sai, quá nhiều ảnh → 400', async () => {
    as('admin', 'ADMIN');
    expect((await assign({ fileIds: ['f6'], userId: 'an' })).status).toBe(404);
    expect((await assign({ fileIds: ['missing'], userId: 'an' })).status).toBe(404);
    expect((await assign({ fileIds: ['f4'], userId: 'ghost' })).status).toBe(400);
    expect((await assign({ fileIds: [], userId: 'an' })).status).toBe(400);
    expect((await assign({ fileIds: 'f4', userId: 'an' })).status).toBe(400);
    expect((await assign({ fileIds: ['f4'] })).status).toBe(400);
    expect((await assign({ fileIds: ['f4'], userId: 7 })).status).toBe(400);
    const tooMany = Array.from({ length: MAX_FILES_PER_ASSIGNMENT + 1 }, (_, index) => `x${index}`);
    expect((await assign({ fileIds: tooMany, userId: 'an' })).status).toBe(400);
    expect(await assignmentRows('f4')).toEqual([]);
  });

  it('chỉ ADMIN theo vai trò trong DB (role trong token không đủ)', async () => {
    as('an', 'ADMIN');
    expect((await assign({ fileIds: ['f4'], userId: 'an' })).status).toBe(403);
    as('binh');
    expect((await assign({ fileIds: ['f1'], userId: 'binh' })).status).toBe(403);
    expect(await assignmentRows('f4')).toEqual([]);
  });
});
