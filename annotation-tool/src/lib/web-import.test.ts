import { describe, expect, it } from 'vitest';
import { cocoCategories, cocoInstance } from './coco-export';
import { rasterizePolygons } from './mask-pixels';
import { parseWebPolygonImport } from './web-import';

const node = (id: string, x: number, y: number) => ({ id, x, y });
const source = {
  schemaVersion: 'bitter-melon-prelabel-1.1', imageId: '8582_01', coordinateSpace: 'image_pixels', width: 8, height: 6,
  maskOperations: [{ type: 'POLYGON_SET', polygons: [{ id: 'a', label: 'w1', nodes: [node('n1', 0, 0), node('n2', 5, 0), node('n3', 5, 5)],
    holes: [[node('h1', 1, 1), node('h2', 2, 1), node('h3', 2, 2)]] }] }],
};

describe('web polygon JSON import', () => {
  it('keeps polygon nodes and holes for the matching image', () => {
    const parsed = parseWebPolygonImport(source, '8582_01', 8, 6);
    expect(parsed.operations).toEqual(source.maskOperations);
  });
  it('rejects import into a different image or malformed geometry', () => {
    expect(() => parseWebPolygonImport(source, 'other', 8, 6)).toThrow(/khớp ảnh/);
    const duplicate = structuredClone(source);
    duplicate.maskOperations[0].polygons[0].holes[0][0].id = 'n1';
    expect(() => parseWebPolygonImport(duplicate, '8582_01', 8, 6)).toThrow(/trùng ID/);
  });
});

describe('COCO 1.0 import into the open image', () => {
  const categories = [{ id: 1, name: 'main_flesh_band' }, { id: 2, name: 'wart_flesh' }, { id: 9, name: 'background' }];
  const dataset = {
    images: [{ id: 4, file_name: 'images/default/8582_01.jpg', width: 8, height: 6 }, { id: 5, file_name: 'images/default/8582_02.jpg', width: 8, height: 6 }],
    annotations: [
      { id: 10, image_id: 4, category_id: 1, segmentation: [[0, 0, 4, 0, 4, 4, 0, 4]], iscrowd: 0 },
      { id: 11, image_id: 4, category_id: 9, segmentation: [[5, 0, 7, 0, 7, 2]], iscrowd: 0 },
      { id: 12, image_id: 5, category_id: 2, segmentation: [[1, 1, 3, 1, 3, 3]], iscrowd: 0 },
    ],
    categories,
  };

  it('picks the image by file name, maps categories to r*/w* and reports skipped ones', () => {
    const parsed = parseWebPolygonImport(dataset, '8582_01', 8, 6);
    const [operation] = parsed.operations;
    expect(operation.type).toBe('POLYGON_SET');
    const polygons = operation.type === 'POLYGON_SET' ? operation.polygons : [];
    expect(polygons.map((polygon) => polygon.label)).toEqual(['r1']);
    expect(polygons[0].nodes.map(({ x, y }) => [x, y])).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]]);
    expect(parsed.coco).toEqual({ fileName: 'images/default/8582_01.jpg', skipped: 1, invalid: 0, skippedCategories: ['background'] });
    expect(parsed.wartPoints).toBeUndefined();
  });

  it('round-trips the tool’s own COCO RLE export exactly, keeping instance labels', () => {
    const ring = (left: number, top: number, right: number, bottom: number) =>
      [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y], i) => ({ id: `n${i}`, x, y }));
    const source = { id: 'p', label: 'w5', nodes: ring(1, 1, 7, 5), holes: [ring(3, 2, 5, 4)] };
    const pixels = rasterizePolygons([source], 8, 6);
    const exported = {
      images: [{ id: 1, file_name: 'images/8582_01.jpg', width: 8, height: 6, external_key: '8582_01' }],
      annotations: [cocoInstance(source, pixels, 8, 6, 1, 1)],
      categories: cocoCategories,
    };
    const parsed = parseWebPolygonImport(JSON.parse(JSON.stringify(exported)), '8582_01', 8, 6);
    const polygons = parsed.operations[0].type === 'POLYGON_SET' ? parsed.operations[0].polygons : [];
    expect(polygons.every((polygon) => polygon.label === 'w5')).toBe(true);
    expect(rasterizePolygons(polygons, 8, 6)).toEqual(pixels);
  });

  it('uses the only image of a single-image file and rejects ambiguous, mismatched or empty files', () => {
    const single = { images: [{ id: 1, file_name: 'other-name.png', width: 8, height: 6 }], annotations: [dataset.annotations[0]].map((annotation) => ({ ...annotation, image_id: 1 })), categories };
    expect(parseWebPolygonImport(single, '8582_01', 8, 6).operations[0]).toMatchObject({ type: 'POLYGON_SET' });
    expect(() => parseWebPolygonImport(dataset, '9999_01', 8, 6)).toThrow(/không có ảnh 9999_01/);
    expect(() => parseWebPolygonImport(dataset, '8582_01', 9, 6)).toThrow(/kích thước/);
    const duplicate = { ...dataset, images: [...dataset.images, { id: 6, file_name: 'b/8582_01.png', width: 8, height: 6 }] };
    expect(() => parseWebPolygonImport(duplicate, '8582_01', 8, 6)).toThrow(/2 ảnh cùng tên/);
    expect(() => parseWebPolygonImport({ ...single, annotations: [] }, '8582_01', 8, 6)).toThrow(/không có annotation/);
    const onlyBackground = { ...single, annotations: [{ ...single.annotations[0], category_id: 9 }] };
    expect(() => parseWebPolygonImport(onlyBackground, '8582_01', 8, 6)).toThrow(/bị bỏ qua: background/);
  });
});
