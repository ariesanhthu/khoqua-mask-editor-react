import type { AnnotationPolygon, PolygonNode } from '@/types';
import polygonClipping from 'polygon-clipping';

const EPSILON = 1e-6;
const GEOMETRY_EPSILON = 1e-6;
const MIN_BRIDGE_WIDTH = 2;
const MAX_BRIDGE_WIDTH = 8;

type GeometryPoint = [number, number];
type GeometryRing = GeometryPoint[];
type GeometryPolygon = GeometryRing[];
type GeometryMultiPolygon = GeometryPolygon[];

export interface MergePolygonsResult {
  polygon?: AnnotationPolygon;
  error?: string;
}

interface Intersection {
  edgeIndex: number;
  cutSegmentIndex: number;
  edgeT: number;
  cutT: number;
  x: number;
  y: number;
}

export interface SplitPolygonResult {
  polygons?: [AnnotationPolygon, AnnotationPolygon];
  error?: string;
}

const createId = () => crypto.randomUUID();
const distance = (a: Pick<PolygonNode, 'x' | 'y'>, b: Pick<PolygonNode, 'x' | 'y'>) => Math.hypot(a.x - b.x, a.y - b.y);

const pointsEqual = (a: GeometryPoint, b: GeometryPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= GEOMETRY_EPSILON;

function ringArea(ring: GeometryRing): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function orientation(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint): boolean {
  return Math.abs(orientation(start, end, point)) <= GEOMETRY_EPSILON
    && point[0] >= Math.min(start[0], end[0]) - GEOMETRY_EPSILON
    && point[0] <= Math.max(start[0], end[0]) + GEOMETRY_EPSILON
    && point[1] >= Math.min(start[1], end[1]) - GEOMETRY_EPSILON
    && point[1] <= Math.max(start[1], end[1]) + GEOMETRY_EPSILON;
}

function segmentsIntersect(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint, d: GeometryPoint): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) || (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON))
    && ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) || (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))) return true;
  return (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b))
    || (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b))
    || (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d))
    || (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d));
}

function ringSelfIntersects(ring: GeometryRing): boolean {
  for (let first = 0; first < ring.length; first += 1) {
    const firstNext = (first + 1) % ring.length;
    for (let second = first + 1; second < ring.length; second += 1) {
      const secondNext = (second + 1) % ring.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(ring[first], ring[firstNext], ring[second], ring[secondNext])) return true;
    }
  }
  return false;
}

function normalizeRing(nodes: Array<Pick<PolygonNode, 'x' | 'y'> | GeometryPoint>): GeometryRing | null {
  const coordinates = nodes.map((node): GeometryPoint => Array.isArray(node) ? [node[0], node[1]] : [node.x, node.y]);
  if (coordinates.length < 3 || coordinates.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  let ring: GeometryRing = coordinates;
  if (ring.length > 1 && pointsEqual(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
  ring = ring.filter((point, index) => index === 0 || !pointsEqual(point, ring[index - 1]));
  if (ring.length > 1 && pointsEqual(ring[0], ring[ring.length - 1])) ring.pop();

  let changed = true;
  while (changed && ring.length >= 3) {
    changed = false;
    ring = ring.filter((current, index) => {
      const previous = ring[(index - 1 + ring.length) % ring.length];
      const next = ring[(index + 1) % ring.length];
      const base = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      const collinear = Math.abs(orientation(previous, current, next)) <= GEOMETRY_EPSILON * Math.max(1, base);
      const between = (current[0] - previous[0]) * (current[0] - next[0])
        + (current[1] - previous[1]) * (current[1] - next[1]) <= GEOMETRY_EPSILON;
      if (pointsEqual(previous, current) || (collinear && between)) {
        changed = true;
        return false;
      }
      return true;
    });
  }
  if (ring.length < 3 || Math.abs(ringArea(ring)) <= GEOMETRY_EPSILON || ringSelfIntersects(ring)) return null;
  return ring;
}

function convexHull(points: GeometryRing): GeometryRing {
  const unique = [...new Map(points
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .map((point) => [`${point[0]},${point[1]}`, point] as const)).values()]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (unique.length <= 3) return unique;
  const cross = (origin: GeometryPoint, a: GeometryPoint, b: GeometryPoint) => (
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
  );
  const lower: GeometryRing = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= GEOMETRY_EPSILON) lower.pop();
    lower.push(point);
  }
  const upper: GeometryRing = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= GEOMETRY_EPSILON) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function closestPointOnGeometrySegment(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint): GeometryPoint {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= GEOMETRY_EPSILON * GEOMETRY_EPSILON) return [...start];
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return [start[0] + t * dx, start[1] + t * dy];
}

function closestBoundaryPoints(ringA: GeometryRing, ringB: GeometryRing) {
  let best = { distance: Number.POSITIVE_INFINITY, pointA: { x: 0, y: 0 }, pointB: { x: 0, y: 0 } };
  const consider = (pointA: GeometryPoint, pointB: GeometryPoint) => {
    const candidateDistance = Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1]);
    if (candidateDistance < best.distance) best = {
      distance: candidateDistance,
      pointA: { x: pointA[0], y: pointA[1] },
      pointB: { x: pointB[0], y: pointB[1] },
    };
  };
  for (let aIndex = 0; aIndex < ringA.length; aIndex += 1) {
    const a1 = ringA[aIndex];
    const a2 = ringA[(aIndex + 1) % ringA.length];
    for (let bIndex = 0; bIndex < ringB.length; bIndex += 1) {
      const b1 = ringB[bIndex];
      const b2 = ringB[(bIndex + 1) % ringB.length];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        const candidates: GeometryPoint[] = [a1, a2, b1, b2];
        const contact = candidates.find((point) => pointOnSegment(point, a1, a2) && pointOnSegment(point, b1, b2)) || a1;
        return { distance: 0, pointA: { x: contact[0], y: contact[1] }, pointB: { x: contact[0], y: contact[1] } };
      }
      consider(a1, closestPointOnGeometrySegment(a1, b1, b2));
      consider(a2, closestPointOnGeometrySegment(a2, b1, b2));
      const b1Projection = closestPointOnGeometrySegment(b1, a1, a2);
      consider(b1Projection, b1);
      const b2Projection = closestPointOnGeometrySegment(b2, a1, a2);
      consider(b2Projection, b2);
    }
  }
  return best;
}

function ringThickness(ring: GeometryRing): number {
  let perimeter = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const next = ring[(index + 1) % ring.length];
    perimeter += Math.hypot(next[0] - ring[index][0], next[1] - ring[index][1]);
  }
  return perimeter <= GEOMETRY_EPSILON ? MIN_BRIDGE_WIDTH : 2 * Math.abs(ringArea(ring)) / perimeter;
}

