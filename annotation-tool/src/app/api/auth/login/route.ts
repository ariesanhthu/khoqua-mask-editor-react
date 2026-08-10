import { NextResponse } from 'next/server';
import { getDb, verifyPassword } from '@/lib/db';
import { signToken } from '@/lib/auth';

export async function POST(request: Request) {
  const { username, password } = await request.json();

  if (!username || !password) {
    return NextResponse.json(
      { code: 'UNAUTHORIZED', message: 'Username and password required' },
      { status: 400 }
    );
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE display_name = ? OR email = ?')
    .get(username, username) as Record<string, unknown> | undefined;

  if (!user || !verifyPassword(password, user.hashed_password as string)) {
    return NextResponse.json(
      { code: 'UNAUTHORIZED', message: 'Invalid credentials' },
      { status: 401 }
    );
  }

  const token = await signToken({
    userId: user.id as string,
    displayName: user.display_name as string,
    role: user.role as string,
  });

  const response = NextResponse.json({
    user: {
      id: user.id,
      displayName: user.display_name,
      role: user.role,
    },
  });

  // Also set cookie for SSR pages
  response.cookies.set('auth-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 86400, // 24h
    path: '/',
  });

  return response;
}
