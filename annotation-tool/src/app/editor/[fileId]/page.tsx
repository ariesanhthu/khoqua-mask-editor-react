import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import EditorWorkspace from '@/components/editor-workspace';

export default async function EditorPage({ params, searchParams }: {
  params: Promise<{ fileId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const token = (await cookies()).get('auth-token')?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) redirect('/login');
  const { fileId } = await params;
  // `?tab=review`: mở thẳng tab Review (Đạt & Tiếp theo, ảnh chờ duyệt kế tiếp; người dùng xác nhận 2026-11-25).
  const initialTab = (await searchParams).tab === 'review' ? 'review' : 'annotate';
  return <EditorWorkspace fileId={fileId} userId={user.userId} displayName={user.displayName} initialTab={initialTab} />;
}

