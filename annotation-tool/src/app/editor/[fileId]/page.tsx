import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import EditorWorkspace from '@/components/editor-workspace';

export default async function EditorPage({ params }: { params: Promise<{ fileId: string }> }) {
  const token = (await cookies()).get('auth-token')?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) redirect('/login');
  const { fileId } = await params;
  return <EditorWorkspace fileId={fileId} userId={user.userId} displayName={user.displayName} />;
}

