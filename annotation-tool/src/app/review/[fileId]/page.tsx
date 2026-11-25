import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import ReviewWorkspace from '@/components/review-workspace';

/** Trang duyệt theo ảnh (2026-11-17 / 2026-11-24): chỉ xem, không xin khóa; quyền xem kiểm ở API bootstrap. */
export default async function ReviewPage({ params }: { params: Promise<{ fileId: string }> }) {
  const token = (await cookies()).get('auth-token')?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) redirect('/login');
  const { fileId } = await params;
  // key: sang ảnh kế tiếp thì dựng lại từ đầu (canvas, kết luận, lỗi) thay vì giữ trạng thái của ảnh trước.
  return <ReviewWorkspace key={fileId} fileId={fileId} />;
}
