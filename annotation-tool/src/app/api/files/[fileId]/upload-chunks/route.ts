import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { validateLockToken } from '@/lib/lock-service';
import { storeBodyChunk } from '@/lib/request-body';

export const runtime = 'nodejs';

/**
 * POST /api/files/[fileId]/upload-chunks?uploadId=&index= — one part of a large gzipped save body.
 * The following PATCH /annotation or POST /done names the upload id instead of sending the body.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const lock = await validateLockToken(fileId, request.headers.get('X-Annotation-Lock-Token') || '');
  if (!lock || lock.user_id !== user.userId) {
    return NextResponse.json({ code: 'LOCK_LOST', message: 'Your edit lock is no longer active.' }, { status: 409 });
  }
  const url = new URL(request.url);
  try {
    await storeBodyChunk(
      fileId, user.userId, url.searchParams.get('uploadId') || '', Number(url.searchParams.get('index')),
      Buffer.from(await request.arrayBuffer()),
    );
    return NextResponse.json({ received: true });
  } catch (error) {
    return NextResponse.json(
      { code: 'INVALID_ANNOTATION', message: error instanceof Error ? error.message : 'Invalid upload chunk' },
      { status: 400 },
    );
  }
}