function createBridge(pointA: { x: number; y: number }, pointB: { x: number; y: number }, width: number): GeometryPolygon {
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  const length = Math.hypot(dx, dy);
  const halfWidth = width / 2;
  if (length <= GEOMETRY_EPSILON) {
    return [[
      [pointA.x, pointA.y - halfWidth],
      [pointA.x + halfWidth, pointA.y],
      [pointA.x, pointA.y + halfWidth],
      [pointA.x - halfWidth, pointA.y],
    ]];
  }
  const directionX = dx / length;
  const directionY = dy / length;
  const normalX = -directionY * halfWidth;
  const normalY = directionX * halfWidth;
  const extension = Math.min(halfWidth, 1);
  const startX = pointA.x - directionX * extension;
  const startY = pointA.y - directionY * extension;
  const endX = pointB.x + directionX * extension;
  const endY = pointB.y + directionY * extension;
  return [[
    [startX + normalX, startY + normalY],
    [endX + normalX, endY + normalY],
    [endX - normalX, endY - normalY],
    [startX - normalX, startY - normalY],
  ]];
}

function unionGeometries(geometries: GeometryPolygon[]): GeometryMultiPolygon {
  const union = polygonClipping.union as unknown as (...items: GeometryPolygon[]) => GeometryMultiPolygon;
  return union(...geometries);
}

export function mergePolygonsIntoSingle(polygons: AnnotationPolygon[]): MergePolygonsResult {
  if (polygons.length < 2) return { error: 'Chọn ít nhất 2 polygon để gộp.' };

  const rings: GeometryRing[] = [];
  for (const polygon of polygons) {
    const rawRing = polygon.nodes.map((node): GeometryPoint => [node.x, node.y]);
    const ring = normalizeRing(rawRing) || normalizeRing(convexHull(rawRing));
    if (!ring) return { error: 'Không thể gộp vì có polygon không hợp lệ hoặc tự giao nhau.' };
    rings.push(ring);
  }

  let components: GeometryMultiPolygon;
  try {
    components = unionGeometries(rings.map((ring) => [ring]));
  } catch {
    return { error: 'Không thể gộp vì hình học polygon không hợp lệ.' };
  }
  if (!components.length) return { error: 'Không thể gộp polygon.' };
  // AnnotationPolygon stores one outer ring, so holes are intentionally filled.
  components = components.map((component) => [component[0]]);

  if (components.length > 1) {
    const edges: Array<{ from: number; to: number; distance: number; pointA: { x: number; y: number }; pointB: { x: number; y: number } }> = [];
    for (let from = 0; from < components.length; from += 1) {
      for (let to = from + 1; to < components.length; to += 1) {
        edges.push({ from, to, ...closestBoundaryPoints(components[from][0], components[to][0]) });
      }
    }
    edges.sort((a, b) => a.distance - b.distance);
    const parents = components.map((_, index) => index);
    const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
    const bridges: GeometryPolygon[] = [];
    for (const edge of edges) {
      const fromRoot = find(edge.from);
      const toRoot = find(edge.to);
      if (fromRoot === toRoot) continue;
      parents[fromRoot] = toRoot;
      const width = Math.max(MIN_BRIDGE_WIDTH, Math.min(
        MAX_BRIDGE_WIDTH,
        0.25 * Math.min(ringThickness(components[edge.from][0]), ringThickness(components[edge.to][0])),
      ));
      bridges.push(createBridge(edge.pointA, edge.pointB, width));
      if (bridges.length === components.length - 1) break;
    }
    try {
      components = unionGeometries([...components, ...bridges]);
      components = components.map((component) => [component[0]]);
    } catch {
      components = [];
    }
  }

  if (components.length !== 1) {
    const fallbackHull = normalizeRing(convexHull(rings.flat()));
    if (!fallbackHull) return { error: 'Không thể gộp các polygon thành đúng một vùng.' };
    components = [[fallbackHull]];
  }
  const finalRing = normalizeRing(components[0][0]) || normalizeRing(convexHull(components[0][0]));
  if (!finalRing) return { error: 'Kết quả gộp polygon không hợp lệ.' };
  return {
    polygon: {
      id: createId(),
      label: polygons[0].label,
      nodes: finalRing.map(([x, y]) => ({ id: createId(), x, y })),
    },
  };
}

export function clonePolygons(polygons: AnnotationPolygon[]): AnnotationPolygon[] {
  return polygons.map((polygon) => ({
    ...polygon,
    ...(polygon.meta ? { meta: { ...polygon.meta } } : {}),
    nodes: polygon.nodes.map((node) => ({ ...node })),
  }));
}

/**
 * Creates a rectangular AnnotationPolygon from two opposite corners.
 * Vertices are ordered clockwise: top-left, top-right, bottom-right, bottom-left.
 */
export function createRectanglePolygon(
  start: Pick<PolygonNode, 'x' | 'y'>,
  end: Pick<PolygonNode, 'x' | 'y'>,
  label = 'wart_flesh',
): AnnotationPolygon {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);

  return {
    id: createId(),
    label,
    nodes: [
      { id: createId(), x: Math.round(minX * 10) / 10, y: Math.round(minY * 10) / 10 },
      { id: createId(), x: Math.round(maxX * 10) / 10, y: Math.round(minY * 10) / 10 },
      { id: createId(), x: Math.round(maxX * 10) / 10, y: Math.round(maxY * 10) / 10 },
      { id: createId(), x: Math.round(minX * 10) / 10, y: Math.round(maxY * 10) / 10 },
    ],
    meta: { source: 'human' },
  };
}

/**
 * Creates a circular/elliptical AnnotationPolygon with N samples around a center point.
 * Vertices are ordered clockwise.
 */
export function createCirclePolygon(
  center: Pick<PolygonNode, 'x' | 'y'>,
  rx: number,
  ry: number = rx,
  samples = 32,
  label = 'wart_flesh',
): AnnotationPolygon {
  const count = Math.max(8, samples);
  const nodes: PolygonNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index * 2 * Math.PI) / count;
    nodes.push({
      id: createId(),
      x: Math.round((center.x + rx * Math.cos(angle)) * 10) / 10,
      y: Math.round((center.y + ry * Math.sin(angle)) * 10) / 10,
    });
  }

  return {
    id: createId(),
    label,
    nodes,
    meta: { source: 'human' },
  };
}

/**
 * Inserts a new node into a polygon at a specific edge index, returning the updated polygon and new node.
 */
