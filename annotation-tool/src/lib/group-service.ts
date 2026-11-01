import 'server-only';

import type { FileGroupList, FileGroupSummary } from '@/types';
import { ADMIN_ACCESS_SQL, GROUP_ACCESS_SQL } from './access-service';
import { generateId, getDb, nowISO, type AppDatabase } from './db';
import { inferGroupName, isValidGroupName, normalizeGroupName } from './file-groups';

const MAX_ASSIGNEES = 500;
const UPDATE_BATCH = 500;

/** Tìm hoặc tạo nhóm theo tên trong dự án; an toàn khi hai request cùng tạo một tên. */
export async function ensureGroup(db: AppDatabase, projectId: string, name: string): Promise<{ id: string; name: string; created: boolean }> {
  const normalized = normalizeGroupName(name);
  if (!isValidGroupName(normalized)) throw new Error(`Tên nhóm "${name}" không hợp lệ.`);
  const now = nowISO();
  const inserted = await db.prepare(`INSERT INTO file_groups (id, project_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, name) DO NOTHING`).run(generateId(), projectId, normalized, now, now);
  const row = await db.prepare<{ id: string }>('SELECT id FROM file_groups WHERE project_id = ? AND name = ?').get(projectId, normalized);
  if (!row) throw new Error('Không tạo được nhóm.');
  return { id: row.id, name: normalized, created: inserted.changes > 0 };
}

/**
 * Nhóm của dự án kèm tiến độ. Người không phải ADMIN chỉ nhận nhóm được giao, không có danh sách
 * người được giao và không thấy ảnh chưa phân nhóm. Null khi dự án không tồn tại.
 */
export async function listGroups(projectId: string, userId: string): Promise<FileGroupList | null> {
  const db = await getDb();
  const now = nowISO();
  const [project, rows, ungrouped, assignees] = await Promise.all([
    db.prepare<{ id: string }>('SELECT id FROM projects WHERE id = ?').get(projectId),
    db.prepare(`SELECT g.id, g.name,
        COUNT(df.id) AS total,
        COUNT(CASE WHEN df.annotation_state = 'UNSTARTED' THEN 1 END) AS unstarted,
        COUNT(CASE WHEN df.annotation_state = 'DRAFT' THEN 1 END) AS draft,
        COUNT(CASE WHEN df.annotation_state = 'DONE' THEN 1 END) AS done,
        COUNT(CASE WHEN fl.expires_at > ? THEN 1 END) AS locked
      FROM file_groups g
      LEFT JOIN dataset_files df ON df.group_id = g.id
      LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
      WHERE g.project_id = ? AND ${GROUP_ACCESS_SQL}
      GROUP BY g.id, g.name
      ORDER BY g.name`).all(now, projectId, userId, userId),
    db.prepare<{ total: number | string }>(`SELECT COUNT(*) AS total FROM dataset_files df
      JOIN datasets d ON d.id = df.dataset_id
      WHERE d.project_id = ? AND df.group_id IS NULL AND ${ADMIN_ACCESS_SQL}`).get(projectId, userId),
    db.prepare<{ group_id: string; user_id: string; display_name: string }>(`SELECT ga.group_id, u.id AS user_id, u.display_name
      FROM group_assignments ga
      JOIN file_groups g ON g.id = ga.group_id
      JOIN users u ON u.id = ga.user_id
      WHERE g.project_id = ? AND ${ADMIN_ACCESS_SQL}
      ORDER BY u.display_name`).all(projectId, userId),
  ]);
  if (!project) return null;
  const byGroup = new Map<string, FileGroupSummary['assignees']>();
  for (const row of assignees) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push({ userId: row.user_id, displayName: row.display_name });
    byGroup.set(row.group_id, list);
  }
  const groups = rows.map((row): FileGroupSummary => ({
    id: String(row.id),
    name: String(row.name),
    total: Number(row.total),
    unstarted: Number(row.unstarted),
    draft: Number(row.draft),
    done: Number(row.done),
    locked: Number(row.locked),
    assignees: byGroup.get(String(row.id)) ?? [],
  }));
  // Tên giống thường có số (8582, TVI8573…): sắp theo số tự nhiên thay vì thứ tự chuỗi của SQL.
  groups.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  return { groups, ungrouped: Number(ungrouped?.total || 0) };
}

export class GroupServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Thay toàn bộ danh sách người được giao một nhóm. */
export async function setGroupAssignees(projectId: string, groupId: string, userIds: unknown, assignedBy: string) {
  if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== 'string' || !id)) {
    throw new GroupServiceError('Danh sách người được giao không hợp lệ.', 400);
  }
  const unique = [...new Set(userIds as string[])];
  if (unique.length > MAX_ASSIGNEES) throw new GroupServiceError('Quá nhiều người được giao cho một nhóm.', 400);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const group = await tx.prepare('SELECT id FROM file_groups WHERE id = ? AND project_id = ? FOR UPDATE').get(groupId, projectId);
    if (!group) throw new GroupServiceError('Không tìm thấy nhóm.', 404);
    const users = unique.length
      ? await tx.prepare<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`).all(...unique)
      : [];
    if (users.length !== unique.length) throw new GroupServiceError('Có tài khoản không tồn tại.', 400);
    await tx.prepare('DELETE FROM group_assignments WHERE group_id = ?').run(groupId);
    const now = nowISO();
    for (const user of users) {
      await tx.prepare('INSERT INTO group_assignments (group_id, user_id, assigned_by, created_at) VALUES (?, ?, ?, ?)')
        .run(groupId, user.id, assignedBy, now);
    }
    await tx.prepare('UPDATE file_groups SET updated_at = ? WHERE id = ?').run(now, groupId);
    return {
      assignees: users
        .map((user) => ({ userId: user.id, displayName: user.display_name }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi')),
    };
  });
}

/**
 * Xếp các ảnh chưa phân nhóm vào nhóm theo tiền tố tên (`8582_01` → `8582`). Không đổi ảnh đã có nhóm,
 * không đổi `updated_at` của ảnh (khóa cache ảnh/thumbnail). Ảnh không đoán được tên giữ nguyên.
 */
export async function autoGroupProject(projectId: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const project = await tx.prepare('SELECT id FROM projects WHERE id = ? FOR UPDATE').get(projectId);
    if (!project) throw new GroupServiceError('Không tìm thấy dự án.', 404);
    const files = await tx.prepare<{ id: string; external_key: string }>(`SELECT df.id, df.external_key FROM dataset_files df
      JOIN datasets d ON d.id = df.dataset_id
      WHERE d.project_id = ? AND df.group_id IS NULL`).all(projectId);
    const byName = new Map<string, string[]>();
    let skipped = 0;
    for (const file of files) {
      const name = inferGroupName(file.external_key);
      if (!name || !isValidGroupName(name)) { skipped += 1; continue; }
      const normalized = normalizeGroupName(name);
      byName.set(normalized, [...(byName.get(normalized) ?? []), file.id]);
    }
    let groupsCreated = 0;
    let filesGrouped = 0;
    for (const [name, ids] of byName) {
      const group = await ensureGroup(tx, projectId, name);
      if (group.created) groupsCreated += 1;
      for (let start = 0; start < ids.length; start += UPDATE_BATCH) {
        const batch = ids.slice(start, start + UPDATE_BATCH);
        const result = await tx.prepare(`UPDATE dataset_files SET group_id = ?
          WHERE group_id IS NULL AND id IN (${batch.map(() => '?').join(', ')})`).run(group.id, ...batch);
        filesGrouped += result.changes;
      }
    }
    return { groupsCreated, filesGrouped, skipped };
  });
}
