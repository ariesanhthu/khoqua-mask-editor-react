import 'server-only';

import { requireAuth, type JWTPayload } from './auth';
import { getDb } from './db';

/**
 * Quyền theo phân công: ADMIN thấy mọi thứ; người dùng khác thấy ảnh thuộc nhóm được giao (2026-10-25) và ảnh
 * được giao riêng cho mình trong bảng `assignments` (2026-11-24, người dùng yêu cầu giao việc ở mức từng ảnh).
 * Hai cách giao là CỘNG THÊM: giao riêng không thu hẹp quyền của người đã được giao cả nhóm.
 * Vai trò đọc từ bảng users, không tin riêng role trong JWT (JWT sống 24 giờ sau khi bị đổi vai trò).
 * Các biểu thức được nhúng vào truy vấn sẵn có thay vì thêm một vòng truy vấn (~0.3s mỗi vòng tới Neon).
 *
 * Mọi biểu thức nhận đúng HAI tham số (userId, userId) như trước 2026-11-24: lần thứ hai đọc một hàng `users`
 * theo khóa chính (`access_self`) để dùng userId nhiều lần mà không đổi chỗ gọi.
 */

const ADMIN_CHECK = `EXISTS (SELECT 1 FROM users access_user WHERE access_user.id = ? AND access_user.role = 'ADMIN')`;
const ASSIGNED_TO_SELF = (condition: string) =>
  `EXISTS (SELECT 1 FROM users access_self WHERE access_self.id = ? AND (${condition}))`;

/** Đúng khi tài khoản là ADMIN. Tham số: userId. */
export const ADMIN_ACCESS_SQL = ADMIN_CHECK;

/** Đúng khi tài khoản là ADMIN, được giao nhóm chứa ảnh có alias `df`, hoặc được giao riêng ảnh đó. Tham số: userId, userId. */
export const FILE_ACCESS_SQL = `(${ADMIN_CHECK} OR ${ASSIGNED_TO_SELF(`
  EXISTS (SELECT 1 FROM group_assignments access_ga
    WHERE access_ga.group_id = df.group_id AND access_ga.user_id = access_self.id)
  OR EXISTS (SELECT 1 FROM assignments access_fa
    WHERE df.group_id IS NOT NULL AND access_fa.dataset_file_id = df.id AND access_fa.user_id = access_self.id)`)})`;

/** Đúng khi tài khoản là ADMIN, được giao nhóm có alias `g`, hoặc được giao riêng một ảnh của nhóm đó. Tham số: userId, userId. */
export const GROUP_ACCESS_SQL = `(${ADMIN_CHECK} OR ${ASSIGNED_TO_SELF(`
  EXISTS (SELECT 1 FROM group_assignments access_ga
    WHERE access_ga.group_id = g.id AND access_ga.user_id = access_self.id)
  OR EXISTS (SELECT 1 FROM assignments access_fa JOIN dataset_files access_df ON access_df.id = access_fa.dataset_file_id
    WHERE access_df.group_id = g.id AND access_fa.user_id = access_self.id)`)})`;

/** Đúng khi tài khoản là ADMIN, có nhóm được giao, hoặc có ảnh được giao riêng trong dự án có alias `p`. Tham số: userId, userId. */
export const PROJECT_ACCESS_SQL = `(${ADMIN_CHECK} OR ${ASSIGNED_TO_SELF(`
  EXISTS (SELECT 1 FROM file_groups access_g JOIN group_assignments access_ga ON access_ga.group_id = access_g.id
    WHERE access_g.project_id = p.id AND access_ga.user_id = access_self.id)
  OR EXISTS (SELECT 1 FROM assignments access_fa JOIN dataset_files access_df ON access_df.id = access_fa.dataset_file_id
    JOIN datasets access_d ON access_d.id = access_df.dataset_id
    WHERE access_d.project_id = p.id AND access_df.group_id IS NOT NULL AND access_fa.user_id = access_self.id)`)})`;

export const FILE_ACCESS_DENIED_MESSAGE = 'Ảnh này không thuộc nhóm hoặc danh sách ảnh được giao cho bạn.';

export async function isAdminAccount(userId: string): Promise<boolean> {
  const db = await getDb();
  const account = await db.prepare<{ role: string }>('SELECT role FROM users WHERE id = ?').get(userId);
  return account?.role === 'ADMIN';
}

/** Ném Response 403 (route bắt bằng `if (error instanceof Response) return error`). */
export async function requireAdminAccount(request: Request): Promise<JWTPayload> {
  const user = await requireAuth(request);
  if (!(await isAdminAccount(user.userId))) {
    throw Response.json({ code: 'FORBIDDEN', message: 'Chỉ quản trị viên được thực hiện thao tác này.' }, { status: 403 });
  }
  return user;
}