export function insertNodeAtEdge(
  polygon: AnnotationPolygon,
  edgeIndex: number,
  point: Pick<PolygonNode, 'x' | 'y'>,
): { polygon: AnnotationPolygon; node: PolygonNode } {
  const node: PolygonNode = {
    id: createId(),
    x: Math.round(point.x * 10) / 10,
    y: Math.round(point.y * 10) / 10,
    isAnchor: true,
  };
  const nodes = [
    ...polygon.nodes.slice(0, edgeIndex + 1),
    node,
    ...polygon.nodes.slice(edgeIndex + 1),
  ];
  return {
    polygon: {
      ...polygon,
      nodes,
      meta: { ...polygon.meta, source: 'human' },
    },
    node,
  };
}

/**
 * Calculates cubic Bézier control points for a gentle smooth curve segment from `curr` to `next`.
 * Applies smooth curvature across vertices with subtle intensity (tension = 0.08),
 * while strictly capping control point offsets (<= 22% of segment length) so curves
 * never overshoot, loop, or form protruding lumps ("cục lòi ra").
 */
export function getSmoothSegmentControlPoints(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
  next: { x: number; y: number },
  next2: { x: number; y: number },
  tension = 0.08,
): { cp1: { x: number; y: number }; cp2: { x: number; y: number } } {
  const dSegX = next.x - curr.x;
  const dSegY = next.y - curr.y;
  const dSeg = Math.hypot(dSegX, dSegY);

  if (dSeg < 1e-4) {
    return { cp1: { ...curr }, cp2: { ...next } };
  }

  const uSegX = dSegX / dSeg;
  const uSegY = dSegY / dSeg;

  // Incoming direction at curr: (curr - prev)
  const dInX = curr.x - prev.x;
  const dInY = curr.y - prev.y;
  const dIn = Math.hypot(dInX, dInY);
  const uInX = dIn > 1e-6 ? dInX / dIn : uSegX;
  const uInY = dIn > 1e-6 ? dInY / dIn : uSegY;

  // Outgoing direction at next: (next2 - next)
  const dOutX = next2.x - next.x;
  const dOutY = next2.y - next.y;
  const dOut = Math.hypot(dOutX, dOutY);
  const uOutX = dOut > 1e-6 ? dOutX / dOut : uSegX;
  const uOutY = dOut > 1e-6 ? dOutY / dOut : uSegY;

  // Tangent at curr: smooth normalized bisector
  const sumCurrX = uInX + uSegX;
  const sumCurrY = uInY + uSegY;
  const lenSumCurr = Math.hypot(sumCurrX, sumCurrY);
  let tCurrX = lenSumCurr > 1e-6 ? sumCurrX / lenSumCurr : uSegX;
  let tCurrY = lenSumCurr > 1e-6 ? sumCurrY / lenSumCurr : uSegY;

  // Tangent at next: smooth normalized bisector
  const sumNextX = uSegX + uOutX;
  const sumNextY = uSegY + uOutY;
  const lenSumNext = Math.hypot(sumNextX, sumNextY);
  let tNextX = lenSumNext > 1e-6 ? sumNextX / lenSumNext : uSegX;
  let tNextY = lenSumNext > 1e-6 ? sumNextY / lenSumNext : uSegY;

  // Severe hairpin reversal guard (> 135 deg reversal)
  const dotCurr = uInX * uSegX + uInY * uSegY;
  const dotNext = uSegX * uOutX + uSegY * uOutY;
  if (dotCurr < -0.7) {
    tCurrX = uSegX;
    tCurrY = uSegY;
  }
  if (dotNext < -0.7) {
    tNextX = uSegX;
    tNextY = uSegY;
  }

  // Gentle intensity offset: clamped to max 22% of segment length
  const maxOffset = dSeg * 0.22;
  const len1 = Math.min(maxOffset, Math.max(0, Math.min(dIn, dSeg) * tension * 1.5));
  const len2 = Math.min(maxOffset, Math.max(0, Math.min(dSeg, dOut) * tension * 1.5));

  return {
    cp1: {
      x: curr.x + tCurrX * len1,
      y: curr.y + tCurrY * len1,
    },
    cp2: {
      x: next.x - tNextX * len2,
      y: next.y - tNextY * len2,
    },
  };
}

/**
 * Checks if a line segment between `start` and `end` lies directly on the boundary of any polygon in `otherPolygons`.
 * Uses endpoints and midpoint proximity so interior chords or crossing edges are not falsely matched.
 */
export function isSegmentOnPolygonsBoundary(
  start: Pick<PolygonNode, 'x' | 'y'>,
  end: Pick<PolygonNode, 'x' | 'y'>,
  otherPolygons: AnnotationPolygon[],
  tolerance = 2.0,
): boolean {
  if (!otherPolygons || !otherPolygons.length) return false;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const segMinX = Math.min(start.x, end.x) - tolerance;
  const segMaxX = Math.max(start.x, end.x) + tolerance;
  const segMinY = Math.min(start.y, end.y) - tolerance;
  const segMaxY = Math.max(start.y, end.y) + tolerance;

  for (const poly of otherPolygons) {
    if (poly.nodes.length < 2) continue;

    let polyMinX = Infinity;
    let polyMaxX = -Infinity;
    let polyMinY = Infinity;
    let polyMaxY = -Infinity;
    for (const node of poly.nodes) {
      if (node.x < polyMinX) polyMinX = node.x;
      if (node.x > polyMaxX) polyMaxX = node.x;
      if (node.y < polyMinY) polyMinY = node.y;
      if (node.y > polyMaxY) polyMaxY = node.y;
    }
    if (
      segMaxX < polyMinX - tolerance ||
      segMinX > polyMaxX + tolerance ||
      segMaxY < polyMinY - tolerance ||
      segMinY > polyMaxY + tolerance
    ) {
      continue;
    }

    let startNear = false;
    let endNear = false;
    let midNear = false;

    for (let i = 0; i < poly.nodes.length; i += 1) {
      const a = poly.nodes[i];
      const b = poly.nodes[(i + 1) % poly.nodes.length];
      if (!startNear && closestPointOnSegment(start, a, b).distance <= tolerance) startNear = true;
      if (!endNear && closestPointOnSegment(end, a, b).distance <= tolerance) endNear = true;
      if (!midNear && closestPointOnSegment({ x: midX, y: midY }, a, b).distance <= tolerance) midNear = true;
      if (startNear && endNear && midNear) return true;
    }
  }
  return false;
}

/**
 * Draws a closed smooth path with gentle curvature through given points.
 * Segments that lie on an existing polygon's boundary are drawn with straight lines (`lineTo`)
 * without applying smoothing, guaranteeing 100% boundary adherence ("bám dính")
 * without protruding lumps ("cục lòi ra").
 */
