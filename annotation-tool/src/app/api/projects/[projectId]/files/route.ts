import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

/**
 * GET /api/projects/[projectId]/files
 * File list with filters per spec 03 §2.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const user = await requireAuth(request);
  const { projectId } = await params;
  const db = getDb();
  const url = new URL(request.url);

  const annotationState = url.searchParams.get('annotationState');
  const lockState = url.searchParams.get('lockState');
  const assignedTo = url.searchParams.get('assignedTo');
  const search = url.searchParams.get('search');
  const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || '50')));

  // Build query — get files from all datasets in this project
  const now = new Date().toISOString();
  let where = 'WHERE d.project_id = ?';
  const queryParams: unknown[] = [projectId];

  if (annotationState) {
    where += ' AND df.annotation_state = ?';
    queryParams.push(annotationState);
  }

  if (search) {
    where += ' AND df.external_key LIKE ?';
    queryParams.push(`%${search}%`);
  }

  if (assignedTo === 'me') {
    where += ' AND EXISTS (SELECT 1 FROM assignments a WHERE a.dataset_file_id = df.id AND a.user_id = ?)';
    queryParams.push(user.userId);
  }

  if (lockState === 'AVAILABLE') {
    where += ' AND NOT EXISTS (SELECT 1 FROM file_locks fl WHERE fl.dataset_file_id = df.id AND fl.expires_at > ?)';
    queryParams.push(now);
  } else if (lockState === 'LOCKED') {
    where += ' AND EXISTS (SELECT 1 FROM file_locks fl WHERE fl.dataset_file_id = df.id AND fl.expires_at > ?)';
    queryParams.push(now);
  }

  // Count total
  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM dataset_files df
    JOIN datasets d ON df.dataset_id = d.id
    ${where}
  `).get(...queryParams) as Record<string, unknown>;
  const total = countRow.total as number;

  // Get page
  const offset = (page - 1) * pageSize;
  const files = db.prepare(`
    SELECT df.*, d.project_id FROM dataset_files df
    JOIN datasets d ON df.dataset_id = d.id
    ${where}
    ORDER BY df.external_key ASC
    LIMIT ? OFFSET ?
  `).all(...queryParams, pageSize, offset) as Record<string, unknown>[];

  // Enrich with lock + assignment info
  const items = files.map((f) => {
    const lock = db.prepare('SELECT fl.*, u.display_name FROM file_locks fl JOIN users u ON fl.user_id = u.id WHERE fl.dataset_file_id = ?')
      .get(f.id as string) as Record<string, unknown> | undefined;

    const assignment = db.prepare('SELECT a.user_id, u.display_name FROM assignments a JOIN users u ON a.user_id = u.id WHERE a.dataset_file_id = ? LIMIT 1')
      .get(f.id as string) as Record<string, unknown> | undefined;

    const isLocked = lock && new Date(lock.expires_at as string) > new Date();

    return {
      id: f.id,
      externalKey: f.external_key,
      thumbnailUrl: null,
      annotationState: f.annotation_state,
      assetState: f.asset_state,
      lock: isLocked
        ? { state: 'LOCKED', userId: lock!.user_id, displayName: lock!.display_name, expiresAt: lock!.expires_at }
        : { state: 'AVAILABLE' },
      assignment: assignment
        ? { userId: assignment.user_id as string, displayName: assignment.display_name as string }
        : undefined,
      latestRevision: f.latest_revision,
      latestVersionNumber: f.latest_version_number,
    };
  });

  return NextResponse.json({
    items,
    page,
    pageSize,
    total,
  });
}
