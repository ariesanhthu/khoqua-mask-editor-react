/**
 * JWT auth helpers for API routes.
 * Server-side only.
 */

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import 'server-only';

const ALG = 'HS256';

function secretKey(): Uint8Array {
  const value = process.env.SECRET_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-change-me-please-32chars');
  if (value.length < 32) throw new Error('SECRET_KEY must contain at least 32 characters in production.');
  return new TextEncoder().encode(value);
}

export interface JWTPayload {
  userId: string;
  displayName: string;
  role: string;
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG })
    .setExpirationTime('24h')
    .setIssuedAt()
    .sign(secretKey());
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Extract user from the Authorization header or cookie.
 * Returns null if not authenticated.
 */
export async function getAuthUser(request: Request): Promise<JWTPayload | null> {
  // Check Authorization header first
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return verifyToken(authHeader.slice(7));
  }

  // Check cookie
  const cookieStore = await cookies();
  const tokenCookie = cookieStore.get('auth-token');
  if (tokenCookie) {
    return verifyToken(tokenCookie.value);
  }

  return null;
}

/**
 * Require authentication — returns user or throws 401 JSON response.
 */
export async function requireAuth(request: Request): Promise<JWTPayload> {
  const user = await getAuthUser(request);
  if (!user) {
    throw new Response(
      JSON.stringify({ code: 'UNAUTHORIZED', message: 'Authentication required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return user;
}
