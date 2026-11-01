import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { annotationsByImage, buildPrelabelDocument, cocoImagePolygons, decodeCocoRle, guessCategoryTarget, isCocoDataset, type CategoryTarget, type CocoAnnotation } from './coco-import';
import { cocoInstance } from './coco-export';
import { rasterizePolygons } from './mask-pixels';
import { parsePrelabelOperations } from './prelabel-service';

/** Bản port của rleToString (pycocotools maskApi.c), chỉ dùng để kiểm bộ giải mã. */
function encodeRleString(counts: number[]): string {
  let text = '';
  counts.forEach((count, index) => {
    let value = index > 2 ? count - counts[index - 2] : count;
    let more = true;
    while (more) {
      let code = value & 0x1f;
      value >>= 5;
      more = code & 0x10 ? value !== -1 : value !== 0;
      if (more) code |= 0x20;
      text += String.fromCharCode(code + 48);
    }
  });
  return text;
}

/** Counts COCO theo cột, bắt đầu bằng một đoạn nền (có thể bằng 0). */
function columnMajorCounts(pixels: Uint8Array, width: number, height: number): number[] {
  const counts: number[] = [];
  let previous = 0;
  let run = 0;
  for (let x = 0; x < width; x += 1) for (let y = 0; y < height; y += 1) {
    const value = pixels[y * width + x] ? 1 : 0;
    if (value === previous) run += 1;
    else { counts.push(run); run = 1; previous = value; }
  }
  counts.push(run);
  return counts;
}

const targets = new Map<string, CategoryTarget>([['1', 'r'], ['2', 'w'], ['3', 'skip']]);

describe('COCO RLE decoding', () => {
  it('decodes uncompressed and pycocotools-compressed counts to the same row-major pixels', () => {
    let state = 7;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const [width, height] of [[1, 1], [3, 2], [17, 11], [64, 9]]) {
      const pixels = new Uint8Array(width * height).map(() => (random() < 0.45 ? 255 : 0));
      const counts = columnMajorCounts(pixels, width, height);
      expect(decodeCocoRle({ counts, size: [height, width] }, width, height)).toEqual(pixels);
      expect(decodeCocoRle({ counts: encodeRleString(counts), size: [height, width] }, width, height)).toEqual(pixels);
    }
  });

  it('handles large runs and negative deltas of the compressed string', () => {
    const counts = [5, 300, 3, 1, 40_000, 2];
    const decoded = decodeCocoRle({ counts: encodeRleString(counts), size: [200, 202] }, 202, 200);
    expect(decoded.reduce((sum, value) => sum + (value ? 1 : 0), 0)).toBe(300 + 1 + 2);
    expect(decodeCocoRle({ counts: '414', size: [3, 3] }, 3, 3)).toEqual(Uint8Array.from([0, 0, 0, 0, 255, 0, 0, 0, 0]));
  });

  it('reads back exactly what the tool exports as COCO', () => {
    const ring = (left: number, top: number, right: number, bottom: number) =>
      [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y], i) => ({ id: `n${left}${top}${i}`, x, y }));
    const polygon = { id: 'p', label: 'r1', nodes: ring(0, 0, 7, 5), holes: [ring(2, 1, 4, 3)] };
    const pixels = rasterizePolygons([polygon], 8, 6);
    const exported = cocoInstance(polygon, pixels, 8, 6, 1, 1);
    expect(decodeCocoRle(exported.segmentation as { counts: number[]; size: [number, number] }, 8, 6)).toEqual(pixels);
  });

  it('rejects RLE that does not fit the image', () => {
    expect(() => decodeCocoRle({ counts: [0, 4], size: [2, 3] }, 2, 2)).toThrow(/Kích thước/);
    expect(() => decodeCocoRle({ counts: [0, 5], size: [2, 2] }, 2, 2)).toThrow(/không hợp lệ/);
    expect(() => decodeCocoRle({ counts: '0~', size: [2, 2] }, 2, 2)).toThrow();
  });
});

