import JSZip from 'jszip';
import sharp from 'sharp';
import { findVersion, requireVersionAdmin, versionAssets } from '@/lib/version-service';
import { fetchDatasetAsset } from '@/lib/drive-service';
import { readStoredMask } from '@/lib/storage';
import { annotationSvg } from '@/lib/annotation-svg';
import { addPixelAudit, addPolygonFiles } from '@/lib/polygon-export';
import { rasterizePolygons } from '@/lib/mask-pixels';
import type { SegmentationAnnotation } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string; versionId: string }> }) {
  try {
    await requireVersionAdmin(request);
    const { fileId, versionId } = await params;
    const version = await findVersion(fileId, versionId);
    if (!version) return Response.json({ message: 'Không tìm thấy version.' }, { status: 404 });
    const assets = versionAssets(version); const width = Number(assets.width); const height = Number(assets.height);
    const segmentation = JSON.parse(String(version.segmentation_json)) as SegmentationAnnotation;
    const operations = segmentation.maskOperations ?? [];
    const zip = new JSZip();
    zip.file('segmentation.json', String(version.segmentation_json));
    zip.file('breakpoints.json', String(version.breakpoints_json));
    zip.file('annotation.json', JSON.stringify({ schemaVersion: 'bitter-melon-prelabel-1.1', width, height, coordinateSpace: 'image_pixels', maskOperations: operations,
      segmentation, assetSnapshot: assets, versionNumber: version.version_number }));
    const image = await fetchDatasetAsset(assets.image);
    const format = (await sharp(image).metadata()).format;
    zip.file(`image.${format === 'jpeg' ? 'jpg' : format}`, image);
    zip.file('boundary.svg', annotationSvg(operations, width, height));
    const operation = [...operations].reverse().find(op => op.type === 'POLYGON_SET');
    const mask = segmentation.maskStorageKey ? await readStoredMask(segmentation.maskStorageKey)
      : operation?.type === 'POLYGON_SET' ? await sharp(rasterizePolygons(operation.polygons, width, height), { raw: { width, height, channels: 1 } }).png().toBuffer()
      : await fetchDatasetAsset(assets.prediction);
    zip.file('mask.png', mask);
    await addPolygonFiles(zip, 'polygons', operations, width, height);
    await addPixelAudit(zip, 'pixel-audit', operations, width, height, mask);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return new Response(new Uint8Array(bytes).buffer, {
      headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="version-${version.version_number}.zip"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
