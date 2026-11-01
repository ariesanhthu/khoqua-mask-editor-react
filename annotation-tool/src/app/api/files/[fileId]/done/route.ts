import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { submitDone } from '@/lib/annotation-service';
import { getDb } from '@/lib/db';
import { readAnnotationBody } from '@/lib/request-body';
import { validWartPoints } from '@/lib/wart-points';

function hasPersistableOperations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((operation) => operation
    && typeof operation === 'object'
    && 'type' in operation
    && (operation.type === 'RESET_TO_PREDICTION'
      || ((operation.type === 'BRUSH_ADD' || operation.type === 'BRUSH_ERASE')
        && 'points' in operation && Array.isArray(operation.points))
      || (operation.type === 'POLYGON_SET'
        && 'polygons' in operation && Array.isArray(operation.polygons))));
}

/**
 * POST /api/files/[fileId]/done — Finalize annotation (spec 03 §12)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  const token = request.headers.get('X-Annotation-Lock-Token') || '';

  let body;
  try {
    body = await readAnnotationBody(request, fileId, user.userId);
  } catch {
    return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'Annotation payload is not valid JSON' }, { status: 400 });
  }
  const { baseRevision, annotation } = body;

  const segmentation = annotation?.segmentation;
  const breakpoints = annotation?.breakpoints;
  if (!Number.isInteger(baseRevision) || !segmentation || !breakpoints ||
      !['ACCEPTED', 'MODIFIED'].includes(segmentation.humanAction) ||
      !['NOT_ANNOTATED', 'ANNOTATED', 'CONFIRMED_NONE'].includes(breakpoints.state) ||
      // Wart step temporarily hidden: !validWartPoints(segmentation.wartPoints, true)
      !validWartPoints(segmentation.wartPoints) ||
      !Array.isArray(breakpoints.points) ||
      (breakpoints.state === 'ANNOTATED' && breakpoints.points.length === 0) ||
      (breakpoints.state === 'CONFIRMED_NONE' && breakpoints.points.length !== 0) ||
      (segmentation.maskOperations?.length > 0 && !hasPersistableOperations(segmentation.maskOperations))) {
    return NextResponse.json(
      { code: 'INVALID_ANNOTATION', message: 'Complete the mask task before finishing.' },
      { status: 400 }
    );
  }
  // No mask PNG is uploaded any more: the server can rebuild a mask from polygons, not from brush strokes.
  const lastOperation = Array.isArray(segmentation.maskOperations) ? segmentation.maskOperations.at(-1) : undefined;
  if (segmentation.humanAction === 'MODIFIED' && !segmentation.maskUploadRef
      && (lastOperation?.type === 'BRUSH_ADD' || lastOperation?.type === 'BRUSH_ERASE')) {
    return NextResponse.json(
      { code: 'INVALID_ANNOTATION', message: 'Brush edits must be converted to polygons before finishing.' },
      { status: 400 },
    );
  }
  if (segmentation.humanAction === 'MODIFIED' && !segmentation.maskUploadRef
      && !hasPersistableOperations(segmentation.maskOperations)) {
    const db = await getDb();
    const existing = await db.prepare<{ segmentation_json: string }>('SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?')
      .get(fileId);
    const currentKey = existing
      ? (JSON.parse(existing.segmentation_json) as { maskStorageKey?: string }).maskStorageKey
      : undefined;
    if (!currentKey) {
      return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'A modified mask upload is required.' }, { status: 400 });
    }
  }

  const result = await submitDone(
    fileId,
    user.userId,
    token,
    baseRevision,
    segmentation,
    breakpoints,
  );

  if (!result) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
  }

  if (result === 'LOCK_LOST') {
    return NextResponse.json(
      { code: 'LOCK_LOST', message: 'Your edit lock is no longer active.' },
      { status: 409 },
    );
  }

  if ('conflict' in result) {
    return NextResponse.json(
      { code: 'REVISION_CONFLICT', serverRevision: result.serverRevision },
      { status: 409 }
    );
  }

  return NextResponse.json(result);
}
