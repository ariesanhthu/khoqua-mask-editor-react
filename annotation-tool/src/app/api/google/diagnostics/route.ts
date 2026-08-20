import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { inspectDriveDestination } from '@/lib/drive-service';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  }
  try {
    const db = await getDb();
    const project = await db.prepare<{ export_drive_folder_id: string | null }>(
      'SELECT export_drive_folder_id FROM projects ORDER BY created_at LIMIT 1',
    ).get();
    const folderId = project?.export_drive_folder_id || process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID;
    if (!folderId) throw new Error('Chưa cấu hình thư mục Drive đích.');
    return NextResponse.json(await inspectDriveDestination(folderId));
  } catch (error) {
    const detail = error as { status?: number; reason?: string; message?: string };
    return NextResponse.json({
      code: 'GOOGLE_DRIVE_DIAGNOSTIC_ERROR',
      status: detail.status,
      reason: detail.reason,
      message: detail.message || 'Không thể kiểm tra Google Drive.',
    }, { status: detail.status && detail.status >= 400 ? detail.status : 500 });
  }
}
