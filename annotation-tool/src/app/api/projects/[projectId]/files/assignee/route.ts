import { NextResponse } from 'next/server';
import { requireAdminAccount } from '@/lib/access-service';
import { FileAssignmentError, setFileAssignee } from '@/lib/file-assignment-service';

/**
 * PUT /api/projects/[projectId]/files/assignee — giao việc ở mức từng ảnh (người dùng yêu cầu 2026-11-24).
 * Body: `{ fileIds: string[], userId: string | null }` (null = bỏ giao riêng). Chỉ ADMIN (vai trò từ DB).
 * Mỗi ảnh tối đa một người phụ trách; chỉ ảnh đã có nhóm. Phiên đang sửa không bị cắt ngang.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const admin = await requireAdminAccount(request);
    const { projectId } = await params;
    const body = await request.json().catch(() => null) as { fileIds?: unknown; userId?: unknown } | null;
    return NextResponse.json(await setFileAssignee(projectId, body?.fileIds, body?.userId, admin.userId));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof FileAssignmentError) {
      return NextResponse.json({ code: error.status === 404 ? 'FILE_NOT_FOUND' : 'INVALID_DATASET', message: error.message }, { status: error.status });
    }
    throw error;
  }
}
