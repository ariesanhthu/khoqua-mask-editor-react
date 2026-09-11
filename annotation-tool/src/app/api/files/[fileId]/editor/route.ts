import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { mapAnnotationRow } from '@/lib/annotation-service';
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
      an.updated_at AS annotation_updated_at, an.status AS annotation_status
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
    LEFT JOIN users lu ON lu.id = fl.user_id
    LEFT JOIN annotations an ON an.dataset_file_id = df.id
    WHERE df.id = ?`).get(fileId);
  if (!file) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
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
      sessionId: file.lock_session_id,
      lockToken: '', // Never expose — client already has it from /lock
      expiresAt: file.lock_expires_at,
    } : null,
  });
}
