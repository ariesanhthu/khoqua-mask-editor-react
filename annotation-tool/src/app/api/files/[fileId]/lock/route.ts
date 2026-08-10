import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { acquireLock, releaseLock, validateLockToken } from '@/lib/lock-service';
import { getDb } from '@/lib/db';

/**
 * POST /api/files/[fileId]/lock — Acquire lock (spec 03 §3)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const file = getDb().prepare('SELECT asset_state FROM dataset_files WHERE id = ?').get(fileId) as { asset_state: string } | undefined;
  if (file?.asset_state === 'ERROR') {
    return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Source image or prediction is missing.' }, { status: 409 });
  }

  const result = acquireLock(fileId, user.userId);
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

  const lockOwner = validateLockToken(fileId, token);
  const released = lockOwner?.user_id === user.userId && releaseLock(fileId, token);
  if (!released) {
    return NextResponse.json({ code: 'LOCK_LOST', message: 'Lock not found or invalid' }, { status: 409 });
  }

  return NextResponse.json({ released: true });
}
