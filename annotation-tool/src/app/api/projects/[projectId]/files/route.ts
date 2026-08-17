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
  const db = await getDb();
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
  const countRow = await db.prepare(`
    SELECT COUNT(*) as total FROM dataset_files df
    JOIN datasets d ON df.dataset_id = d.id
    ${where}
  `).get(...queryParams);
  const total = Number(countRow?.total || 0);

  // Get page
  const offset = (page - 1) * pageSize;
  const files = await db.prepare(`
    SELECT df.*, d.project_id,
      fl.user_id AS lock_user_id, fl.expires_at AS lock_expires_at,
      lock_user.display_name AS lock_display_name,
      (SELECT a.user_id FROM assignments a WHERE a.dataset_file_id = df.id ORDER BY a.created_at LIMIT 1) AS assignment_user_id,
      (SELECT assigned_user.display_name FROM assignments a
        JOIN users assigned_user ON assigned_user.id = a.user_id
        WHERE a.dataset_file_id = df.id ORDER BY a.created_at LIMIT 1) AS assignment_display_name
    FROM dataset_files df
    JOIN datasets d ON df.dataset_id = d.id
    LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
    LEFT JOIN users lock_user ON lock_user.id = fl.user_id
    ${where}
    ORDER BY df.external_key ASC
    LIMIT ? OFFSET ?
  `).all(...queryParams, pageSize, offset);

  // Enrich with lock + assignment info
  const items = files.map((f) => {
    const isLocked = f.lock_user_id && new Date(f.lock_expires_at as string) > new Date();

    return {
      id: f.id,
      externalKey: f.external_key,
      thumbnailUrl: null,
      annotationState: f.annotation_state,
      assetState: f.asset_state,
      lock: isLocked
        ? { state: 'LOCKED', userId: f.lock_user_id, displayName: f.lock_display_name, expiresAt: f.lock_expires_at }
        : { state: 'AVAILABLE' },
      assignment: f.assignment_user_id
        ? { userId: f.assignment_user_id as string, displayName: f.assignment_display_name as string }
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
