import { describe, expect, it } from 'vitest';
import { cocoInstance } from './coco-export';
import { rasterizePolygons } from './mask-pixels';

describe('COCO exact instance encoding', () => {
  const ring = (left: number, top: number, right: number, bottom: number) =>
    [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y], i) => ({ id: String(i), x, y }));
  it('keeps holes, single pixel regions and column-major order', () => {
    const polygon = { id: 'p', label: 'r1', nodes: ring(0, 0, 3, 4), holes: [ring(1, 1, 2, 3)] };
    const pixels = rasterizePolygons([polygon], 3, 4);
    const result = cocoInstance(polygon, pixels, 3, 4, 1, 7);
    expect(result).toMatchObject({ image_id: 7, category_id: 1, area: 10, bbox: [0, 0, 3, 4], iscrowd: 0 });
    expect(result.segmentation).toEqual({ size: [4, 3], counts: [0, 5, 2, 5] });
    const tiny = { id: 't', label: 'w2', nodes: ring(2, 3, 3, 4) };
    expect(cocoInstance(tiny, rasterizePolygons([tiny], 3, 4), 3, 4, 2, 7))
      .toMatchObject({ category_id: 2, area: 1, bbox: [2, 3, 1, 1], segmentation: { size: [4, 3], counts: [11, 1] } });
  });
  it('does not guess unknown labels or fabricate pixels for subpixel geometry', () => {
    const polygon = { id: 'p', label: 'custom', nodes: ring(0.1, 0.1, 0.2, 0.2) };
    expect(cocoInstance(polygon, rasterizePolygons([polygon], 2, 2), 2, 2, 1, 1))
      .toMatchObject({ category_id: 3, area: 0, bbox: [0, 0, 0, 0], segmentation: { counts: [4] } });
  });
});
