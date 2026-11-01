import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { listGroups } from '@/lib/group-service';

/**
 * GET /api/projects/[projectId]/groups — nhóm ảnh kèm tiến độ. ADMIN nhận mọi nhóm, người được giao
 * và số ảnh chưa phân nhóm; người dùng khác chỉ nhận nhóm được giao cho mình.
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireAuth(request);
    const { projectId } = await params;
    const result = await listGroups(projectId, user.userId);
    if (!result) return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Không tìm thấy dự án.' }, { status: 404 });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