export function drawSmoothClosedPath(
  context: {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
    closePath(): void;
  },
  nodes: Array<Pick<PolygonNode, 'x' | 'y'>>,
  tension = 0.08,
  otherPolygons?: AnnotationPolygon[],
): void {
  const n = nodes.length;
  if (n < 2) return;
  if (n === 2) {
    context.moveTo(nodes[0].x, nodes[0].y);
    context.lineTo(nodes[1].x, nodes[1].y);
    return;
  }

  // Precompute which segments are straight/shared boundary segments
  const isStraight: boolean[] = new Array(n).fill(false);
  if (otherPolygons && otherPolygons.length > 0) {
    for (let i = 0; i < n; i += 1) {
      const curr = nodes[i];
      const next = nodes[(i + 1) % n];
      if (isSegmentOnPolygonsBoundary(curr, next, otherPolygons)) {
        isStraight[i] = true;
      }
    }
  }

  context.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 0; i < n; i += 1) {
    const prev = nodes[(i - 1 + n) % n];
    const curr = nodes[i];
    const next = nodes[(i + 1) % n];
    const next2 = nodes[(i + 2) % n];

    if (isStraight[i]) {
      // Shared boundary segment: follow existing boundary directly without smoothing
      context.lineTo(next.x, next.y);
    } else {
      // Free smoothed segment
      const prevStraight = isStraight[(i - 1 + n) % n];
      const nextStraight = isStraight[(i + 1) % n];

      const dSegX = next.x - curr.x;
      const dSegY = next.y - curr.y;
      const dSeg = Math.hypot(dSegX, dSegY);
      if (dSeg < 1e-6) {
        context.lineTo(next.x, next.y);
        continue;
      }
      const uSegX = dSegX / dSeg;
      const uSegY = dSegY / dSeg;

      let cp1: { x: number; y: number };
      let cp2: { x: number; y: number };

      if (prevStraight || nextStraight) {
        const fullCP = getSmoothSegmentControlPoints(prev, curr, next, next2, tension);
        cp1 = prevStraight
          ? { x: curr.x + uSegX * Math.min(dSeg * 0.15, 6), y: curr.y + uSegY * Math.min(dSeg * 0.15, 6) }
          : fullCP.cp1;
        cp2 = nextStraight
          ? { x: next.x - uSegX * Math.min(dSeg * 0.15, 6), y: next.y - uSegY * Math.min(dSeg * 0.15, 6) }
          : fullCP.cp2;
      } else {
        const fullCP = getSmoothSegmentControlPoints(prev, curr, next, next2, tension);
        cp1 = fullCP.cp1;
        cp2 = fullCP.cp2;
      }

      context.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, next.x, next.y);
    }
  }
  context.closePath();
}

/**
 * Computes smooth displacements for polygon nodes when dragging an anchor point,
 * diffusing movement to immediate neighbors with an elastic falloff so corners stay smooth.
 * Falloff stops at other pinned anchor points (`isAnchor === true`).
 */
export function computeSmoothNodeDisplacements(
  nodes: PolygonNode[],
  activeNodeIds: Set<string>,
  deltaX: number,
  deltaY: number,
  width: number,
  height: number,
): PolygonNode[] {
  const n = nodes.length;
  if (activeNodeIds.size !== 1 || n < 5) {
    return nodes.map((node) => activeNodeIds.has(node.id)
      ? {
          ...node,
          x: Math.max(0, Math.min(width, Math.round((node.x + deltaX) * 10) / 10)),
          y: Math.max(0, Math.min(height, Math.round((node.y + deltaY) * 10) / 10)),
        }
      : node);
  }

  const draggedId = activeNodeIds.values().next().value;
  const targetIndex = nodes.findIndex((node) => node.id === draggedId);
  if (targetIndex === -1) return nodes;

  const weights = new Float64Array(n);
  weights[targetIndex] = 1.0;

  const maxFalloffDist = n >= 16 ? 3 : n >= 8 ? 2 : 1;
  const falloffLevels = [0.45, 0.18, 0.05];

  // Positive direction (clockwise)
  for (let dist = 1; dist <= maxFalloffDist; dist += 1) {
    const idx = (targetIndex + dist) % n;
    if (nodes[idx].isAnchor) break;
    weights[idx] = falloffLevels[dist - 1];
  }

  // Negative direction (counter-clockwise)
  for (let dist = 1; dist <= maxFalloffDist; dist += 1) {
    const idx = (targetIndex - dist + n) % n;
    if (nodes[idx].isAnchor) break;
    weights[idx] = falloffLevels[dist - 1];
  }

  return nodes.map((node, i) => {
    const w = weights[i];
    if (w === 0) return node;
    return {
      ...node,
      x: Math.max(0, Math.min(width, Math.round((node.x + deltaX * w) * 10) / 10)),
      y: Math.max(0, Math.min(height, Math.round((node.y + deltaY * w) * 10) / 10)),
    };
  });
}

