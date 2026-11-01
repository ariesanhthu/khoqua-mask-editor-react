import type { AnnotationPolygon } from '../types/index';

export const cocoCategories = [
  { id: 1, name: 'main_flesh_band', supercategory: 'bitter_melon' },
  { id: 2, name: 'wart_flesh', supercategory: 'bitter_melon' },
  { id: 3, name: 'unclassified', supercategory: 'bitter_melon' },
];

/** Encode the actual binary pixels, not a second polygon rasterization by a different library.
 * COCO uncompressed RLE is column-major and starts with a background run, including zero.
 * Using RLE for every instance preserves holes, self-touching rings and overlapping instances.
 */
export function cocoInstance(polygon: AnnotationPolygon, pixels: Uint8Array, width: number, height: number, id: number, imageId: number) {
  if (pixels.length !== width * height) throw Error('COCO mask size mismatch');
  const counts: number[] = [];
  let previous = 0, run = 0, area = 0;
  let left = width, top = height, right = -1, bottom = -1;
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    const value = pixels[y * width + x] ? 1 : 0;
    if (value === previous) run++;
    else { counts.push(run); run = 1; previous = value; }
    if (value) { area++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  counts.push(run);
  const kind = polygon.meta?.semantic ?? (/^r[1-9]\d*$/i.test(polygon.label ?? '') ? 'main_flesh_band'
    : /^w[1-9]\d*$/i.test(polygon.label ?? '') ? 'wart_flesh' : polygon.label);
  return { id, image_id: imageId, category_id: kind === 'main_flesh_band' ? 1 : kind === 'wart_flesh' ? 2 : 3,
    segmentation: { size: [height, width], counts }, area,
    bbox: area ? [left, top, right - left + 1, bottom - top + 1] : [0, 0, 0, 0], iscrowd: 0,
    attributes: { polygon_id: polygon.id, label: polygon.label, meta: polygon.meta ?? null } };
}
