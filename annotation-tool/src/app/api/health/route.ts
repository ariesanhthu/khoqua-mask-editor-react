import { NextResponse } from 'next/server';

export async function GET() {
  const driveValue = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim() || '';
  const checks = {
    database: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL),
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID),
    authSecret: Boolean(process.env.SECRET_KEY && process.env.SECRET_KEY.length >= 32),
    driveCredential: driveValue.startsWith('{'),
    driveExportFolder: Boolean(process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID),
  };
  const ready = Object.values(checks).every(Boolean);
  return NextResponse.json(
    { status: ready ? 'ready' : 'configuration_required', checks },
    { status: ready ? 200 : 503 },
  );
}