export function polygonArea(nodes: Array<Pick<PolygonNode, 'x' | 'y'>>): number {
  let area = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index];
    const next = nodes[(index + 1) % nodes.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function pointInPolygon(point: Pick<PolygonNode, 'x' | 'y'>, nodes: PolygonNode[]): boolean {
  let inside = false;
  for (let index = 0, previous = nodes.length - 1; index < nodes.length; previous = index, index += 1) {
    const a = nodes[index];
    const b = nodes[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || EPSILON) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentIntersection(
  a: Pick<PolygonNode, 'x' | 'y'>,
  b: Pick<PolygonNode, 'x' | 'y'>,
  c: Pick<PolygonNode, 'x' | 'y'>,
  d: Pick<PolygonNode, 'x' | 'y'>,
): Omit<Intersection, 'edgeIndex' | 'cutSegmentIndex'> | null {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const cdX = d.x - c.x;
  const cdY = d.y - c.y;
  const denominator = abX * cdY - abY * cdX;
  if (Math.abs(denominator) < EPSILON) return null;
  const acX = c.x - a.x;
  const acY = c.y - a.y;
  const edgeT = (acX * cdY - acY * cdX) / denominator;
  const cutT = (acX * abY - acY * abX) / denominator;
  if (edgeT < -EPSILON || edgeT > 1 + EPSILON || cutT < -EPSILON || cutT > 1 + EPSILON) return null;
  return {
    edgeT,
    cutT,
    x: a.x + edgeT * abX,
    y: a.y + edgeT * abY,
  };
}

function findIntersections(polygon: AnnotationPolygon, cutPath: PolygonNode[]): Intersection[] {
  const intersections: Intersection[] = [];
  for (let edgeIndex = 0; edgeIndex < polygon.nodes.length; edgeIndex += 1) {
    const edgeStart = polygon.nodes[edgeIndex];
    const edgeEnd = polygon.nodes[(edgeIndex + 1) % polygon.nodes.length];
    for (let cutSegmentIndex = 0; cutSegmentIndex < cutPath.length - 1; cutSegmentIndex += 1) {
      const hit = segmentIntersection(edgeStart, edgeEnd, cutPath[cutSegmentIndex], cutPath[cutSegmentIndex + 1]);
      if (!hit) continue;
      const duplicate = intersections.some((item) => distance(item, hit) < EPSILON * 10);
      if (!duplicate) intersections.push({ ...hit, edgeIndex, cutSegmentIndex });
    }
  }
  return intersections.sort((a, b) => (a.cutSegmentIndex + a.cutT) - (b.cutSegmentIndex + b.cutT));
}

function walkBoundary(polygon: AnnotationPolygon, start: Intersection, end: Intersection): PolygonNode[] {
  const result: PolygonNode[] = [{ id: createId(), x: start.x, y: start.y }];
  let edgeIndex = start.edgeIndex;
  let guard = 0;
  while (edgeIndex !== end.edgeIndex && guard <= polygon.nodes.length) {
    const vertex = polygon.nodes[(edgeIndex + 1) % polygon.nodes.length];
    result.push({ ...vertex, id: createId() });
    edgeIndex = (edgeIndex + 1) % polygon.nodes.length;
    guard += 1;
  }
  result.push({ id: createId(), x: end.x, y: end.y });
  return result;
}

function cutInterior(cutPath: PolygonNode[], start: Intersection, end: Intersection): PolygonNode[] {
  const result: PolygonNode[] = [];
  for (let index = start.cutSegmentIndex + 1; index <= end.cutSegmentIndex; index += 1) {
    result.push({ ...cutPath[index], id: createId() });
  }
  return result;
}

function withoutNearDuplicates(nodes: PolygonNode[]): PolygonNode[] {
  return nodes.filter((node, index) => index === 0 || distance(node, nodes[index - 1]) > EPSILON * 10);
}

/**
 * Splits one simple polygon with an open polyline. A valid cut must cross the
 * polygon boundary exactly twice. Repeating the operation creates any number
 * of child polygons while keeping the stored model as a flat multipolygon.
 */
export function splitPolygonWithCut(polygon: AnnotationPolygon, cutPath: PolygonNode[]): SplitPolygonResult {
  if (polygon.nodes.length < 3 || cutPath.length < 2) return { error: 'Đường cắt cần ít nhất hai điểm.' };
  const intersections = findIntersections(polygon, cutPath);
  if (intersections.length !== 2) {
    return { error: `Đường cắt phải đi qua biên đa giác đúng 2 lần (hiện có ${intersections.length}).` };
  }
  const [first, second] = intersections;
  if (first.edgeIndex === second.edgeIndex) return { error: 'Hai giao điểm đang nằm trên cùng một cạnh.' };

  const forwardBoundary = walkBoundary(polygon, first, second);
  const backwardBoundary = walkBoundary(polygon, second, first);
  const interior = cutInterior(cutPath, first, second);
  const firstNodes = withoutNearDuplicates([...forwardBoundary, ...[...interior].reverse().map((node) => ({ ...node, id: createId() }))]);
  const secondNodes = withoutNearDuplicates([...backwardBoundary, ...interior.map((node) => ({ ...node, id: createId() }))]);

  if (firstNodes.length < 3 || secondNodes.length < 3 || Math.abs(polygonArea(firstNodes)) < 1 || Math.abs(polygonArea(secondNodes)) < 1) {
    return { error: 'Đường cắt tạo ra một vùng quá nhỏ hoặc không hợp lệ.' };
  }

  return {
    polygons: [
      { id: createId(), label: polygon.label, nodes: firstNodes, meta: { ...polygon.meta, source: 'human' } },
      { id: createId(), label: polygon.label, nodes: secondNodes, meta: { ...polygon.meta, source: 'human' } },
    ],
  };
}

export function closestPointOnSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): { point: { x: number; y: number }; distance: number; projection: number } {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared <= 1e-12) {
    return { point: { ...start }, distance: Math.hypot(point.x - start.x, point.y - start.y), projection: 0 };
  }
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared));
  const projectedPoint = {
    x: Math.round((start.x + projection * segmentX) * 10) / 10,
    y: Math.round((start.y + projection * segmentY) * 10) / 10,
  };
  return {
    point: projectedPoint,
    distance: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y),
    projection,
  };
}

export interface SnapTarget {
  polygonId: string;
  polygon: AnnotationPolygon;
  edgeIndex: number;
  point: { x: number; y: number };
  distance: number;
  isVertex: boolean;
  vertexId?: string;
  vertexIndex?: number;
}

export function findSnapTargetToPolygons(
  polygons: AnnotationPolygon[],
  point: { x: number; y: number },
  tolerance: number,
  excludePolygonId?: string,
): SnapTarget | null {
  let closestEdge: SnapTarget | null = null;
  let closestAnchor: SnapTarget | null = null;
  // Tight tolerance: only snap directly to a vertex if it is an existing anchor and cursor is directly on it
  const anchorTolerance = Math.min(tolerance * 0.35, 4.0);

  for (const polygon of polygons) {
    if (excludePolygonId && polygon.id === excludePolygonId) continue;
    if (polygon.nodes.length < 3) continue;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of polygon.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.y > maxY) maxY = node.y;
    }
    if (
      point.x < minX - tolerance ||
      point.x > maxX + tolerance ||
      point.y < minY - tolerance ||
      point.y > maxY + tolerance
    ) {
      continue;
    }

    // Check vertices: only snap directly as a vertex if cursor is right on it (within 3px) or directly on an explicit anchor
    for (let i = 0; i < polygon.nodes.length; i += 1) {
      const node = polygon.nodes[i];
      const d = Math.hypot(point.x - node.x, point.y - node.y);
      const isDirectHit = (node.isAnchor && d <= anchorTolerance) || d <= 3.0;
      if (isDirectHit && (!closestAnchor || d < closestAnchor.distance)) {
        closestAnchor = {
          polygonId: polygon.id,
          polygon,
          edgeIndex: i,
          point: { x: node.x, y: node.y },
          distance: d,
          isVertex: true,
          vertexId: node.id,
          vertexIndex: i,
        };
      }
    }

    // Check edges: allow clicking anywhere on boundary to create a new anchor
    for (let edgeIndex = 0; edgeIndex < polygon.nodes.length; edgeIndex += 1) {
      const start = polygon.nodes[edgeIndex];
      const end = polygon.nodes[(edgeIndex + 1) % polygon.nodes.length];
      const candidate = closestPointOnSegment(point, start, end);
      if (candidate.distance <= tolerance && (!closestEdge || candidate.distance < closestEdge.distance)) {
        closestEdge = {
          polygonId: polygon.id,
          polygon,
          edgeIndex,
          point: candidate.point,
          distance: candidate.distance,
          isVertex: false,
        };
      }
    }
  }

  // If user clicked directly on an existing anchor point, snap to it
  if (closestAnchor) {
    return closestAnchor;
  }

  // Otherwise, return edge target (so clicking anywhere on the edge creates a new anchor)
  return closestEdge;
}

