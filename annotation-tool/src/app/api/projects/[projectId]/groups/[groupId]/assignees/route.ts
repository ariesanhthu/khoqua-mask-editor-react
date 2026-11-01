import { NextResponse } from 'next/server';
import { requireAdminAccount } from '@/lib/access-service';
import { GroupServiceError, setGroupAssignees } from '@/lib/group-service';

/**
 * PUT /api/projects/[projectId]/groups/[groupId]/assignees — thay danh sách người được giao nhóm.
 * Body: { userIds: string[] } (mảng rỗng = bỏ giao). Chỉ ADMIN. Phiên đang sửa không bị cắt ngang:
 * khóa và lưu vẫn hợp lệ, chỉ lần mở/xin khóa tiếp theo mới bị từ chối.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ projectId: string; groupId: string }> }) {
  try {
    const admin = await requireAdminAccount(request);
    const { projectId, groupId } = await params;
    const body = await request.json().catch(() => null) as { userIds?: unknown } | null;
    return NextResponse.json(await setGroupAssignees(projectId, groupId, body?.userIds, admin.userId));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof GroupServiceError) {
      return NextResponse.json({ code: error.status === 404 ? 'FILE_NOT_FOUND' : 'INVALID_DATASET', message: error.message }, { status: error.status });
    }
    throw error;
  }
}
