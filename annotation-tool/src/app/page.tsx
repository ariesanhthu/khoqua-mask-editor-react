import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyToken } from '@/lib/auth';
import Dashboard from '@/components/dashboard';

export default async function HomePage() {
  const token = (await cookies()).get('auth-token')?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) redirect('/login');

  return (
    <Dashboard user={{
      id: user.userId,
      displayName: user.displayName,
      role: user.role as 'ADMIN' | 'ANNOTATOR' | 'REVIEWER',
    }} />
  );
}
