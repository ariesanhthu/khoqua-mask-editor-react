import { describe, expect, it } from 'vitest';
import { applyBrushStroke, mergePolygonsIntoSingle, polygonArea, resolvePolygonCut, pointInMask, clonePolygons } from './polygon-geometry';

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

describe('applyBrushStroke', () => {
  const newRegion = { label: 'r9', meta: { semantic: 'main_flesh_band' as const } };
  const target = () => rectangle('target', 10, 10, 30, 30, 'r1');
  const totalArea = (polygons: Array<{ nodes: Array<{ x: number; y: number }> }>) => polygons
    .reduce((sum, polygon) => sum + Math.abs(polygonArea(polygon.nodes)), 0);

  it('splits a mask into two separate regions that keep the same label', () => {
    const source = target();
    const result = applyBrushStroke(
      [source], [{ x: 20, y: 0 }, { x: 20, y: 40 }], 2, 'erase', newRegion,
    );
    expect(result.error).toBeUndefined();
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons!.every((polygon) => polygon.label === 'r1')).toBe(true);
    expect(new Set(result.polygons!.map((polygon) => polygon.id)).size).toBe(2);
    expect(result.resultIds).toEqual(result.polygons!.map((polygon) => polygon.id));
    expect(totalArea(result.polygons!)).toBeCloseTo(320);
    expect(source.nodes).toHaveLength(4);
  });

  it('preserves a hole erased strictly inside a mask', () => {
    const result = applyBrushStroke([target()], [{ x: 20, y: 20 }], 3, 'erase', newRegion);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons![0].holes).toHaveLength(1);
    expect(pointInMask({ x: 20, y: 20 }, result.polygons![0])).toBe(false);
  });

  it('shaves a mask when the stroke only reaches one edge', () => {
    const result = applyBrushStroke([target()], [{ x: 0, y: 20 }, { x: 15, y: 20 }], 2, 'erase', newRegion);
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons![0].holes ?? []).toHaveLength(0);
    expect(totalArea(result.polygons!)).toBeLessThan(400);
  });

  it('merges two regions the brush connects and keeps the largest label', () => {
    const small = rectangle('small', 0, 0, 10, 10, 'r1');
    const large = rectangle('large', 30, 0, 50, 20, 'r2');
    const result = applyBrushStroke(
      [small, large], [{ x: 5, y: 5 }, { x: 35, y: 10 }], 1, 'add', newRegion,
    );
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons![0].label).toBe('r2');
    expect(totalArea(result.polygons!)).toBeGreaterThan(500);
  });

  it('creates a new region when the brush touches nothing', () => {
    const source = target();
    const result = applyBrushStroke([source], [{ x: 100, y: 100 }], 5, 'add', newRegion);
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons![0]).toBe(source);
    expect(result.polygons![1].label).toBe('r9');
    expect(result.polygons![1].meta).toEqual({ semantic: 'main_flesh_band', source: 'human' });
    expect(result.resultIds).toEqual([result.polygons![1].id]);
  });

  it('grows a region in place without touching the other polygons', () => {
    const other = rectangle('other', 100, 100, 120, 120, 'r2');
    const result = applyBrushStroke([target(), other], [{ x: 29, y: 20 }, { x: 34, y: 20 }], 2, 'add', newRegion);
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons![0].label).toBe('r1');
    expect(Math.abs(polygonArea(result.polygons![0].nodes))).toBeGreaterThan(400);
    expect(result.polygons![1]).toBe(other);
  });

  it('leaves locked polygons untouched', () => {
    const locked = { ...target(), meta: { locked: true } };
    const stroke = [{ x: 20, y: 0 }, { x: 20, y: 40 }];
    expect(applyBrushStroke([locked], stroke, 2, 'erase', newRegion).error).toContain('chưa chạm');
    const painted = applyBrushStroke([locked], stroke, 2, 'add', newRegion);
    expect(painted.polygons).toHaveLength(2);
    expect(painted.polygons![0]).toBe(locked);
    expect(painted.polygons![1].label).toBe('r9');
  });

  it('rejects strokes that fall outside the image or miss every mask', () => {
    expect(applyBrushStroke([target()], [], 4, 'erase', newRegion).polygons).toBeUndefined();
    expect(applyBrushStroke([target()], [{ x: 90, y: 90 }], 4, 'erase', newRegion).error).toContain('chưa chạm');
    const outside = applyBrushStroke([target()], [{ x: 90, y: 90 }], 4, 'add', newRegion, { width: 40, height: 40 });
    expect(outside.polygons).toBeUndefined();
    expect(outside.error).toContain('ngoài ảnh');
  });

  it('clips strokes to the image bounds', () => {
    const result = applyBrushStroke([], [{ x: 0, y: 0 }], 10, 'add', newRegion, { width: 40, height: 40 });
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons![0].nodes.every((node) => node.x >= -1e-6 && node.y >= -1e-6)).toBe(true);
  });
});

