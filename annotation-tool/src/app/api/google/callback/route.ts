import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { exchangeGoogleAuthorizationCode } from '@/lib/google-oauth';

export const runtime = 'nodejs';

function stateMatches(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length
    && crypto.timingSafeEqual(expectedBytes, receivedBytes);
}

function redirect(request: NextRequest, result: 'connected' | 'error') {
  const response = NextResponse.redirect(new URL(`/?googleDrive=${result}`, request.url));
  response.cookies.delete('google-oauth-state');
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const oauthError = request.nextUrl.searchParams.get('error');
  if (oauthError || !code || !stateMatches(request.cookies.get('google-oauth-state')?.value, state)) {
    return redirect(request, 'error');
  }
  try {
    await exchangeGoogleAuthorizationCode(code);
    return redirect(request, 'connected');
  } catch {
    return redirect(request, 'error');
  }
}
