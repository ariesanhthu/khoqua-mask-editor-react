import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getAnnotation } from '@/lib/annotation-service';
import { hashToken } from '@/lib/db';
import { loadPrelabelOperations } from '@/lib/prelabel-service';

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
  const token = request.headers.get('X-Annotation-Lock-Token') || '';
  const isOwner = Boolean(isLocked && lock!.user_id === user.userId && lock!.lock_token_hash === hashToken(token));
  const owner = isLocked ? await db.prepare('SELECT display_name FROM users WHERE id = ?').get(lock!.user_id) : null;

  const annotation = await getAnnotation(fileId);
  const prelabelOperations = !annotation && file.prelabel_storage_ref
    ? await loadPrelabelOperations(
        file.prelabel_storage_ref as string,
        Number(file.width || 1024),
        Number(file.height || 768),
      )
    : undefined;

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
    ...(prelabelOperations ? { prelabelOperations } : {}),
    readOnly: !isOwner,
    lockedBy: owner?.display_name,
    lock: isOwner ? {
      sessionId: lock!.session_id,
      lockToken: '', // Never expose — client already has it from /lock
      expiresAt: lock!.expires_at,
    } : null,
  });
}
