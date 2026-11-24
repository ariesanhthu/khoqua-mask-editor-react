import 'server-only';

import { generateId, getDb, nowISO } from './db';

/**
 * Giao việc ở mức TỪNG ẢNH (người dùng yêu cầu 2026-11-24), bên cạnh phân công theo nhóm. Dùng bảng `assignments`
 * có sẵn từ đầu (không đổi schema). Quyền xem cộng thêm qua `FILE_ACCESS_SQL`/`GROUP_ACCESS_SQL` (access-service).
 *
 * Quy ước phân công (docs/GROUPS_AND_IMPORT.md):
 * - Mỗi ảnh tối đa MỘT người phụ trách: giao lại thay người cũ; `userId: null` bỏ giao riêng.
 * - Chỉ ảnh đã thuộc nhóm: Home của người gán nhãn tổ chức theo nhóm, ảnh chưa phân nhóm không có chỗ hiển thị.
 * - Không đổi `dataset_files.updated_at` (khóa cache ảnh/thumbnail) và không cắt phiên đang sửa (như phân công nhóm).
 */

export const MAX_FILES_PER_ASSIGNMENT = 500;
/** Số hàng mỗi câu INSERT: một vòng tới Neon cho cả lô thay vì một vòng mỗi ảnh. */
const INSERT_BATCH = 200;

export class FileAssignmentError extends Error {
  constructor(message: string, readonly status: 400 | 404) { super(message); }
}

export interface FileAssignmentResult {
  updated: number;
  assignee: { userId: string; displayName: string } | null;
}

export async function setFileAssignee(projectId: string, fileIds: unknown, userId: unknown, assignedBy: string): Promise<FileAssignmentResult> {
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.some((id) => typeof id !== 'string' || !id)) {
    throw new FileAssignmentError('Danh sách ảnh không hợp lệ.', 400);
  }
  const unique = [...new Set(fileIds as string[])];
  if (unique.length > MAX_FILES_PER_ASSIGNMENT) {
    throw new FileAssignmentError(`Mỗi lần giao tối đa ${MAX_FILES_PER_ASSIGNMENT} ảnh.`, 400);
  }
  if (userId !== null && (typeof userId !== 'string' || !userId)) {
    throw new FileAssignmentError('Người được giao không hợp lệ.', 400);
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const placeholders = unique.map(() => '?').join(', ');
    // Khóa hàng ảnh trước (cùng thứ tự với lock-service): hai lần giao đồng thời không để lại hai người phụ trách.
    const rows = await tx.prepare<{ id: string; group_id: string | null }>(`SELECT df.id, df.group_id FROM dataset_files df
      JOIN datasets d ON d.id = df.dataset_id
      WHERE d.project_id = ? AND df.id IN (${placeholders}) ORDER BY df.id FOR UPDATE OF df`).all(projectId, ...unique);
    if (rows.length !== unique.length) throw new FileAssignmentError('Có ảnh không thuộc dự án này.', 404);
    if (userId !== null && rows.some((row) => !row.group_id)) {
      throw new FileAssignmentError('Chỉ giao riêng được ảnh đã thuộc nhóm. Hãy chia nhóm cho ảnh trước.', 400);
    }

    if (userId === null) {
      const removed = await tx.prepare<{ dataset_file_id: string }>(
        `DELETE FROM assignments WHERE dataset_file_id IN (${placeholders}) RETURNING dataset_file_id`,
      ).all(...unique);
      return { updated: new Set(removed.map((row) => row.dataset_file_id)).size, assignee: null };
    }

    const user = await tx.prepare<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users WHERE id = ?',
    ).get(userId);
    if (!user) throw new FileAssignmentError('Tài khoản không tồn tại.', 400);

    await tx.prepare(`DELETE FROM assignments WHERE dataset_file_id IN (${placeholders})`).run(...unique);
    const now = nowISO();
    for (let start = 0; start < unique.length; start += INSERT_BATCH) {
      const batch = unique.slice(start, start + INSERT_BATCH);
      await tx.prepare(`INSERT INTO assignments (id, dataset_file_id, user_id, assigned_by, created_at)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
        .run(...batch.flatMap((fileId) => [generateId(), fileId, user.id, assignedBy, now]));
    }
    return { updated: unique.length, assignee: { userId: user.id, displayName: user.display_name } };
  });
}
