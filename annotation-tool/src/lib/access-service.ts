import 'server-only';

import { requireAuth, type JWTPayload } from './auth';
import { getDb } from './db';

/**
 * Quyền theo phân công nhóm: ADMIN thấy mọi thứ, người dùng khác chỉ thấy ảnh thuộc nhóm được giao.
 * Vai trò đọc từ bảng users, không tin riêng role trong JWT (JWT sống 24 giờ sau khi bị đổi vai trò).
 * Các biểu thức được nhúng vào truy vấn sẵn có thay vì thêm một vòng truy vấn (~0.3s mỗi vòng tới Neon).
 */

const ADMIN_CHECK = `EXISTS (SELECT 1 FROM users access_user WHERE access_user.id = ? AND access_user.role = 'ADMIN')`;

/** Đúng khi tài khoản là ADMIN. Tham số: userId. */
export const ADMIN_ACCESS_SQL = ADMIN_CHECK;

/** Đúng khi tài khoản là ADMIN hoặc được giao nhóm chứa ảnh có alias `df`. Tham số: userId, userId. */
export const FILE_ACCESS_SQL = `(${ADMIN_CHECK} OR EXISTS (SELECT 1 FROM group_assignments access_ga
  WHERE access_ga.group_id = df.group_id AND access_ga.user_id = ?))`;

/** Đúng khi tài khoản là ADMIN hoặc được giao nhóm có alias `g`. Tham số: userId, userId. */
export const GROUP_ACCESS_SQL = `(${ADMIN_CHECK} OR EXISTS (SELECT 1 FROM group_assignments access_ga
  WHERE access_ga.group_id = g.id AND access_ga.user_id = ?))`;

export const FILE_ACCESS_DENIED_MESSAGE = 'Ảnh này không thuộc nhóm được giao cho bạn.';

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
