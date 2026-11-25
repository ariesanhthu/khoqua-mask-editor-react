import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { FILE_ACCESS_DENIED_MESSAGE } from '@/lib/access-service';
import { reviewAnnotation } from '@/lib/annotation-service';

/**
 * POST /api/files/[fileId]/review — kết luận duyệt THEO ẢNH (người dùng xác nhận 2026-11-17).
 * Body: `{ decision: 'APPROVE' | 'REJECT', revision }`. Đạt → Hoàn thành (DONE), Cần sửa → Đang sửa (DRAFT).
 * Mọi vai trò có quyền xem ảnh đều duyệt được; chỉ đổi nhãn trạng thái, không tạo revision/version.
 * Header `X-Annotation-Lock-Token` (tùy chọn, chỉ editor gửi): cho phép Đạt thẳng từ Bản nháp khi người duyệt
 * đang giữ khóa hợp lệ (người dùng xác nhận 2026-11-25). Xem `reviewAnnotation`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const user = await requireAuth(request);
  const { fileId } = await params;
  let body: { decision?: unknown; revision?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_REVIEW', message: 'Dữ liệu duyệt không hợp lệ.' }, { status: 400 });
  }
  const { decision, revision } = body;
  if ((decision !== 'APPROVE' && decision !== 'REJECT') || typeof revision !== 'number' || !Number.isInteger(revision)) {
    return NextResponse.json({ code: 'INVALID_REVIEW', message: 'Dữ liệu duyệt không hợp lệ.' }, { status: 400 });
  }

  const result = await reviewAnnotation(fileId, user.userId, decision, revision, request.headers.get('X-Annotation-Lock-Token') || undefined);
  if (!('error' in result)) return NextResponse.json(result);
  switch (result.error) {
    case 'NOT_FOUND':
      return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'Không tìm thấy ảnh.' }, { status: 404 });
    case 'FORBIDDEN':
      return NextResponse.json({ code: 'FORBIDDEN', message: FILE_ACCESS_DENIED_MESSAGE }, { status: 403 });
    case 'FILE_LOCKED':
      return NextResponse.json({ code: 'FILE_LOCKED', message: 'Ảnh đang được người khác mở để sửa. Chờ họ lưu xong rồi duyệt lại.' }, { status: 423 });
    case 'REVISION_CONFLICT':
      return NextResponse.json({ code: 'REVISION_CONFLICT', message: 'Ảnh đã thay đổi sau khi bạn mở trang duyệt. Hãy tải lại rồi duyệt.', serverRevision: result.serverRevision }, { status: 409 });
    default:
      return NextResponse.json({ code: 'NOT_IN_REVIEW', message: 'Ảnh không ở trạng thái Cần review nên không kết luận được.', annotationState: result.annotationState }, { status: 409 });
  }
}
