import { describe, expect, it } from 'vitest';
import { mergePolygonsIntoSingle, polygonArea, resolvePolygonCut } from './polygon-geometry';

const polygon = (id: string, points: Array<[number, number]>, label = 'damage') => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});

const rectangle = (id: string, left: number, top: number, right: number, bottom: number, label = 'damage') => polygon(id, [
  [left, top], [right, top], [right, bottom], [left, bottom],
], label);

describe('resolvePolygonCut', () => {
  const target = rectangle('target', 10, 10, 30, 30, 'R1');
  // Both samples are outside: detection must use segment intersections.
  const path = polygon('cut', [[0, 20], [40, 20]]).nodes;

  it('detects a polygon from an outside-to-outside drag and preserves area and label', () => {
    const result = resolvePolygonCut([target], path);
    expect(result.targetId).toBe('target');
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons!.reduce((sum, item) => sum + Math.abs(polygonArea(item.nodes)), 0)).toBeCloseTo(400);
    expect(result.polygons!.every((item) => item.label === 'R1')).toBe(true);
    expect(target.nodes).toHaveLength(4);
  });

  it('requires manual selection when multiple polygons can be split', () => {
    const result = resolvePolygonCut([target, rectangle('other', 12, 12, 28, 28)], path);
    expect(result.polygons).toBeUndefined();
    expect(result.error).toContain('nhiều polygon');
  });

  it('honors a manual target for an ambiguous path', () => {
    const result = resolvePolygonCut([target, rectangle('other', 12, 12, 28, 28)], path, 'other');
    expect(result.targetId).toBe('other');
    expect(result.polygons).toHaveLength(2);
  });

  it('excludes locked polygons from detection and rejects manual cutting of them', () => {
    const locked = { ...target, meta: { locked: true } };
    expect(resolvePolygonCut([locked], path).polygons).toBeUndefined();
    expect(resolvePolygonCut([locked], path, target.id).error).toContain('đang khóa');
    expect(resolvePolygonCut([locked, rectangle('other', 12, 12, 28, 28)], path).targetId).toBe('other');
  });

  it('does not fall back to another polygon when the manual target is invalid', () => {
    expect(resolvePolygonCut([target], path, 'missing').polygons).toBeUndefined();
    const missed = rectangle('missed', 50, 50, 70, 70);
    expect(resolvePolygonCut([target, missed], path, missed.id).polygons).toBeUndefined();
  });

  it('leaves polygons intact for incomplete or non-crossing paths', () => {
    for (const points of [[], [[0, 0]], [[0, 0], [40, 0]], [[0, 20], [20, 20]]] as Array<Array<[number, number]>>) {
      expect(resolvePolygonCut([target], polygon('path', points).nodes).polygons).toBeUndefined();
    }
  });
});

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

  it('merges mixed labels and keeps the first polygon label', () => {
    const result = mergePolygonsIntoSingle([
      rectangle('a', 0, 0, 10, 10, 'one'), rectangle('b', 5, 0, 15, 10, 'two'),
    ]);
    expect(result.polygon?.label).toBe('one');
  });

  it('repairs a self-intersecting input ring before merging', () => {
    expectValid(mergePolygonsIntoSingle([
      polygon('bow', [[0, 0], [10, 10], [0, 10], [10, 0]]),
      rectangle('valid', 20, 0, 30, 10),
    ]));
  });

  it('fills holes because the annotation model stores one outer ring', () => {
    const merged = expectValid(mergePolygonsIntoSingle([
      rectangle('top', 0, 0, 30, 5),
      rectangle('bottom', 0, 25, 30, 30),
      rectangle('left', 0, 5, 5, 25),
      rectangle('right', 25, 5, 30, 25),
    ]));
    expect(Math.abs(polygonArea(merged.nodes))).toBeCloseTo(900);
  });
});
