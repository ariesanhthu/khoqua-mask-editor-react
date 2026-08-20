import 'server-only';

import type { AnnotationPolygon, MaskOperation } from '@/types';
import { fetchDatasetAsset } from './drive-service';

interface ProductionPrelabel {
  schemaVersion: string;
  coordinateSpace: string;
  width: number;
  height: number;
  maskOperations: unknown;
}

export async function loadPrelabelOperations(
  reference: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<MaskOperation[]> {
  const bytes = await fetchDatasetAsset(reference);
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) {
    throw new Error('Prelabel JSON phải có kích thước từ 1 byte đến 50 MB.');
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as ProductionPrelabel;
  if (payload.schemaVersion !== 'bitter-melon-prelabel-1.0' || payload.coordinateSpace !== 'image_pixels') {
    throw new Error('Prelabel không đúng schema bitter-melon-prelabel-1.0.');
  }
  if (payload.width !== expectedWidth || payload.height !== expectedHeight) {
    throw new Error('Kích thước prelabel không khớp ảnh nguồn.');
  }
  if (!Array.isArray(payload.maskOperations) || payload.maskOperations.length !== 1) {
    throw new Error('Prelabel phải chứa đúng một POLYGON_SET.');
  }
  const operation = payload.maskOperations[0] as { type?: unknown; polygons?: unknown };
  if (operation.type !== 'POLYGON_SET' || !Array.isArray(operation.polygons)) {
    throw new Error('Prelabel thiếu POLYGON_SET hợp lệ.');
  }

  const polygonIds = new Set<string>();
  const nodeIds = new Set<string>();
  const polygons = operation.polygons.map((value, polygonIndex) => {
    const polygon = value as Partial<AnnotationPolygon>;
    if (!polygon.id || polygonIds.has(polygon.id) ||
        !['main_flesh_band', 'wart_flesh'].includes(polygon.label || '') ||
        !Array.isArray(polygon.nodes) || polygon.nodes.length < 3) {
      throw new Error(`Polygon prelabel không hợp lệ tại vị trí ${polygonIndex}.`);
    }
    polygonIds.add(polygon.id);
    for (const node of polygon.nodes) {
      if (!node?.id || nodeIds.has(node.id) || !Number.isFinite(node.x) || !Number.isFinite(node.y) ||
          node.x < 0 || node.x > expectedWidth || node.y < 0 || node.y > expectedHeight) {
        throw new Error(`Node prelabel không hợp lệ trong polygon ${polygon.id}.`);
      }
      nodeIds.add(node.id);
    }
    return polygon as AnnotationPolygon;
  });

  return [{ type: 'POLYGON_SET', polygons }];
}
