import { NextResponse } from 'next/server';
import { generateId, getDb, nowISO } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { normalizeDriveFolderId } from '@/lib/drive-service';

export async function GET(request: Request) {
  await requireAuth(request);
  const db = await getDb();
  const projects = await db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
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
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  }
  const body = await request.json() as { name?: string; driveFolderId?: string; exportDriveFolderId?: string };
  if (!body.name?.trim() || !body.driveFolderId?.trim()) {
    return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'Tên và thư mục dữ liệu là bắt buộc.' }, { status: 400 });
  }
  const id = generateId();
  const now = nowISO();
  const sourceFolderId = normalizeDriveFolderId(body.driveFolderId);
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
