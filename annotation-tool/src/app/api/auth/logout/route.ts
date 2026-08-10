import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ loggedOut: true as const });
  response.cookies.set('auth-token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}
