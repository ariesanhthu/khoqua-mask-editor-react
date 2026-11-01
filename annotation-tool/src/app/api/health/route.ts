import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { readR2Config } from '@/lib/object-store';

/** Short one-way hash: lets you compare two deployments without exposing hosts or store ids. */
const fingerprint = (value?: string | null) => (
  value ? createHash('sha256').update(value).digest('hex').slice(0, 10) : null
);

function databaseTarget() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // Pooled and direct Neon hosts reach the same branch; normalise so they fingerprint equally.
    return `${parsed.hostname.replace('-pooler', '')}/${parsed.pathname.slice(1)}`;
  } catch {
    return null;
  }
}

function blobStore() {
  const r2 = process.env.STORAGE_BACKEND?.trim().toLowerCase() === 'r2' ? readR2Config() : null;
  if (r2) return `r2:${r2.endpoint}/${r2.bucket}`;
  return process.env.BLOB_READ_WRITE_TOKEN?.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/)?.[1]
    || process.env.BLOB_STORE_ID?.replace(/^store_/, '')
    || null;
}

export async function GET() {
  const driveValue = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON?.trim() || '';
  const checks = {
    database: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL),
    // "blob" is the object-storage check (Vercel Blob or R2); the key name is kept for existing scripts.
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID)
      || (process.env.STORAGE_BACKEND?.trim().toLowerCase() === 'r2' && Boolean(readR2Config())),
    authSecret: Boolean(process.env.SECRET_KEY && process.env.SECRET_KEY.length >= 32),
    driveCredential: driveValue.startsWith('{'),
    driveExportFolder: Boolean(process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID),
    googleOAuthConfig: Boolean(
      process.env.GOOGLE_OAUTH_CLIENT_ID
      && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      && process.env.GOOGLE_OAUTH_REDIRECT_URI,
    ),
  };
  const ready = checks.database && checks.blob && checks.authSecret;
  return NextResponse.json(
    {
      status: ready ? 'ready' : 'configuration_required',
      checks,
      // Localhost and production share data only when both fingerprints match.
      fingerprints: { database: fingerprint(databaseTarget()), blobStore: fingerprint(blobStore()) },
    },
    { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
