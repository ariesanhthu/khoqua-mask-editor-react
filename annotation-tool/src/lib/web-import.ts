import type { AnnotationPolygon, BreakpointAnnotation, MaskOperation } from '@/types';
import { cocoImagePolygons, guessCategoryTarget, isCocoDataset, type CocoDataset } from './coco-import';

export interface WebPolygonImport {
  operations: MaskOperation[];
  wartPoints?: BreakpointAnnotation;
  /** Chỉ có khi file là COCO 1.0: ảnh được chọn và số annotation đã bỏ qua để báo cho người dùng. */
  coco?: { fileName: string; skipped: number; invalid: number; skippedCategories: string[] };
}

const fileStem = (fileName: string) => fileName.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');

/**
 * COCO 1.0 (CVAT `instances_*.json`, hoặc `coco.json` trong ZIP xuất của tool) cho **ảnh đang mở**:
 * chọn ảnh theo tên tệp (bỏ đuôi) hoặc `external_key` trùng mã ảnh; file chỉ có một ảnh thì dùng ảnh
 * đó. Danh mục được ánh xạ tự động như màn nhập thư mục (`guessCategoryTarget`): vết gợn → `r*`,
 * u vấu → `w*`, còn lại bỏ qua và được báo lại. Polygon/RLE đổi bằng cùng `cocoImagePolygons`.
 */
function parseCocoImport(dataset: CocoDataset, imageId: string, width: number, height: number): WebPolygonImport {
  const matches = dataset.images.filter((image) => fileStem(String(image.file_name ?? '')) === imageId
    || (image as { external_key?: unknown }).external_key === imageId);
  if (matches.length > 1) throw new Error(`File COCO có ${matches.length} ảnh cùng tên ${imageId}.`);
  const image = matches[0] ?? (dataset.images.length === 1 ? dataset.images[0] : undefined);
  if (!image) throw new Error(`File COCO không có ảnh ${imageId}.`);
  if (Number(image.width) !== width || Number(image.height) !== height) {
    throw new Error('JSON không khớp ảnh hoặc kích thước đang mở.');
  }
  const annotations = dataset.annotations.filter((annotation) => String(annotation.image_id) === String(image.id));
  if (!annotations.length) throw new Error('File COCO không có annotation nào cho ảnh này.');
  const targets = new Map(dataset.categories.map((category) => [String(category.id), guessCategoryTarget(String(category.name ?? ''))]));
  const conversion = cocoImagePolygons(annotations, targets, width, height);
  const skippedCategories = [...new Set(annotations
    .filter((annotation) => (targets.get(String(annotation.category_id)) ?? 'skip') === 'skip')
    .map((annotation) => String(dataset.categories.find((category) => String(category.id) === String(annotation.category_id))?.name ?? annotation.category_id)))];
  if (!conversion.polygons.length) {
    throw new Error(skippedCategories.length
      ? `Không có annotation vết gợn/u vấu để nhập (danh mục bị bỏ qua: ${skippedCategories.join(', ')}).`
      : 'Không đọc được hình học polygon/RLE nào trong file COCO.');
  }
  return {
    operations: [{ type: 'POLYGON_SET', polygons: conversion.polygons }],
    coco: { fileName: String(image.file_name ?? imageId), skipped: conversion.skipped, invalid: conversion.invalid, skippedCategories },
  };
}

export function parseWebPolygonImport(value: unknown, imageId: string, width: number, height: number): WebPolygonImport {
  if (!value || typeof value !== 'object') throw new Error('JSON không hợp lệ.');
  if (isCocoDataset(value)) return parseCocoImport(value, imageId, width, height);
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 'bitter-melon-prelabel-1.1' || input.coordinateSpace !== 'image_pixels') {
    throw new Error('File phải dùng schema bitter-melon-prelabel-1.1 với tọa độ image_pixels.');
  }
  if (input.imageId !== imageId || input.width !== width || input.height !== height) {
    throw new Error('JSON không khớp ảnh hoặc kích thước đang mở.');
  }
  if (!Array.isArray(input.maskOperations) || input.maskOperations.length !== 1
    || input.maskOperations[0]?.type !== 'POLYGON_SET' || !Array.isArray(input.maskOperations[0].polygons)) {
    throw new Error('JSON phải chứa đúng một POLYGON_SET.');
  }
  const polygons = input.maskOperations[0].polygons as AnnotationPolygon[];
  const polygonIds = new Set<string>(), nodeIds = new Set<string>();
  for (const polygon of polygons) {
    if (!polygon || typeof polygon.id !== 'string' || !polygon.id || polygonIds.has(polygon.id)
      || typeof polygon.label !== 'string' || !/^[rw][1-9]\d*$/.test(polygon.label)
      || !Array.isArray(polygon.nodes) || polygon.nodes.length < 3
      || (polygon.holes !== undefined && (!Array.isArray(polygon.holes)
        || polygon.holes.some(ring => !Array.isArray(ring) || ring.length < 3)))) {
      throw new Error('Polygon trong JSON không hợp lệ hoặc bị trùng ID.');
    }
    polygonIds.add(polygon.id);
    for (const node of [polygon.nodes, ...(polygon.holes ?? [])].flat()) {
      if (!node || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id)
        || !Number.isFinite(node.x) || !Number.isFinite(node.y)
        || node.x < 0 || node.x > width || node.y < 0 || node.y > height) {
        throw new Error('Node trong JSON không hợp lệ hoặc bị trùng ID.');
      }
      nodeIds.add(node.id);
    }
  }
  const wartPoints = input.wartPoints;
  return { operations: [{ type: 'POLYGON_SET', polygons }],
    wartPoints: wartPoints && typeof wartPoints === 'object' ? wartPoints as BreakpointAnnotation : undefined };
}
