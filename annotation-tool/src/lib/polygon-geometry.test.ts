import { describe, expect, it, vi } from 'vitest';
import {
  clipPolygonDifference,
  computeSmoothNodeDisplacements,
  createCirclePolygon,
  createRectanglePolygon,
  drawSmoothClosedPath,
  ensurePolygonHasNodeAt,
  findSnapTargetToPolygons,
  getSharedBoundaryAutofillPath,
  getSmoothSegmentControlPoints,
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

  it('gently curves corners with bounded offset without loops or bulging ears (zero cuc loi ra)', () => {
    // 90 degree corner at (100, 0)
    const { cp1, cp2 } = getSmoothSegmentControlPoints(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    );
    // Control points should gently round the corner with offset strictly bounded within 22% of segment length
    expect(cp1.x).toBeGreaterThan(100);
    expect(cp1.x).toBeLessThanOrEqual(100 + 100 * 0.22);
    expect(cp1.y).toBeGreaterThan(0);
    expect(cp1.y).toBeLessThan(100);
    expect(cp2.x).toBeGreaterThan(100);
    expect(cp2.x).toBeLessThanOrEqual(100 + 100 * 0.22);
    expect(cp2.y).toBeGreaterThan(0);
    expect(cp2.y).toBeLessThan(100);
  });

  it('smooths gentle curves on round contours', () => {
    // 4 points forming gentle 30 degree turns
    const { cp1, cp2 } = getSmoothSegmentControlPoints(
      { x: 0, y: 0 },
      { x: 20, y: 5 },
      { x: 40, y: 12 },
      { x: 60, y: 22 },
      0.16,
    );
    expect(cp1.x).toBeGreaterThan(20);
    expect(cp2.x).toBeLessThan(40);
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

describe('findSnapTargetToPolygons', () => {
  const rect = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });

  it('snaps to vertex when within vertex tolerance', () => {
    const snap = findSnapTargetToPolygons([rect], { x: 2, y: 1 }, 10);
    expect(snap).not.toBeNull();
    expect(snap?.isVertex).toBe(true);
    expect(snap?.point).toEqual({ x: 0, y: 0 });
  });

  it('snaps to edge when near edge but far from vertices', () => {
    const snap = findSnapTargetToPolygons([rect], { x: 50, y: 3 }, 10);
    expect(snap).not.toBeNull();
    expect(snap?.isVertex).toBe(false);
    expect(snap?.point.x).toBeCloseTo(50);
    expect(snap?.point.y).toBeCloseTo(0);
  });

  it('respects excludePolygonId', () => {
    const snap = findSnapTargetToPolygons([rect], { x: 50, y: 3 }, 10, rect.id);
    expect(snap).toBeNull();
  });
});

describe('getSharedBoundaryAutofillPath', () => {
  it('extracts shared boundary between two touch points on adjacent mask without enclosing it', () => {
    // Target wart A: 100x100 square
    const wartA = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });
    // User drawing Wart B adjacent to the right of Wart A:
    // Start at (100, 20), loops outside to (150, 50), ends at (100, 80)
    const startPoint = { x: 100, y: 20 };
    const draftNodes = [
      startPoint,
      { x: 150, y: 50 },
      { x: 100, y: 80 },
    ];
    const endPoint = { x: 100, y: 80 };

    const sharedPath = getSharedBoundaryAutofillPath(wartA, startPoint, endPoint, draftNodes);
    expect(sharedPath).not.toBeNull();
    // Since start and end are on edge 1 (from (100,0) to (100,100)),
    // the direct edge connects (100, 80) directly back to (100, 20)
    // without wrapping around vertices (0,100), (0,0), (100,0)
    expect(sharedPath?.length).toBe(0);
  });

  it('includes intermediate boundary vertices when contact points span multiple edges', () => {
    // 8-gon approximating a round wart
    const wartA = createCirclePolygon({ x: 100, y: 100 }, 50, 50, 8);
    // Touching at node 1 and node 3
    const pStart = { x: wartA.nodes[1].x, y: wartA.nodes[1].y };
    const pEnd = { x: wartA.nodes[3].x, y: wartA.nodes[3].y };
    const draft = [
      pStart,
      { x: 200, y: 100 },
      pEnd,
    ];

    const sharedPath = getSharedBoundaryAutofillPath(wartA, pStart, pEnd, draft);
    expect(sharedPath).not.toBeNull();
    // Shorter path along wart A between node 3 and node 1 passes through node 2
    expect(sharedPath?.some((n) => Math.hypot(n.x - wartA.nodes[2].x, n.y - wartA.nodes[2].y) < 1)).toBe(true);
  });
});

describe('ensurePolygonHasNodeAt', () => {
  it('reuses existing vertex if point is within tolerance', () => {
    const rect = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });
    const { polygon: updated, node, inserted } = ensurePolygonHasNodeAt(rect, { x: 1, y: 0 }, 4);
    expect(inserted).toBe(false);
    expect(node.id).toBe(rect.nodes[0].id);
    expect(updated.nodes.length).toBe(4);
  });

  it('inserts a new node on the edge if not matching any existing vertex', () => {
    const rect = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });
    const { polygon: updated, node, inserted } = ensurePolygonHasNodeAt(rect, { x: 50, y: 0 }, 2);
    expect(inserted).toBe(true);
    expect(updated.nodes.length).toBe(5);
    expect(node.x).toBe(50);
    expect(node.y).toBe(0);
  });
});

describe('clipPolygonDifference', () => {
  it('clips overlapping area from subject polygon so its boundary conforms to clip polygon', () => {
    // Subject Wart B: [80, 0] to [180, 100]
    const wartB = createRectanglePolygon({ x: 80, y: 0 }, { x: 180, y: 100 });
    // Adjacent Wart A: [0, 0] to [100, 100]
    const wartA = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });

    const clipped = clipPolygonDifference(wartB.nodes, wartA.nodes);
    expect(clipped).not.toBeNull();
    // Clipped Wart B should now start at x=100 instead of overlapping from x=80
    expect(clipped!.every((node) => node.x >= 99.9)).toBe(true);
    expect(clipped!.some((node) => Math.abs(node.x - 100) < 1)).toBe(true);
  });

  it('returns null when polygons do not intersect meaningfully', () => {
    const wartB = createRectanglePolygon({ x: 120, y: 0 }, { x: 200, y: 100 });
    const wartA = createRectanglePolygon({ x: 0, y: 0 }, { x: 100, y: 100 });
    const clipped = clipPolygonDifference(wartB.nodes, wartA.nodes);
    expect(clipped).toBeNull();
  });
});
