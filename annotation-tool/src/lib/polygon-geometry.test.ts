import { describe, expect, it, vi } from 'vitest';
import {
  computeSmoothNodeDisplacements,
  createCirclePolygon,
  createRectanglePolygon,
  drawSmoothClosedPath,
  insertNodeAtEdge,
  mergePolygonsIntoSingle,
  polygonArea,
} from './polygon-geometry';

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

describe('createRectanglePolygon', () => {
  it('creates a 4-node clockwise polygon with correct bounds', () => {
    const poly = createRectanglePolygon({ x: 10, y: 20 }, { x: 50, y: 70 }, 'Test Rect');
    expect(poly.label).toBe('Test Rect');
    expect(poly.nodes.length).toBe(4);
    expect(poly.nodes[0]).toMatchObject({ x: 10, y: 20 });
    expect(poly.nodes[1]).toMatchObject({ x: 50, y: 20 });
    expect(poly.nodes[2]).toMatchObject({ x: 50, y: 70 });
    expect(poly.nodes[3]).toMatchObject({ x: 10, y: 70 });
    expect(Math.abs(polygonArea(poly.nodes))).toBeCloseTo(40 * 50);
  });

  it('handles reverse drag corners correctly', () => {
    const poly = createRectanglePolygon({ x: 80, y: 90 }, { x: 20, y: 30 });
    expect(poly.nodes[0]).toMatchObject({ x: 20, y: 30 });
    expect(poly.nodes[1]).toMatchObject({ x: 80, y: 30 });
    expect(poly.nodes[2]).toMatchObject({ x: 80, y: 90 });
    expect(poly.nodes[3]).toMatchObject({ x: 20, y: 90 });
  });
});

describe('createCirclePolygon', () => {
  it('creates circular polygon approximating area pi * r^2', () => {
    const radius = 20;
    const poly = createCirclePolygon({ x: 100, y: 100 }, radius, radius, 32, 'Test Circle');
    expect(poly.label).toBe('Test Circle');
    expect(poly.nodes.length).toBe(32);
    // Area of regular 32-gon with radius 20: 32 * 0.5 * r^2 * sin(2pi/32) ≈ 1248.57
    const expectedArea = 0.5 * 32 * radius * radius * Math.sin((2 * Math.PI) / 32);
    expect(Math.abs(polygonArea(poly.nodes))).toBeCloseTo(expectedArea, -1);
  });

  it('creates ellipse when rx != ry', () => {
    const poly = createCirclePolygon({ x: 50, y: 50 }, 30, 15, 24);
    expect(poly.nodes.length).toBe(24);
    expect(Math.abs(polygonArea(poly.nodes))).toBeGreaterThan(1000);
  });
});

