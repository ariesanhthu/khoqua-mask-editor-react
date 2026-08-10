import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';

export async function GET(request: Request) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json(
      { code: 'UNAUTHORIZED', message: 'Not authenticated' },
      { status: 401 }
    );
  }
  return NextResponse.json({
    id: user.userId,
    displayName: user.displayName,
    role: user.role,
  });
}