export function getSharedBoundaryAutofillPath(
  targetPolygon: AnnotationPolygon,
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
): Array<{ id: string; x: number; y: number; isAnchor: boolean }> | null {
  const n = targetPolygon.nodes.length;
  if (n < 3) return null;

  let edgeStart = 0;
  let minStartDist = Infinity;
  let edgeEnd = 0;
  let minEndDist = Infinity;

  for (let i = 0; i < n; i += 1) {
    const a = targetPolygon.nodes[i];
    const b = targetPolygon.nodes[(i + 1) % n];
    const candStart = closestPointOnSegment(startPoint, a, b);
    if (candStart.distance < minStartDist) {
      minStartDist = candStart.distance;
      edgeStart = i;
    }
    const candEnd = closestPointOnSegment(endPoint, a, b);
    if (candEnd.distance < minEndDist) {
      minEndDist = candEnd.distance;
      edgeEnd = i;
    }
  }

  // Path 1 (Forward from endPoint towards startPoint):
  // endPoint -> V_{(edgeEnd + 1) % n} -> ... -> V_{edgeStart} -> startPoint
  const pathForward: Array<{ id: string; x: number; y: number; isAnchor: boolean }> = [];
  let curr = (edgeEnd + 1) % n;
  let guard = 0;
  while (curr !== (edgeStart + 1) % n && guard <= n) {
    const v = targetPolygon.nodes[curr];
    if (Math.hypot(v.x - endPoint.x, v.y - endPoint.y) > 2 && Math.hypot(v.x - startPoint.x, v.y - startPoint.y) > 2) {
      pathForward.push({ id: createId(), x: v.x, y: v.y, isAnchor: true });
    }
    curr = (curr + 1) % n;
    guard += 1;
  }

  // Path 2 (Backward from endPoint towards startPoint):
  // endPoint -> V_{edgeEnd} -> ... -> V_{(edgeStart + 1) % n} -> startPoint
  const pathBackward: Array<{ id: string; x: number; y: number; isAnchor: boolean }> = [];
  curr = edgeEnd;
  guard = 0;
  while (curr !== edgeStart && guard <= n) {
    const v = targetPolygon.nodes[curr];
    if (Math.hypot(v.x - endPoint.x, v.y - endPoint.y) > 2 && Math.hypot(v.x - startPoint.x, v.y - startPoint.y) > 2) {
      pathBackward.push({ id: createId(), x: v.x, y: v.y, isAnchor: true });
    }
    curr = (curr - 1 + n) % n;
    guard += 1;
  }

  const pathLen = (pts: Array<{ x: number; y: number }>) => {
    let sum = 0;
    let prev = endPoint;
    for (const p of pts) {
      sum += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    sum += Math.hypot(startPoint.x - prev.x, startPoint.y - prev.y);
    return sum;
  };

  const lenForward = pathLen(pathForward);
  const lenBackward = pathLen(pathBackward);

  const hasDraft = Boolean(draftNodes && draftNodes.length >= 2);
  const distForward = hasDraft ? pathDistanceToDraft(pathForward, startPoint, endPoint, draftNodes) : 0;
  const distBackward = hasDraft ? pathDistanceToDraft(pathBackward, startPoint, endPoint, draftNodes) : 0;

  // Primary rule: Choose the boundary closest to draftNodes ("biên gần nhất").
  // If one candidate boundary is closer to what the user is drawing, choose it.
  if (hasDraft && Math.abs(distForward - distBackward) > 1.0) {
    return distForward < distBackward ? pathForward : pathBackward;
  }

  const targetRing = normalizeRing(targetPolygon.nodes.map((p): GeometryPoint => [p.x, p.y]));
  const targetTotalArea = targetRing ? Math.abs(ringArea(targetRing)) : 0;

  const candidate1Ring = normalizeRing([...draftNodes, ...pathForward].map((p): GeometryPoint => [p.x, p.y]));
  const candidate2Ring = normalizeRing([...draftNodes, ...pathBackward].map((p): GeometryPoint => [p.x, p.y]));

  let areaIntersect1 = 0;
  let areaIntersect2 = 0;

  if (targetRing && candidate1Ring) {
    try {
      const inter1 = polygonClipping.intersection([candidate1Ring], [targetRing]);
      for (const p of inter1) for (const r of p) areaIntersect1 += Math.abs(ringArea(r));
    } catch {
      areaIntersect1 = 0;
    }
  }

  if (targetRing && candidate2Ring) {
    try {
      const inter2 = polygonClipping.intersection([candidate2Ring], [targetRing]);
      for (const p of inter2) for (const r of p) areaIntersect2 += Math.abs(ringArea(r));
    } catch {
      areaIntersect2 = 0;
    }
  }

  if (targetTotalArea > 10) {
    if (areaIntersect1 > targetTotalArea * 0.4 && areaIntersect2 <= targetTotalArea * 0.4) {
      return pathBackward;
    }
    if (areaIntersect2 > targetTotalArea * 0.4 && areaIntersect1 <= targetTotalArea * 0.4) {
      return pathForward;
    }
  }

  if (hasDraft) {
    return distForward <= distBackward ? pathForward : pathBackward;
  }

  return lenForward <= lenBackward ? pathForward : pathBackward;
}

/**
 * Calculates the average distance from sample points along a candidate boundary path to draftNodes.
 * Used to select the closest boundary ("biên gần nhất") to the user's drawing.
 */
export function pathDistanceToDraft(
  path: Array<{ x: number; y: number }>,
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
): number {
  if (!draftNodes || draftNodes.length < 2) return 0;

  const candidateNodes = [endPoint, ...path, startPoint];
  const samplePoints: Array<{ x: number; y: number }> = [];

  for (const p of path) {
    samplePoints.push(p);
  }

  for (let i = 0; i < candidateNodes.length - 1; i += 1) {
    const a = candidateNodes[i];
    const b = candidateNodes[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    samplePoints.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    if (segLen > 15) {
      samplePoints.push({ x: a.x + 0.25 * (b.x - a.x), y: a.y + 0.25 * (b.y - a.y) });
      samplePoints.push({ x: a.x + 0.75 * (b.x - a.x), y: a.y + 0.75 * (b.y - a.y) });
    }
  }

  if (samplePoints.length === 0) return 0;

  let totalDist = 0;
  for (const pt of samplePoints) {
    let minDistToDraft = Infinity;
    for (let j = 0; j < draftNodes.length - 1; j += 1) {
      const d1 = draftNodes[j];
      const d2 = draftNodes[j + 1];
      const d = closestPointOnSegment(pt, d1, d2).distance;
      if (d < minDistToDraft) {
        minDistToDraft = d;
      }
    }
    totalDist += minDistToDraft;
  }

  return totalDist / samplePoints.length;
}

export function polygonDistanceToDraft(
  polygon: AnnotationPolygon,
  draftNodes: Array<{ x: number; y: number }>,
): number {
  if (!draftNodes || draftNodes.length < 2 || !polygon.nodes.length) return 0;
  let minD = Infinity;
  for (const n of polygon.nodes) {
    for (let j = 0; j < draftNodes.length - 1; j += 1) {
      const d = closestPointOnSegment(n, draftNodes[j], draftNodes[j + 1]).distance;
      if (d < minD) {
        minD = d;
      }
    }
  }
  return minD;
}

export interface MultiPolygonAutofillResult {
  nodes: Array<{ id: string; x: number; y: number; isAnchor: boolean }>;
  targetPolygons: AnnotationPolygon[];
}

export function arePolygonsTouching(
  polyA: AnnotationPolygon,
  polyB: AnnotationPolygon,
  tolerance = 4,
): boolean {
  if (polyA.id === polyB.id) return true;
  if (!polyA.nodes.length || !polyB.nodes.length) return false;

  let minXA = Infinity;
  let maxXA = -Infinity;
  let minYA = Infinity;
  let maxYA = -Infinity;
  for (const n of polyA.nodes) {
    if (n.x < minXA) minXA = n.x;
    if (n.x > maxXA) maxXA = n.x;
    if (n.y < minYA) minYA = n.y;
    if (n.y > maxYA) maxYA = n.y;
  }
  let minXB = Infinity;
  let maxXB = -Infinity;
  let minYB = Infinity;
  let maxYB = -Infinity;
  for (const n of polyB.nodes) {
    if (n.x < minXB) minXB = n.x;
    if (n.x > maxXB) maxXB = n.x;
    if (n.y < minYB) minYB = n.y;
    if (n.y > maxYB) maxYB = n.y;
  }
  if (
    minXA > maxXB + tolerance ||
    maxXA < minXB - tolerance ||
    minYA > maxYB + tolerance ||
    maxYA < minYB - tolerance
  ) {
    return false;
  }

  // Check vertices of A against segments of B
  for (const na of polyA.nodes) {
    for (let i = 0; i < polyB.nodes.length; i += 1) {
      const b1 = polyB.nodes[i];
      const b2 = polyB.nodes[(i + 1) % polyB.nodes.length];
      if (closestPointOnSegment(na, b1, b2).distance <= tolerance) return true;
    }
  }

  // Check vertices of B against segments of A
  for (const nb of polyB.nodes) {
    for (let i = 0; i < polyA.nodes.length; i += 1) {
      const a1 = polyA.nodes[i];
      const a2 = polyA.nodes[(i + 1) % polyA.nodes.length];
      if (closestPointOnSegment(nb, a1, a2).distance <= tolerance) return true;
    }
  }

  return false;
}

export function arePolygonsConnected(
  allPolygons: AnnotationPolygon[],
  startId: string,
  endId: string,
  tolerance = 14,
): boolean {
  if (startId === endId) return true;
  const visited = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (currentId === endId) return true;
    const currentPoly = allPolygons.find((p) => p.id === currentId);
    if (!currentPoly) continue;

    for (const other of allPolygons) {
      if (visited.has(other.id)) continue;
      if (arePolygonsTouching(currentPoly, other, Math.max(tolerance * 0.5, 4))) {
        visited.add(other.id);
        queue.push(other.id);
      }
    }
  }

  return false;
}

export function getConnectedPolygonCluster(
  allPolygons: AnnotationPolygon[],
  seedPolygonIds: string[],
  tolerance = 14,
): AnnotationPolygon[] {
  const visited = new Set<string>(seedPolygonIds);
  const queue = [...seedPolygonIds];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentPoly = allPolygons.find((p) => p.id === currentId);
    if (!currentPoly) continue;

    for (const other of allPolygons) {
      if (visited.has(other.id)) continue;
      if (arePolygonsTouching(currentPoly, other, Math.max(tolerance * 0.5, 4))) {
        visited.add(other.id);
        queue.push(other.id);
      }
    }
  }

  return allPolygons.filter((p) => visited.has(p.id));
}