describe('COCO annotations to editor polygons', () => {
  it('maps categories to r*/w* instance labels and skips unmapped ones', () => {
    const annotations: CocoAnnotation[] = [
      { id: 10, image_id: 1, category_id: 1, segmentation: [[1, 1, 6, 1, 6, 4]] },
      { id: 11, image_id: 1, category_id: 2, segmentation: [[0, 0, 2, 0, 2, 2, 0, 2], [4, 4, 6, 4, 6, 6]] },
      { id: 12, image_id: 1, category_id: 1, segmentation: [[2, 2, 5, 2, 5, 5]] },
      { id: 13, image_id: 1, category_id: 3, segmentation: [[0, 0, 1, 0, 1, 1]] },
    ];
    const result = cocoImagePolygons(annotations, targets, 8, 8);
    expect(result.skipped).toBe(1);
    expect(result.invalid).toBe(0);
    expect(result.polygons.map((polygon) => [polygon.id, polygon.label])).toEqual([
      ['coco-10-0', 'r1'], ['coco-11-0', 'w1'], ['coco-11-1', 'w1'], ['coco-12-0', 'r2'],
    ]);
    expect(result.polygons[1].meta).toEqual({ semantic: 'wart_flesh', wartId: 1 });
  });

  it('keeps labels exported by this tool and numbers the rest after them', () => {
    const annotations: CocoAnnotation[] = [
      { id: 1, image_id: 1, category_id: 2, segmentation: [[0, 0, 2, 0, 2, 2]], attributes: { label: 'w2' } },
      { id: 2, image_id: 1, category_id: 2, segmentation: [[3, 3, 5, 3, 5, 5]] },
      { id: 3, image_id: 1, category_id: 2, segmentation: [[0, 4, 2, 4, 2, 6]] },
      { id: 4, image_id: 1, category_id: 1, segmentation: [[4, 0, 6, 0, 6, 2]], attributes: { label: 'w9' } },
    ];
    expect(cocoImagePolygons(annotations, targets, 8, 8).polygons.map((polygon) => polygon.label)).toEqual(['w2', 'w1', 'w3', 'r1']);
  });

  it('clamps coordinates slightly outside the image and drops degenerate parts', () => {
    const result = cocoImagePolygons([
      { id: 1, image_id: 1, category_id: 1, segmentation: [[-0.5, -0.5, 8.4, 0, 8, 6.2, 0, 6, 0, 6]] },
      { id: 2, image_id: 1, category_id: 1, segmentation: [[1, 1, 2, 2, 3, 3]] },
      { id: 3, image_id: 1, category_id: 1, segmentation: [] },
    ], targets, 8, 6);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0].nodes.map(({ x, y }) => [x, y])).toEqual([[0, 0], [8, 0], [8, 6], [0, 6]]);
    expect(result.invalid).toBe(2);
  });

  it('vectorizes RLE instances pixel-exactly, including holes and separate parts', () => {
    const width = 12;
    const height = 9;
    const pixels = new Uint8Array(width * height);
    for (let y = 1; y < 7; y += 1) for (let x = 1; x < 7; x += 1) pixels[y * width + x] = 255;
    pixels[3 * width + 3] = 0;
    pixels[8 * width + 11] = 255;
    const result = cocoImagePolygons([
      { id: 5, image_id: 1, category_id: 2, iscrowd: 1, segmentation: { counts: encodeRleString(columnMajorCounts(pixels, width, height)), size: [height, width] } },
    ], targets, width, height);
    expect(result.polygons).toHaveLength(2);
    expect(new Set(result.polygons.map((polygon) => polygon.label))).toEqual(new Set(['w1']));
    expect(result.polygons.flatMap((polygon) => polygon.holes ?? [])).toHaveLength(1);
    expect(rasterizePolygons(result.polygons, width, height)).toEqual(pixels);
  });

  it('produces a prelabel the editor accepts unchanged', () => {
    const { polygons } = cocoImagePolygons([
      { id: 1, image_id: 'a', category_id: 1, segmentation: [[0, 0, 4, 0, 4, 3]] },
      { id: 2, image_id: 'a', category_id: 2, segmentation: { counts: [9, 2, 13], size: [4, 6] } },
    ], targets, 6, 4);
    const document = buildPrelabelDocument('8582_01', 6, 4, polygons);
    expect(parsePrelabelOperations(JSON.parse(JSON.stringify(document)), 6, 4)).toEqual([{ type: 'POLYGON_SET', polygons }]);
    expect(() => parsePrelabelOperations(document, 7, 4)).toThrow(/Kích thước/);
  });
});

describe('COCO dataset helpers', () => {
  it('recognizes a COCO instances file and groups annotations by image', () => {
    const dataset = { images: [{ id: 1, file_name: 'a.jpg', width: 2, height: 2 }], categories: [], annotations: [
      { id: 1, image_id: 1, category_id: 1 }, { id: 2, image_id: 2, category_id: 1 }, { id: 3, image_id: 1, category_id: 2 },
    ] };
    expect(isCocoDataset(dataset)).toBe(true);
    expect(isCocoDataset({ items: [] })).toBe(false);
    expect(annotationsByImage(dataset).get('1')?.map((annotation) => annotation.id)).toEqual([1, 3]);
  });

  it('suggests a target from English, Vietnamese and exported category names', () => {
    expect(guessCategoryTarget('wart_flesh')).toBe('w');
    expect(guessCategoryTarget('U vấu')).toBe('w');
    expect(guessCategoryTarget('main_flesh_band')).toBe('r');
    expect(guessCategoryTarget('Vết gợn')).toBe('r');
    expect(guessCategoryTarget('ridge')).toBe('r');
    expect(guessCategoryTarget('background')).toBe('skip');
    expect(guessCategoryTarget('unclassified')).toBe('skip');
  });
});
