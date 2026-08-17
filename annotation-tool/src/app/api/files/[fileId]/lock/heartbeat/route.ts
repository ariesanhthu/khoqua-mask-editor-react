import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { heartbeat } from '@/lib/lock-service';

/**
 * POST /api/files/[fileId]/lock/heartbeat — Renew lock TTL (spec 03 §5)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const token = request.headers.get('X-Annotation-Lock-Token') || '';

  const expiresAt = await heartbeat(fileId, token, user.userId);
  if (!expiresAt) {
    return NextResponse.json(
      { code: 'LOCK_LOST', message: 'Your edit lock is no longer active.' },
      { status: 409 }
    );
  }

  return NextResponse.json({ expiresAt });
}
