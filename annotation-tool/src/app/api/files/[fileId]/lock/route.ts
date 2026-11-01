import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { acquireLock, releaseLock, validateLockToken } from '@/lib/lock-service';
import { getDb } from '@/lib/db';
import { FILE_ACCESS_DENIED_MESSAGE, FILE_ACCESS_SQL } from '@/lib/access-service';

/**
 * POST /api/files/[fileId]/lock — Acquire lock (spec 03 §3)
 * Chỉ người được giao nhóm của ảnh (hoặc ADMIN) mới nhận khóa sửa. Heartbeat, lưu và Hoàn tất
 * không kiểm tra lại phân công để bỏ giao giữa chừng không làm mất bản đang sửa.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const db = await getDb();
  const file = await db.prepare<{ asset_state: string; can_access: boolean }>(
    `SELECT df.asset_state, ${FILE_ACCESS_SQL} AS can_access FROM dataset_files df WHERE df.id = ?`,
  ).get(user.userId, user.userId, fileId);
  if (file && !file.can_access) {
    return NextResponse.json({ code: 'FORBIDDEN', message: FILE_ACCESS_DENIED_MESSAGE }, { status: 403 });
  }
  if (file?.asset_state === 'ERROR') {
    return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Source image or prediction is missing.' }, { status: 409 });
  }

  const result = await acquireLock(fileId, user.userId, request.headers.get('X-Annotation-Lock-Token') || undefined);
  if (!result) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
  }

  if (result.denied) {
    return NextResponse.json({
      code: 'FILE_LOCKED',
      message: 'File is currently being edited.',
      lockedBy: result.lockedBy,
      expiresAt: result.expiresAt,
    }, { status: 423 });
  }

  return NextResponse.json({
    sessionId: result.sessionId,
    lockToken: result.lockToken,
    expiresAt: result.expiresAt,
    baseRevision: result.baseRevision,
  });
}

/**
 * DELETE /api/files/[fileId]/lock — Release lock (spec 03 §6)
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const token = request.headers.get('X-Annotation-Lock-Token') || '';

  const lockOwner = await validateLockToken(fileId, token);
  const released = lockOwner?.user_id === user.userId && await releaseLock(fileId, token);
  if (!released) {
    return NextResponse.json({ code: 'LOCK_LOST', message: 'Lock not found or invalid' }, { status: 409 });
  }

  return NextResponse.json({ released: true });
}
