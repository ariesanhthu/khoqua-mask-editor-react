import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';

const publicApiPaths = new Set(['/api/auth/login', '/api/auth/logout', '/api/health', '/api/seed']);

export async function proxy(request: NextRequest) {
  if (publicApiPaths.has(request.nextUrl.pathname)) return NextResponse.next();
  const token = request.cookies.get('auth-token')?.value;
  if (!token) {
    return NextResponse.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 });
  }
  try {
    const secret = process.env.SECRET_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-change-me-please-32chars');
    if (secret.length < 32) throw new Error('SECRET_KEY is not configured.');
    await jwtVerify(token, new TextEncoder().encode(secret));
    return NextResponse.next();
  } catch {
    return NextResponse.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 });
  }
}

export const config = {
  matcher: ['/api/:path*'],
};
