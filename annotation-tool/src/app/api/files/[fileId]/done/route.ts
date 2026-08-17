import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { submitDone } from '@/lib/annotation-service';
import { getDb } from '@/lib/db';

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

  const body = await request.json();
  const { baseRevision, annotation } = body;

  const segmentation = annotation?.segmentation;
  const breakpoints = annotation?.breakpoints;
  if (!Number.isInteger(baseRevision) || !segmentation || !breakpoints ||
      !['ACCEPTED', 'MODIFIED'].includes(segmentation.humanAction) ||
      !['ANNOTATED', 'CONFIRMED_NONE'].includes(breakpoints.state) ||
      !Array.isArray(breakpoints.points) ||
      (breakpoints.state === 'ANNOTATED' && breakpoints.points.length === 0) ||
      (breakpoints.state === 'CONFIRMED_NONE' && breakpoints.points.length !== 0) ||
      (segmentation.maskOperations !== undefined && !hasPersistableOperations(segmentation.maskOperations))) {
    return NextResponse.json(
      { code: 'INVALID_ANNOTATION', message: 'Complete the mask and breakpoint tasks before finishing.' },
      { status: 400 }
    );
  }
  if (segmentation.humanAction === 'MODIFIED' && !segmentation.maskUploadRef) {
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
