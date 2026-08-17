import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getAnnotation } from '@/lib/annotation-service';

/**
 * GET /api/files/[fileId]/editor — Editor bootstrap data (spec 02 §15)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const db = await getDb();

  const file = await db.prepare(`SELECT df.*, d.project_id FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id WHERE df.id = ?`).get(fileId);
  if (!file) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
  }

  // Check lock ownership
  const lock = await db.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ?').get(fileId);
  const isLocked = lock && new Date(lock.expires_at as string) > new Date();
  const isOwner = isLocked && lock!.user_id === user.userId;

  if (!isOwner) {
    return NextResponse.json({ code: 'LOCK_LOST', message: 'You do not own the edit lock' }, { status: 409 });
  }

  const annotation = await getAnnotation(fileId);

  return NextResponse.json({
    file: {
      id: file.id,
      projectId: file.project_id,
      externalKey: file.external_key,
      width: file.width || 1024,
      height: file.height || 768,
    },
    assets: {
      imageUrl: `/api/files/${fileId}/assets/image`,
      predictionMaskUrl: `/api/files/${fileId}/assets/prediction`,
      ...(annotation && (annotation.segmentation as { maskStorageKey?: string }).maskStorageKey
        ? { currentMaskUrl: `/api/files/${fileId}/assets/current-mask` }
        : {}),
    },
    annotation,
    lock: {
      sessionId: lock!.session_id,
      lockToken: '', // Never expose — client already has it from /lock
      expiresAt: lock!.expires_at,
    },
  });
}
