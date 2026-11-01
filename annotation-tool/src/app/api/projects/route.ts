import { NextResponse } from 'next/server';
import { generateId, getDb, nowISO } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { ADMIN_ACCESS_SQL, requireAdminAccount } from '@/lib/access-service';
import { normalizeDriveFolderId } from '@/lib/drive-service';

export async function GET(request: Request) {
  const user = await requireAuth(request);
  const db = await getDb();
  // Người không phải ADMIN chỉ thấy dự án có ít nhất một nhóm được giao cho mình.
  const projects = await db.prepare(`SELECT p.* FROM projects p
    WHERE ${ADMIN_ACCESS_SQL} OR EXISTS (SELECT 1 FROM file_groups g
      JOIN group_assignments ga ON ga.group_id = g.id
      WHERE g.project_id = p.id AND ga.user_id = ?)
    ORDER BY p.created_at DESC`).all(user.userId, user.userId);
  return NextResponse.json(
    projects.map((p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      driveFolderId: p.drive_folder_id,
      exportDriveFolderId: p.export_drive_folder_id,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }))
  );
}

export async function POST(request: Request) {
  try {
    await requireAdminAccount(request);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  const body = await request.json() as { name?: string; driveFolderId?: string; exportDriveFolderId?: string; source?: string };
  // Dự án nhận dữ liệu bằng cách tải thư mục lên thì không có nguồn manifest để đồng bộ.
  const uploadOnly = body.source === 'upload';
  if (!body.name?.trim() || (!uploadOnly && !body.driveFolderId?.trim())) {
    return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'Tên và thư mục dữ liệu là bắt buộc.' }, { status: 400 });
  }
  const id = generateId();
  const now = nowISO();
  const sourceFolderId = normalizeDriveFolderId(body.driveFolderId || '');
  const exportFolderId = normalizeDriveFolderId(
    body.exportDriveFolderId || process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID || '147cVK2C7EZiupfMJQntP5Nc6tkkhqchN',
  );
  const db = await getDb();
  await db.prepare(`INSERT INTO projects
    (id, name, drive_folder_id, export_drive_folder_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, body.name.trim(), sourceFolderId, exportFolderId, now, now);
  return NextResponse.json({
    id,
    name: body.name.trim(),
    driveFolderId: sourceFolderId,
    exportDriveFolderId: exportFolderId,
    createdAt: now,
    updatedAt: now,
  }, { status: 201 });
}
