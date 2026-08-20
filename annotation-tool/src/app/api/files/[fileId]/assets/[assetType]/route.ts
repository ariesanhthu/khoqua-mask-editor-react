import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { getDb } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { fetchDatasetAsset } from '@/lib/drive-service';
import { readStoredMask } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * GET /api/files/[fileId]/assets/[assetType]
 * Serves image or prediction mask. For now serves placeholder/local files.
 * In production, this would proxy from Google Drive.
 */
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

  // Determine which file to serve
  let filePath: string;
  let contentType: string;

  if (assetType === 'current-mask') {
    const annotation = await db.prepare<{ segmentation_json: string }>('SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?')
      .get(fileId);
    const storageKey = annotation
      ? (JSON.parse(annotation.segmentation_json) as { maskStorageKey?: string }).maskStorageKey
      : undefined;
    if (!storageKey) {
      return NextResponse.json({ code: 'ASSET_NOT_FOUND', message: 'Current mask not found' }, { status: 404 });
    }
    try {
      const buffer = await readStoredMask(storageKey);
      return new NextResponse(toArrayBuffer(buffer), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' } });
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

  // Try to serve local file (development mode)
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), 'data', filePath);

    const buffer = await readFile(absolutePath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    try {
      const bytes = await fetchDatasetAsset(filePath);
      return new NextResponse(toArrayBuffer(bytes), {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' },
      });
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