export function closestPointOnPolygon(
  polygon: AnnotationPolygon,
  point: { x: number; y: number },
): { point: { x: number; y: number }; edgeIndex: number; distance: number } {
  let minD = Infinity;
  let bestPoint = point;
  let bestEdge = 0;
  const n = polygon.nodes.length;
  for (let i = 0; i < n; i += 1) {
    const a = polygon.nodes[i];
    const b = polygon.nodes[(i + 1) % n];
    const cand = closestPointOnSegment(point, a, b);
    if (cand.distance < minD) {
      minD = cand.distance;
      bestPoint = cand.point;
      bestEdge = i;
    }
  }
  return { point: bestPoint, edgeIndex: bestEdge, distance: minD };
}

const collectiveCache = new Map<string, AnnotationPolygon>();

export function getCachedCollectivePolygon(polygons: AnnotationPolygon[]): AnnotationPolygon | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return polygons[0];

  const key = polygons.map((p) => `${p.id}_${p.nodes.length}`).sort().join('|');
  const cached = collectiveCache.get(key);
  if (cached) return cached;

  const res = mergePolygonsIntoSingle(polygons);
  if (res.polygon) {
    if (collectiveCache.size > 20) collectiveCache.clear();
    collectiveCache.set(key, res.polygon);
    return res.polygon;
  }
  return null;
}

/**
 * Finds shared boundary autofill path between startPoint and endPoint across one or multiple touching polygons.
 * Groups all existing touching polygons into a collective first so internal seams between adjacent
 * polygons are completely dissolved, and traces the outer boundary of the collective closest to draftNodes.
 */
