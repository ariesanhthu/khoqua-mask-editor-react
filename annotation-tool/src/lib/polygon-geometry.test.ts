import { describe, expect, it } from 'vitest';
import { mergePolygonsIntoSingle, polygonArea } from './polygon-geometry';

const polygon = (id: string, points: Array<[number, number]>, label = 'damage') => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});

const rectangle = (id: string, left: number, top: number, right: number, bottom: number, label = 'damage') => polygon(id, [
  [left, top], [right, top], [right, bottom], [left, bottom],
], label);

function expectValid(result: ReturnType<typeof mergePolygonsIntoSingle>) {
  expect(result.error).toBeUndefined();
  expect(result.polygon).toBeDefined();
  const nodes = result.polygon!.nodes;
  expect(nodes.length).toBeGreaterThanOrEqual(3);
  expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  expect(Math.abs(polygonArea(nodes))).toBeGreaterThan(1e-6);
  expect(nodes.every((node, index) => {
    const next = nodes[(index + 1) % nodes.length];
    return Math.hypot(node.x - next.x, node.y - next.y) > 1e-6;
  })).toBe(true);
  return result.polygon!;
}

describe('mergePolygonsIntoSingle', () => {
  it('unions overlapping polygons exactly', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10), rectangle('b', 5, 0, 15, 10),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeCloseTo(150);
  });

  it('keeps only the outer polygon for containment', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('outer', 0, 0, 10, 10), rectangle('inner', 2, 2, 8, 8),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeCloseTo(100);
  });

  it('deduplicates identical polygons', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10), rectangle('b', 0, 0, 10, 10),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeCloseTo(100);
  });

  it('removes the internal edge when polygons share an edge', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10), rectangle('b', 10, 0, 20, 10),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeCloseTo(200);
    expect(merged.nodes.length).toBe(4);
  });

  it('bridges polygons that only touch at a point', () => {
    expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10), rectangle('b', 10, 10, 20, 20),
    ]));
  });

  it('bridges two disconnected polygons', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10), rectangle('b', 30, 0, 40, 10),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeGreaterThan(200);
  });

  it('connects three disconnected polygons with an MST', () => {
    expectValid(mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10),
      rectangle('b', 30, 0, 40, 10),
      rectangle('c', 30, 30, 40, 40),
    ]));
  });

  it('rejects mixed labels', () => {
    const result = mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10, 'one'), rectangle('b', 5, 0, 15, 10, 'two'),
    ]);
    expect(result.polygon).toBeUndefined();
    expect(result.error).toContain('label khác nhau');
  });

  it('rejects a self-intersecting input ring', () => {
    const result = mergePolygonsIntoSingle([
      polygon('bow', [[0, 0], [10, 10], [0, 10], [10, 0]]),
      rectangle('valid', 20, 0, 30, 10),
    ]);
    expect(result.polygon).toBeUndefined();
    expect(result.error).toContain('không hợp lệ');
  });

  it('rejects a union that produces a hole', () => {
    const result = mergePolygonsIntoSingle([
      rectangle('top', 0, 0, 30, 5),
      rectangle('bottom', 0, 25, 30, 30),
      rectangle('left', 0, 5, 5, 25),
      rectangle('right', 25, 5, 30, 25),
    ]);
    expect(result.polygon).toBeUndefined();
    expect(result.error).toContain('vùng rỗng');
  });
});
