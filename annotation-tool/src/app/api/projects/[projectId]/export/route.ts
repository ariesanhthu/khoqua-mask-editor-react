import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { exportProjectAnnotations } from '@/lib/export-service';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN' && user.role !== 'REVIEWER') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Reviewer or admin access required' }, { status: 403 });
  }
  const { projectId } = await params;
  const result = await exportProjectAnnotations(projectId);
  if (!result) return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Project not found' }, { status: 404 });
  return NextResponse.json(result);
}
