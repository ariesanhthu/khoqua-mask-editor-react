import { NextResponse } from 'next/server';
import { requireAdminAccount } from '@/lib/access-service';
import { autoGroupProject, GroupServiceError } from '@/lib/group-service';

/**
 * POST /api/projects/[projectId]/groups/auto — xếp ảnh chưa phân nhóm vào nhóm theo tiền tố tên
 * (`8582_01` → `8582`). Chỉ ADMIN; chỉ chạy khi admin bấm nút, không tự chạy trên dữ liệu có sẵn.
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    await requireAdminAccount(request);
    const { projectId } = await params;
    return NextResponse.json(await autoGroupProject(projectId));
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof GroupServiceError) {
      return NextResponse.json({ code: 'FILE_NOT_FOUND', message: error.message }, { status: error.status });
    }
    throw error;
  }
}
