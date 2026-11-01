import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { FILE_ACCESS_SQL } from '@/lib/access-service';
import { UNGROUPED_GROUP_ID } from '@/lib/file-groups';

/**
 * GET /api/projects/[projectId]/files
 * File list with filters per spec 03 §2. Người không phải ADMIN chỉ nhận ảnh thuộc nhóm được giao
 * (áp cho cả Home lẫn sidebar/Done & Next của editor). `groupId=ungrouped` = ảnh chưa phân nhóm;
 * `annotationState` nhận một hoặc nhiều giá trị cách nhau bằng dấu phẩy.
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
  const groupId = url.searchParams.get('groupId');
  const requestedPage = Number(url.searchParams.get('page') || '1');
  const requestedPageSize = Number(url.searchParams.get('pageSize') || '20');
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = Number.isSafeInteger(requestedPageSize)
    ? Math.min(100, Math.max(1, requestedPageSize))
    : 20;

  // Build query — get files from all datasets in this project
  const now = new Date().toISOString();
  let where = `WHERE d.project_id = ? AND ${FILE_ACCESS_SQL}`;
  const queryParams: unknown[] = [projectId, user.userId, user.userId];

  const annotationStates = annotationState?.split(',').map((state) => state.trim()).filter(Boolean) ?? [];
  if (annotationStates.length > 1) {
    where += ` AND df.annotation_state IN (${annotationStates.map(() => '?').join(', ')})`;
    queryParams.push(...annotationStates);
  } else if (annotationState) {
    where += ' AND df.annotation_state = ?';
    queryParams.push(annotationState);
  }

  if (groupId === UNGROUPED_GROUP_ID) {
    where += ' AND df.group_id IS NULL';
  } else if (groupId) {
    where += ' AND df.group_id = ?';
    queryParams.push(groupId);
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
        WHERE a.dataset_file_id = df.id ORDER BY a.created_at LIMIT 1) AS assignment_display_name,
      file_group.name AS group_name
    FROM dataset_files df
    JOIN datasets d ON df.dataset_id = d.id
    LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
    LEFT JOIN users lock_user ON lock_user.id = fl.user_id
    LEFT JOIN file_groups file_group ON file_group.id = df.group_id
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
      thumbnailUrl: `/api/files/${encodeURIComponent(String(f.id))}/assets/thumbnail?v=${encodeURIComponent(String(f.updated_at))}`,
      annotationState: f.annotation_state,
      assetState: f.asset_state,
      lock: isLocked
        ? { state: 'LOCKED', userId: f.lock_user_id, displayName: f.lock_display_name, expiresAt: f.lock_expires_at }
        : { state: 'AVAILABLE' },
      assignment: f.assignment_user_id
        ? { userId: f.assignment_user_id as string, displayName: f.assignment_display_name as string }
        : undefined,
      group: f.group_id ? { id: f.group_id as string, name: f.group_name as string } : undefined,
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
