import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { syncProjectFromDrive } from '@/lib/drive-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  }
  const { projectId } = await params;
  try {
    const result = await syncProjectFromDrive(projectId);
    if (!result) return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Project not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ code: 'DRIVE_SYNC_ERROR', message: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
