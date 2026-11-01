import 'server-only';

import type { AnnotationPolygon, MaskOperation } from '@/types';
import { fetchDatasetAsset } from './drive-service';

export class PrelabelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrelabelValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadPrelabelOperations(
  reference: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<MaskOperation[]> {
  const bytes = await fetchDatasetAsset(reference);
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) {
    throw new PrelabelValidationError('Prelabel JSON phải có kích thước từ 1 byte đến 50 MB.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PrelabelValidationError('Prelabel không phải JSON hợp lệ.');
  }
  return parsePrelabelOperations(payload, expectedWidth, expectedHeight);
}

export function parsePrelabelOperations(
  payload: unknown,
  expectedWidth: number,
  expectedHeight: number,
): MaskOperation[] {
  // Both versions have the same pixel-coordinate envelope. Version 1.1 adds instance
  // labels and optional polygon fields; keep those fields unchanged when reading.
  if (!isRecord(payload) ||
      !['bitter-melon-prelabel-1.0', 'bitter-melon-prelabel-1.1'].includes(String(payload.schemaVersion)) ||
      payload.coordinateSpace !== 'image_pixels') {
    throw new PrelabelValidationError('Prelabel không đúng schema bitter-melon-prelabel-1.0/1.1.');
  }
  if (!Number.isInteger(expectedWidth) || expectedWidth <= 0 ||
      !Number.isInteger(expectedHeight) || expectedHeight <= 0 ||
      payload.width !== expectedWidth || payload.height !== expectedHeight) {
    throw new PrelabelValidationError('Kích thước prelabel không khớp ảnh nguồn.');
  }
  if (!Array.isArray(payload.maskOperations) || payload.maskOperations.length !== 1) {
    throw new PrelabelValidationError('Prelabel phải chứa đúng một POLYGON_SET.');
  }
  const operation: unknown = payload.maskOperations[0];
  if (!isRecord(operation) || operation.type !== 'POLYGON_SET' || !Array.isArray(operation.polygons)) {
    throw new PrelabelValidationError('Prelabel thiếu POLYGON_SET hợp lệ.');
  }

  const polygonIds = new Set<string>();
  const nodeIds = new Set<string>();
  const polygons = operation.polygons.map((value, polygonIndex) => {
    const polygon: unknown = value;
    if (!isRecord(polygon) || typeof polygon.id !== 'string' || !polygon.id || polygonIds.has(polygon.id) ||
        typeof polygon.label !== 'string' ||
        (!['main_flesh_band', 'wart_flesh'].includes(polygon.label) && !/^[rw][1-9]\d*$/.test(polygon.label)) ||
        !Array.isArray(polygon.nodes) || polygon.nodes.length < 3) {
      throw new PrelabelValidationError(`Polygon prelabel không hợp lệ tại vị trí ${polygonIndex}.`);
    }
    polygonIds.add(polygon.id);
    if (polygon.holes !== undefined && (!Array.isArray(polygon.holes) ||
        polygon.holes.some((ring: unknown) => !Array.isArray(ring) || ring.length < 3))) {
      throw new PrelabelValidationError(`Holes prelabel không hợp lệ trong polygon ${polygon.id}.`);
    }
    const rings: unknown[][] = [polygon.nodes, ...(polygon.holes as unknown[][] | undefined ?? [])];
    for (const ring of rings) for (const node of ring) {
      if (!isRecord(node) || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) ||
          typeof node.x !== 'number' || typeof node.y !== 'number' ||
          !Number.isFinite(node.x) || !Number.isFinite(node.y) ||
          node.x < 0 || node.x > expectedWidth || node.y < 0 || node.y > expectedHeight) {
        throw new PrelabelValidationError(`Node prelabel không hợp lệ trong polygon ${polygon.id}.`);
      }
      nodeIds.add(node.id);
    }
    return polygon as unknown as AnnotationPolygon;
  });

  return [{ type: 'POLYGON_SET', polygons }];
}
