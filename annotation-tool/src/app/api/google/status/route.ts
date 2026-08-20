import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import {
  disconnectGoogleDrive,
  getGoogleDriveAccountEmail,
  googleOAuthConfigured,
  isGoogleDriveConnected,
} from '@/lib/google-oauth';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const user = await requireAuth(request);
  const connected = await isGoogleDriveConnected();
  return NextResponse.json({
    configured: googleOAuthConfigured(),
    connected,
    accountEmail: connected && user.role === 'ADMIN' ? await getGoogleDriveAccountEmail() : null,
  });
}

export async function DELETE(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  }
  await disconnectGoogleDrive();
  return NextResponse.json({ connected: false });
}