describe('thin brush precision', () => {
  it.each([1, 2, 8])('cuts separate masks with a %s px gap', (size) => {
    const result = applyBrushStroke([rectangle('mask', 0, 0, 100, 100)],
      [{ x: 50, y: -5 }, { x: 50, y: 105 }], size / 2, 'erase', { label: 'R1' });
    expect(result.error).toBeUndefined();
    expect(result.polygons).toHaveLength(2);
    const pieces = result.polygons!.sort((a, b) => a.nodes[0].x - b.nodes[0].x);
    const leftEdge = Math.max(...pieces[0].nodes.map((node) => node.x));
    const rightEdge = Math.min(...pieces[1].nodes.map((node) => node.x));
    expect(rightEdge - leftEdge).toBeCloseTo(size, 5);
    expect(pieces[0].id).not.toBe(pieces[1].id);
    expect(pieces.reduce((sum, item) => sum + Math.abs(polygonArea(item.nodes)), 0)).toBeCloseTo(10000 - size * 100, 5);
  });

  it('retains a single 1 px dab as a new region', () => {
    const result = applyBrushStroke([], [{ x: 10, y: 10 }], 0.5, 'add', { label: 'R1' });
    expect(result.error).toBeUndefined();
    expect(result.polygons).toHaveLength(1);
    expect(Math.abs(polygonArea(result.polygons![0].nodes))).toBeGreaterThan(0.7);
  });
});


describe('brush local union with inner boundaries', () => {
  const newRegion = { label: 'R1' };
  const stroke = (items: Parameters<typeof applyBrushStroke>[0], points: Array<{ x: number; y: number }>, mode: 'add' | 'erase' = 'add') => {
    const result = applyBrushStroke(items, points, 1, mode, newRegion);
    expect(result.error).toBeUndefined();
    return result.polygons!;
  };

  it('connects only painted bridges and retains the enclosed unpainted gap across edits and reload', () => {
    const sides = [rectangle('left', 0, 0, 10, 50), rectangle('right', 40, 0, 50, 50)];
    const top = stroke(sides, [{ x: 5, y: 5 }, { x: 45, y: 5 }]);
    expect(top).toHaveLength(1);
    expect(pointInMask({ x: 25, y: 25 }, top[0])).toBe(false);
    const closed = stroke(top, [{ x: 5, y: 45 }, { x: 45, y: 45 }]);
    expect(closed).toHaveLength(1);
    expect(closed[0].holes).toHaveLength(1);
    expect(pointInMask({ x: 25, y: 25 }, closed[0])).toBe(false);
    expect(pointInMask({ x: 25, y: 45 }, closed[0])).toBe(true);
    expect(closed[0].holes![0].some((node) => node.x === 10 && node.y === 44)).toBe(true);
    const saved = clonePolygons(JSON.parse(JSON.stringify(closed)));
    expect(saved).toEqual(closed);
    expect(saved[0].holes![0]).not.toBe(closed[0].holes![0]);
    const repainted = stroke(saved, [{ x: 5, y: 20 }, { x: 12, y: 20 }]);
    expect(pointInMask({ x: 25, y: 25 }, repainted[0])).toBe(false);
    expect(pointInMask({ x: 11, y: 20 }, repainted[0])).toBe(true);
    const reopened = stroke(repainted, [{ x: 25, y: 40 }, { x: 25, y: 50 }], 'erase');
    expect(reopened).toHaveLength(1);
    expect(reopened[0].holes ?? []).toHaveLength(0);
    expect(pointInMask({ x: 25, y: 25 }, reopened[0])).toBe(false);
  });

  it('keeps a loop painted on empty space hollow', () => {
    const result = stroke([], [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 45 }, { x: 5, y: 45 }, { x: 5, y: 5 }]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(1);
    expect(pointInMask({ x: 25, y: 25 }, result[0])).toBe(false);
  });
});
