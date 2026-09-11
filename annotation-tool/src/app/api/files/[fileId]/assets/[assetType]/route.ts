import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { access, readFile } from 'fs/promises';
import path from 'path';
import { getDb } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { fetchDatasetAsset } from '@/lib/drive-service';
import { readStoredMask } from '@/lib/storage';
import { getThumbnail } from '@/lib/thumbnails';

export const runtime = 'nodejs';

/**
 * GET /api/files/[fileId]/assets/[assetType]
 * Serves image or prediction mask. For now serves placeholder/local files.
 * In production, this would proxy from Google Drive.
 */
const etagFor = (version: string) => `"${createHash('sha1').update(version).digest('hex').slice(0, 24)}"`;

function notModified(request: Request, etag: string, cacheControl: string) {
  const requested = request.headers.get('if-none-match');
  if (!requested || requested !== etag) return null;
  return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Cookie' } });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ fileId: string; assetType: string }> }
) {
  await requireAuth(request);
  const { fileId, assetType } = await params;
  const db = await getDb();

  const file = await db.prepare('SELECT * FROM dataset_files WHERE id = ?').get(fileId);
  if (!file) {
    return NextResponse.json({ code: 'FILE_NOT_FOUND', message: 'File not found' }, { status: 404 });
  }

  if (assetType === 'thumbnail') {
    const reference = file.image_drive_file_id as string;
    const localPath = path.isAbsolute(reference) ? reference : path.join(process.cwd(), 'data', reference);
    try {
      // Resolve the same original image as the editor; never return full-size bytes here.
      const isLocal = await access(localPath).then(() => true, () => false);
      const bytes = await getThumbnail(isLocal ? localPath : reference,
        () => isLocal ? readFile(localPath) : fetchDatasetAsset(reference), String(file.updated_at));
      return new NextResponse(toArrayBuffer(bytes), {
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400', 'Vary': 'Cookie' },
      });
    } catch {
      return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Thumbnail unavailable' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // Determine which file to serve
  let filePath: string;
  let contentType: string;

  if (assetType === 'current-mask') {
    const annotation = await db.prepare<{ segmentation_json: string; revision: number }>(
      'SELECT segmentation_json, revision FROM annotations WHERE dataset_file_id = ?',
    ).get(fileId);
    const storageKey = annotation
      ? (JSON.parse(annotation.segmentation_json) as { maskStorageKey?: string }).maskStorageKey
      : undefined;
    if (!storageKey) {
      return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Current mask not found' }, { status: 404 });
    }
    const maskCacheControl = 'private, no-cache';
    const maskEtag = etagFor(`${storageKey}:${annotation!.revision}`);
    const cached = notModified(request, maskEtag, maskCacheControl);
    if (cached) return cached;
    try {
      const buffer = await readStoredMask(storageKey);
      return new NextResponse(toArrayBuffer(buffer), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': maskCacheControl, ETag: maskEtag, Vary: 'Cookie' },
      });
    } catch {
      return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Current mask not found' }, { status: 404 });
    }
  } else if (assetType === 'image') {
    filePath = file.image_drive_file_id as string;
    contentType = imageContentType(file.image_filename as string);
  } else if (assetType === 'prediction') {
    filePath = file.prediction_drive_file_id as string;
    contentType = 'image/png';
  } else {
    return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Invalid asset type' }, { status: 404 });
  }

  const sourceCacheControl = 'private, max-age=3600, stale-while-revalidate=86400';
  const sourceEtag = etagFor(`${assetType}:${filePath}:${file.updated_at}`);
  const cachedSource = notModified(request, sourceEtag, sourceCacheControl);
  if (cachedSource) return cachedSource;
  const sourceHeaders = {
    'Content-Type': contentType,
    'Cache-Control': sourceCacheControl,
    ETag: sourceEtag,
    Vary: 'Cookie',
  };

  // Try to serve local file (development mode)
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), 'data', filePath);

    const buffer = await readFile(absolutePath);
    return new NextResponse(buffer, { headers: sourceHeaders });
  } catch {
    try {
      const bytes = await fetchDatasetAsset(filePath);
      return new NextResponse(toArrayBuffer(bytes), { headers: sourceHeaders });
    } catch {
      // The seed dataset intentionally uses placeholder paths.
    }

    // Generate placeholder image for development/seed data.
    const width = (file.width as number) || 512;
    const height = (file.height as number) || 384;

    // Return a simple SVG placeholder
    const color = assetType === 'image' ? '#2d3748' : '#4a5568';
    const label = assetType === 'image'
      ? file.external_key as string
      : `Prediction: ${file.external_key}`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${color}"/>
      <text x="50%" y="50%" text-anchor="middle" dy="0.35em" fill="#a0aec0" font-size="24" font-family="sans-serif">${label}</text>
    </svg>`;

    return new NextResponse(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
}

function imageContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