describe('insertNodeAtEdge', () => {
  it('inserts an anchor point between edgeIndex and edgeIndex + 1', () => {
    const rect = createRectanglePolygon({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(rect.nodes.every((n) => !n.isAnchor)).toBe(true);
    const { polygon: updated, node } = insertNodeAtEdge(rect, 0, { x: 5, y: 0 });
    expect(updated.nodes.length).toBe(5);
    expect(updated.nodes[1].id).toBe(node.id);
    expect(updated.nodes[1].x).toBe(5);
    expect(updated.nodes[1].y).toBe(0);
    expect(node.isAnchor).toBe(true);
    expect(updated.nodes[1].isAnchor).toBe(true);
    expect(updated.meta?.source).toBe('human');
  });

  it('inserts an anchor point at the last edge (between last node and first node)', () => {
    const rect = createRectanglePolygon({ x: 0, y: 0 }, { x: 10, y: 10 });
    // Edge 3 connects node 3 (0, 10) to node 0 (0, 0)
    const { polygon: updated, node } = insertNodeAtEdge(rect, 3, { x: 0, y: 5 });
    expect(updated.nodes.length).toBe(5);
    expect(updated.nodes[4].id).toBe(node.id);
    expect(updated.nodes[4].x).toBe(0);
    expect(updated.nodes[4].y).toBe(5);
  });
});

describe('drawSmoothClosedPath', () => {
  it('does nothing when nodes length is less than 2', () => {
    const ctx = {
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
    };
    drawSmoothClosedPath(ctx, []);
    drawSmoothClosedPath(ctx, [{ x: 10, y: 10 }]);
    expect(ctx.moveTo).not.toHaveBeenCalled();
    expect(ctx.bezierCurveTo).not.toHaveBeenCalled();
    expect(ctx.closePath).not.toHaveBeenCalled();
  });

  it('draws a straight segment when nodes length is 2', () => {
    const ctx = {
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
    };
    drawSmoothClosedPath(ctx, [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    expect(ctx.moveTo).toHaveBeenCalledWith(10, 10);
    expect(ctx.lineTo).toHaveBeenCalledWith(20, 20);
    expect(ctx.bezierCurveTo).not.toHaveBeenCalled();
    expect(ctx.closePath).not.toHaveBeenCalled();
  });

  it('creates smooth Bézier spline loop for 3 or more points', () => {
    const ctx = {
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
    };
    const nodes = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    drawSmoothClosedPath(ctx, nodes, 0.16);
    expect(ctx.moveTo).toHaveBeenCalledWith(0, 0);
    expect(ctx.bezierCurveTo).toHaveBeenCalledTimes(4);
    expect(ctx.closePath).toHaveBeenCalledTimes(1);
    // End point of the last curve connects back to first point (nodes[0])
    expect(ctx.bezierCurveTo).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      nodes[0].x,
      nodes[0].y,
    );
  });
});

describe('computeSmoothNodeDisplacements', () => {
  it('moves only the active node when polygon has fewer than 5 nodes', () => {
    const nodes = [
      { id: 'n0', x: 0, y: 0 },
      { id: 'n1', x: 10, y: 0 },
      { id: 'n2', x: 10, y: 10 },
      { id: 'n3', x: 0, y: 10 },
    ];
    const active = new Set(['n1']);
    const updated = computeSmoothNodeDisplacements(nodes, active, 5, 2, 100, 100);
    expect(updated[1].x).toBe(15);
    expect(updated[1].y).toBe(2);
    expect(updated[0].x).toBe(0);
    expect(updated[2].x).toBe(10);
    expect(updated[3].x).toBe(0);
  });

  it('smoothly diffuses displacement to immediate neighbors for dense contours', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      x: i * 10,
      y: 0,
    }));
    const active = new Set(['n3']);
    const deltaX = 0;
    const deltaY = 10;
    const updated = computeSmoothNodeDisplacements(nodes, active, deltaX, deltaY, 200, 200);

    // Target node moves 100% (10px)
    expect(updated[3].y).toBe(10);

    // Immediate neighbors (dist = 1) get 45% (4.5px)
    expect(updated[2].y).toBe(4.5);
    expect(updated[4].y).toBe(4.5);

    // Distance 2 neighbors get 18% (1.8px)
    expect(updated[1].y).toBe(1.8);
    expect(updated[5].y).toBe(1.8);

    // Further nodes (dist >= 3 for n=8) stay at 0
    expect(updated[0].y).toBe(0);
    expect(updated[6].y).toBe(0);
    expect(updated[7].y).toBe(0);
  });

  it('stops diffusion when hitting a pinned anchor point (isAnchor === true)', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      x: i * 10,
      y: 0,
      isAnchor: i === 4, // n4 is pinned
    }));
    const active = new Set(['n3']);
    const updated = computeSmoothNodeDisplacements(nodes, active, 0, 10, 200, 200);

    // Pinned neighbor n4 must NOT move at all
    expect(updated[4].y).toBe(0);
    // Node n5 beyond pinned anchor also must NOT move
    expect(updated[5].y).toBe(0);

    // Counter-clockwise side still moves smoothly
    expect(updated[2].y).toBe(4.5);
    expect(updated[1].y).toBe(1.8);
  });
});
