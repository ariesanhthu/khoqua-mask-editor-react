import sharp from 'sharp';
import { rasterizePolygons } from '@/lib/mask-pixels';
import { findVersion, requireVersionAdmin, versionAssets } from '@/lib/version-service';
import { fetchDatasetAsset } from '@/lib/drive-service';
import { readStoredMask } from '@/lib/storage';
import type { SegmentationAnnotation } from '@/types';
import { annotationSvg } from '@/lib/annotation-svg';

export async function GET(request: Request, { params }: { params: Promise<{ fileId: string; versionId: string; assetType: string }> }) {
  try {
    await requireVersionAdmin(request);
    const { fileId, versionId, assetType } = await params;
    const row = await findVersion(fileId, versionId);
    if (!row || !['image', 'mask', 'boundary'].includes(assetType)) return Response.json({ message: 'Không tìm thấy asset.' }, { status: 404 });
    const assets = versionAssets(row);
    const segmentation = JSON.parse(String(row.segmentation_json)) as SegmentationAnnotation;
    if (assetType === 'boundary') return new Response(annotationSvg(segmentation.maskOperations ?? [], Number(assets.width), Number(assets.height)), {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" },
    });
    let bytes: Uint8Array;
    if (assetType === 'image') bytes = await fetchDatasetAsset(assets.image);
    else {
      const operation = segmentation.maskOperations?.at(-1);
      if (segmentation.maskStorageKey) bytes = await readStoredMask(segmentation.maskStorageKey);
      else if (operation?.type === 'POLYGON_SET') {
        const pixels = rasterizePolygons(operation.polygons, Number(assets.width), Number(assets.height));
        bytes = await sharp(pixels, { raw: { width: Number(assets.width), height: Number(assets.height), channels: 1 } }).png().toBuffer();
      } else bytes = await fetchDatasetAsset(assets.prediction);
    }
    // Normalize image format so historical JPEG and new PNG crops share this endpoint.
    const png = await sharp(bytes).png().toBuffer();
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
