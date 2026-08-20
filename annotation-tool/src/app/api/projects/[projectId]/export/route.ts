import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { createProjectExportArchive, syncProjectAnnotationsToDrive } from '@/lib/export-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN' && user.role !== 'REVIEWER') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Reviewer or admin access required' }, { status: 403 });
  }
  const { projectId } = await params;
  try {
    const result = await syncProjectAnnotationsToDrive(projectId);
    if (!result) return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Project not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({
      code: 'DRIVE_SYNC_ERROR',
      message: error instanceof Error ? error.message : 'Không thể xuất dữ liệu lên Drive.',
    }, { status: 502 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN' && user.role !== 'REVIEWER') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Reviewer or admin access required' }, { status: 403 });
  }
  const { projectId } = await params;
  try {
    const result = await createProjectExportArchive(projectId);
    if (!result) return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Project not found' }, { status: 404 });
    const buffer = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({
      code: 'DRIVE_SYNC_ERROR',
      message: error instanceof Error ? error.message : 'Không thể tạo file tải xuống.',
    }, { status: 502 });
  }
}
