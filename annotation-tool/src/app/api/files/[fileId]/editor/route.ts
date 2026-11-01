import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { mapAnnotationRow } from '@/lib/annotation-service';
import { hashToken } from '@/lib/db';
import { loadPrelabelOperations } from '@/lib/prelabel-service';
import { FILE_ACCESS_DENIED_MESSAGE, FILE_ACCESS_SQL } from '@/lib/access-service';
import { createHash } from 'node:crypto';

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

  // Mỗi vòng tới Neon tốn ~0.3s, nên tệp + khoá + chủ khoá + annotation lấy một lượt
  // thay vì bốn lượt nối tiếp.
  const file = await db.prepare(`SELECT df.*, d.project_id,
      fl.user_id AS lock_user_id, fl.session_id AS lock_session_id,
      fl.lock_token_hash AS lock_token_hash, fl.expires_at AS lock_expires_at,
      lu.display_name AS lock_display_name,
      an.dataset_file_id AS annotation_file_id, an.revision AS annotation_revision,
      an.segmentation_json AS annotation_segmentation_json,
      an.breakpoints_json AS annotation_breakpoints_json,
      an.last_edited_by AS annotation_last_edited_by,
      an.updated_at AS annotation_updated_at, an.status AS annotation_status,
      ${FILE_ACCESS_SQL} AS can_access
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
    LEFT JOIN users lu ON lu.id = fl.user_id
    LEFT JOIN annotations an ON an.dataset_file_id = df.id
    WHERE df.id = ?`).get(user.userId, user.userId, fileId);
  if (!file) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
  }
  if (!file.can_access) {
    return NextResponse.json({ code: 'FORBIDDEN', message: FILE_ACCESS_DENIED_MESSAGE }, { status: 403 });
  }

  // Check lock ownership
  const isLocked = Boolean(file.lock_user_id) && new Date(file.lock_expires_at as string) > new Date();
  const token = request.headers.get('X-Annotation-Lock-Token') || '';
  const isOwner = Boolean(isLocked && file.lock_user_id === user.userId && file.lock_token_hash === hashToken(token));
  const owner = isLocked ? { display_name: file.lock_display_name } : null;

  const annotation = mapAnnotationRow(file.annotation_file_id ? {
    dataset_file_id: file.annotation_file_id,
    revision: file.annotation_revision,
    segmentation_json: file.annotation_segmentation_json,
    breakpoints_json: file.annotation_breakpoints_json,
    last_edited_by: file.annotation_last_edited_by,
    updated_at: file.annotation_updated_at,
    status: file.annotation_status,
  } : null);
  const prelabelOperations = !annotation && file.prelabel_storage_ref
    ? await loadPrelabelOperations(String(file.prelabel_storage_ref), Number(file.width), Number(file.height))
    : undefined;
  const assetVersion = createHash('sha256').update(JSON.stringify([
    file.image_drive_file_id, file.prediction_drive_file_id, file.width, file.height,
  ])).digest('hex').slice(0, 16);

  return NextResponse.json({
    file: {
      id: file.id,
      projectId: file.project_id,
      externalKey: file.external_key,
      width: file.width || 1024,
      height: file.height || 768,
    },
    assets: {
      imageUrl: `/api/files/${fileId}/assets/image?v=${assetVersion}`,
      predictionMaskUrl: `/api/files/${fileId}/assets/prediction?v=${assetVersion}`,
      ...(annotation && (annotation.segmentation as { maskStorageKey?: string }).maskStorageKey
        ? { currentMaskUrl: `/api/files/${fileId}/assets/current-mask` }
        : {}),
    },
    annotation,
    ...(prelabelOperations ? { prelabelOperations } : {}),
    readOnly: !isOwner,
    lockedBy: owner?.display_name,
    lock: isOwner ? {
      sessionId: file.lock_session_id,
      lockToken: '', // Never expose — client already has it from /lock
      expiresAt: file.lock_expires_at,
    } : null,
  });
}
