import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { validateLockToken } from '@/lib/lock-service';
import { persistMask } from '@/lib/storage';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const token = request.headers.get('X-Annotation-Lock-Token') || '';
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const lock = validateLockToken(fileId, token);
    if (!lock || lock.user_id !== user.userId) {
      return NextResponse.json(
        { code: 'LOCK_LOST', message: 'Your edit lock is no longer active.' },
        { status: 409 },
      );
    }
    const maskUploadRef = await persistMask(fileId, bytes);
    return NextResponse.json({ maskUploadRef });
  } catch (error) {
    return NextResponse.json(
      { code: 'INVALID_ANNOTATION', message: error instanceof Error ? error.message : 'Invalid mask' },
      { status: 400 },
    );
  }
}
