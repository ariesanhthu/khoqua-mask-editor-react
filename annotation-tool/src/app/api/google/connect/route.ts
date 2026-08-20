import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { buildGoogleAuthorizationUrl } from '@/lib/google-oauth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  }
  try {
    const state = crypto.randomBytes(32).toString('base64url');
    const response = NextResponse.redirect(buildGoogleAuthorizationUrl(state));
    response.cookies.set('google-oauth-state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    });
    return response;
  } catch (error) {
    return NextResponse.json({
      code: 'CONFIGURATION_ERROR',
      message: error instanceof Error ? error.message : 'Không thể bắt đầu kết nối Google Drive.',
    }, { status: 500 });
  }
}