export function findMultiPolygonAutofillPath(
  allPolygons: AnnotationPolygon[],
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
  tolerance = 14,
): MultiPolygonAutofillResult | null {
  if (!allPolygons || allPolygons.length === 0) return null;
  if (Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y) < 1.0) {
    return null;
  }
  const startSnap = findSnapTargetToPolygons(allPolygons, startPoint, tolerance);
  const endSnap = findSnapTargetToPolygons(allPolygons, endPoint, tolerance);
  if (!startSnap || !endSnap) return null;

  // If start and end are on different polygons, ensure they are connected by a touching chain
  if (startSnap.polygonId !== endSnap.polygonId) {
    if (!arePolygonsConnected(allPolygons, startSnap.polygonId, endSnap.polygonId, tolerance)) {
      return null;
    }
  }

  // 1. Group all existing touching polygons into a unified collective
  // (Dissolves all internal seams between warts, leaving only the true outer contour)
  const clusterPolygons = getConnectedPolygonCluster(
    allPolygons,
    startSnap.polygonId === endSnap.polygonId ? [startSnap.polygonId] : [startSnap.polygonId, endSnap.polygonId],
    tolerance,
  );

  let collectivePoly: AnnotationPolygon | null = null;
  if (clusterPolygons.length === 1) {
    collectivePoly = clusterPolygons[0];
  } else {
    collectivePoly = getCachedCollectivePolygon(clusterPolygons);
    if (!collectivePoly) {
      collectivePoly = getCachedCollectivePolygon(allPolygons) ?? clusterPolygons[0];
    }
  }

  if (!collectivePoly) return null;

  // 2. Project startSnap.point and endSnap.point onto the outer contour of the collective
  const collectiveStart = closestPointOnPolygon(collectivePoly, startSnap.point).point;
  const collectiveEnd = closestPointOnPolygon(collectivePoly, endSnap.point).point;

  // 3. Extract shared boundary path along the outer contour of the collective closest to draftNodes
  const autofillNodes = getSharedBoundaryAutofillPath(
    collectivePoly,
    collectiveStart,
    collectiveEnd,
    draftNodes,
  );
  if (!autofillNodes) return null;

  // 4. Enrich path with all original boundary nodes from clusterPolygons that lie along the segments
  const fullPathPoints: Array<{ id: string; x: number; y: number; isAnchor: boolean }> = [];
  const waypoints = [endSnap.point, ...autofillNodes, startSnap.point];

  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (segLen < 1e-4) continue;

    const intermediateNodes: Array<{ node: { x: number; y: number }; t: number }> = [];
    for (const poly of clusterPolygons) {
      for (const node of poly.nodes) {
        const cand = closestPointOnSegment(node, p1, p2);
        if (cand.distance <= 3.0 && cand.projection > 0.02 && cand.projection < 0.98) {
          const already = intermediateNodes.some((item) => Math.hypot(item.node.x - node.x, item.node.y - node.y) < 1.0);
          if (!already) {
            intermediateNodes.push({ node: { x: node.x, y: node.y }, t: cand.projection });
          }
        }
      }
    }
    intermediateNodes.sort((a, b) => a.t - b.t);

    for (const item of intermediateNodes) {
      fullPathPoints.push({ id: createId(), x: item.node.x, y: item.node.y, isAnchor: true });
    }
    if (i < waypoints.length - 2) {
      fullPathPoints.push({ id: createId(), x: p2.x, y: p2.y, isAnchor: true });
    }
  }

  // 5. Filter clusterPolygons to only those that actually contribute to the chosen boundary
  const pathPoints = [endSnap.point, ...fullPathPoints, startSnap.point];
  const contributingPolygons = clusterPolygons.filter((poly) => {
    return pathPoints.some((pt) => {
      for (let i = 0; i < poly.nodes.length; i += 1) {
        const a = poly.nodes[i];
        const b = poly.nodes[(i + 1) % poly.nodes.length];
        if (closestPointOnSegment(pt, a, b).distance <= 2.5) return true;
      }
      return false;
    });
  });

  return {
    nodes: fullPathPoints,
    targetPolygons: contributingPolygons.length > 0 ? contributingPolygons : clusterPolygons,
  };
}

export function ensurePolygonHasNodeAt(
  polygon: AnnotationPolygon,
  point: { x: number; y: number },
  tolerance = 4,
): { polygon: AnnotationPolygon; node: PolygonNode; inserted: boolean } {
  const existingIndex = polygon.nodes.findIndex((n) => Math.hypot(n.x - point.x, n.y - point.y) <= tolerance);
  if (existingIndex !== -1) {
    return { polygon, node: polygon.nodes[existingIndex], inserted: false };
  }
  let closestEdge = 0;
  let minDistance = Infinity;
  let closestPoint = point;
  for (let i = 0; i < polygon.nodes.length; i += 1) {
    const start = polygon.nodes[i];
    const end = polygon.nodes[(i + 1) % polygon.nodes.length];
    const cand = closestPointOnSegment(point, start, end);
    if (cand.distance < minDistance) {
      minDistance = cand.distance;
      closestEdge = i;
      closestPoint = cand.point;
    }
  }
  const result = insertNodeAtEdge(polygon, closestEdge, closestPoint);
  return { polygon: result.polygon, node: result.node, inserted: true };
}

export function clipPolygonDifference(
  subjectNodes: PolygonNode[],
  clipPolygonNodes: PolygonNode[],
): PolygonNode[] | null {
  if (subjectNodes.length < 3 || clipPolygonNodes.length < 3) return null;
  const subjectRing = normalizeRing(subjectNodes.map((n): GeometryPoint => [n.x, n.y]));
  const clipRing = normalizeRing(clipPolygonNodes.map((n): GeometryPoint => [n.x, n.y]));
  if (!subjectRing || !clipRing) return null;

  try {
    const intersection = polygonClipping.intersection([subjectRing], [clipRing]);
    if (!intersection || intersection.length === 0) return null;
    let intersectionArea = 0;
    for (const poly of intersection) {
      for (const ring of poly) {
        intersectionArea += Math.abs(ringArea(ring));
      }
    }
    if (intersectionArea < 15) return null;

    const diff = polygonClipping.difference([subjectRing], [clipRing]);
    if (!diff || diff.length === 0) return null;

    let largestPoly: GeometryPolygon | null = null;
    let maxArea = -1;
    for (const poly of diff) {
      if (poly.length > 0) {
        const area = Math.abs(ringArea(poly[0]));
        if (area > maxArea) {
          maxArea = area;
          largestPoly = poly;
        }
      }
    }
    if (!largestPoly || largestPoly.length === 0 || maxArea < 10) return null;

    const outerRing = largestPoly[0];
    const points = outerRing.slice(0, outerRing.length - 1);
    if (points.length < 3) return null;

    return points.map(([x, y]) => ({
      id: createId(),
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      isAnchor: true,
    }));
  } catch {
    return null;
  }
}
