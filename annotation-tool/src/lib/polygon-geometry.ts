import type { AnnotationPolygon, AnnotationPolygonMeta, PolygonNode } from '@/types';
import polygonClipping from 'polygon-clipping';

const EPSILON = 1e-6;
const GEOMETRY_EPSILON = 1e-6;
const MIN_BRIDGE_WIDTH = 2;
const MAX_BRIDGE_WIDTH = 8;
const MIN_REGION_AREA = 1e-6;
const BRUSH_UNION_CHUNK = 8;
const BRUSH_MIN_SPACING = 0.1;
const BRUSH_MAX_SAMPLES = 400;

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

type ClipInput = GeometryPolygon | GeometryMultiPolygon;

function differenceGeometries(subject: ClipInput, clip: ClipInput): GeometryMultiPolygon {
  const difference = polygonClipping.difference as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return difference(subject, clip);
}

function unionClipInputs(items: ClipInput[]): GeometryMultiPolygon {
  const union = polygonClipping.union as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return union(items[0], ...items.slice(1));
}

function intersectionGeometries(subject: ClipInput, clip: ClipInput): GeometryMultiPolygon {
  const intersection = polygonClipping.intersection as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return intersection(subject, clip);
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
  // Explicit Merge intentionally fills holes; brush operations preserve them.
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
    ...(polygon.holes ? { holes: polygon.holes.map((ring) => ring.map((node) => ({ ...node }))) } : {}),
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

/** Resolve a manual target, or require exactly one editable polygon that the path can split. */
export function resolvePolygonCut(
  polygons: AnnotationPolygon[],
  cutPath: PolygonNode[],
  manualTargetId: string | null = null,
): SplitPolygonResult & { targetId?: string } {
  if (manualTargetId) {
    const target = polygons.find((polygon) => polygon.id === manualTargetId);
    if (!target) return { error: 'Polygon đã chọn không còn tồn tại. Hãy chọn lại.' };
    if (target.meta?.locked) return { error: 'Polygon đang khóa. Mở khóa trước khi cắt.' };
    return { ...splitPolygonWithCut(target, cutPath), targetId: target.id };
  }
  let candidate: (SplitPolygonResult & { targetId: string }) | undefined;
  for (const polygon of polygons) {
    if (polygon.meta?.locked) continue;
    const result = splitPolygonWithCut(polygon, cutPath);
    if (!result.polygons) continue;
    if (candidate) return { error: 'Đường cắt đi qua nhiều polygon. Chuột phải chọn một polygon, rồi nhấn Enter để cắt.' };
    candidate = { ...result, targetId: polygon.id };
  }
  return candidate ?? { error: 'Chưa nhận diện được polygon để tách. Kéo qua hai biên hoặc chuột phải chọn polygon, rồi nhấn Enter.' };
}

// ─── Brush (bút vẽ / tẩy) ───────────────────────────────

export type BrushMode = 'add' | 'erase';

export interface BrushStrokeResult {
  /** Toàn bộ danh sách polygon sau khi áp nét vẽ. */
  polygons?: AnnotationPolygon[];
  /** Id các vùng vừa sinh ra, để canvas chọn lại sau khi commit. */
  resultIds?: string[];
  error?: string;
}

interface BrushAttempt {
  /** Lệch pha của đa giác đầu cọ, tính theo tỉ lệ một bước góc. */
  phase: number;
  /** Bước lưới làm tròn toạ độ; 0 nghĩa là giữ nguyên. */
  grid: number;
  segments: number;
}

/**
 * polygon-clipping@0.15 thỉnh thoảng vỡ sweep line khi hai biên gần trùng nhau
 * (đầu cọ tiếp tuyến đúng cạnh thân cọ ở nét dọc hoặc ngang). Mỗi lần thử làm
 * nhiễu hình học một kiểu khác ở mức dưới một pixel; đo trên 1218 nét vẽ ngẫu
 * nhiên thì thang này chỉ còn đúng một nét thất bại, và nét đó chỉ báo lỗi chứ
 * không làm hỏng dữ liệu.
 */
const BRUSH_ATTEMPTS: BrushAttempt[] = [
  { phase: 0, grid: 1 / 64, segments: 16 },
  { phase: 0.31, grid: 1 / 64, segments: 16 },
  { phase: 0.17, grid: 1 / 256, segments: 16 },
  { phase: 0.43, grid: 1 / 16, segments: 12 },
  { phase: 0.07, grid: 0, segments: 20 },
];

type GeometryBounds = { left: number; right: number; top: number; bottom: number };

function ringBounds(ring: GeometryRing): GeometryBounds {
  return ring.reduce<GeometryBounds>((result, [x, y]) => ({
    left: Math.min(result.left, x),
    right: Math.max(result.right, x),
    top: Math.min(result.top, y),
    bottom: Math.max(result.bottom, y),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}

function boundsOverlap(a: GeometryBounds, b: GeometryBounds): boolean {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

/** Validate every brush boundary without replacing the shape with a convex hull. */
const geometryCache = new WeakMap<AnnotationPolygon, GeometryPolygon | null>();
const geometryBoundsCache = new WeakMap<AnnotationPolygon, GeometryBounds>();
function cachedPolygonBounds(polygon: AnnotationPolygon): GeometryBounds {
  const cached = geometryBoundsCache.get(polygon);
  if (cached) return cached;
  const bounds = ringBounds(polygon.nodes.map((node) => [node.x, node.y]));
  geometryBoundsCache.set(polygon, bounds);
  return bounds;
}
function polygonGeometry(polygon: AnnotationPolygon): GeometryPolygon | null {
  if (geometryCache.has(polygon)) return geometryCache.get(polygon)!;
  const rings = polygonRings(polygon).map((nodes) => normalizeRing(nodes));
  const geometry = rings.some((ring) => !ring) ? null : rings as GeometryPolygon;
  geometryCache.set(polygon, geometry);
  return geometry;
}

export function polygonRings(polygon: AnnotationPolygon): PolygonNode[][] {
  return [polygon.nodes, ...(polygon.holes ?? [])];
}

export function pointInMask(point: Pick<PolygonNode, 'x' | 'y'>, polygon: AnnotationPolygon): boolean {
  return pointInPolygon(point, polygon.nodes)
    && !(polygon.holes ?? []).some((ring) => pointInPolygon(point, ring));
}

function ringToNodes(ring: GeometryRing): PolygonNode[] {
  return ring.map(([x, y]) => ({ id: createId(), x, y }));
}

/** Hợp theo từng cụm nhỏ rồi hợp tiếp các cụm: nhanh hơn nhiều lần một lời gọi phẳng. */
function chunkedUnion(pieces: GeometryMultiPolygon[]): GeometryMultiPolygon {
  let level = pieces;
  while (level.length > 1) {
    const next: GeometryMultiPolygon[] = [];
    for (let index = 0; index < level.length; index += BRUSH_UNION_CHUNK) {
      next.push(unionClipInputs(level.slice(index, index + BRUSH_UNION_CHUNK)));
    }
    level = next;
  }
  return level[0] ?? [];
}

/** Bỏ bớt mẫu con trỏ nhưng luôn giữ điểm cuối để nét không bị cụt. */
function decimateStroke(points: Array<{ x: number; y: number }>, spacing: number) {
  const kept = [points[0]];
  for (const point of points.slice(1)) {
    const last = kept[kept.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) >= spacing) kept.push(point);
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

/**
 * Biến các mẫu con trỏ thành vùng quét của đầu cọ tròn: mỗi mẫu là một đa giác
 * đều xấp xỉ hình tròn, mỗi cặp mẫu liên tiếp là một hình chữ nhật lệch theo
 * pháp tuyến. Hình chữ nhật chính là phần nội suy giữa hai mẫu, giữ nét liền
 * mạch khi rê chuột nhanh. Đầu cọ xoay lệch nửa bước so với hướng đi để đỉnh
 * của nó không nằm đúng trên cạnh thân cọ.
 */
function brushStrokeGeometry(
  strokePoints: Array<{ x: number; y: number }>,
  radius: number,
  attempt: BrushAttempt,
  bounds?: { width: number; height: number },
): GeometryMultiPolygon {
  const usableRadius = Math.max(0.5, radius);
  const samples = strokePoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!samples.length) return [];

  const spacing = Math.max(usableRadius * 0.4, BRUSH_MIN_SPACING);
  let kept = decimateStroke(samples, spacing);
  if (usableRadius > 1 && kept.length > BRUSH_MAX_SAMPLES) kept = decimateStroke(samples, (spacing * kept.length) / BRUSH_MAX_SAMPLES);

  const step = (Math.PI * 2) / attempt.segments;
  const capRadius = usableRadius / Math.cos(Math.PI / attempt.segments);
  const snap = (value: number) => attempt.grid ? Math.round(value / attempt.grid) * attempt.grid : value;
  const direction = (index: number) => {
    const previous = kept[Math.max(0, index - 1)];
    const next = kept[Math.min(kept.length - 1, index + 1)];
    return Math.atan2(next.y - previous.y, next.x - previous.x);
  };

  const pieces: GeometryMultiPolygon[] = kept.map((point, index) => {
    const base = direction(index) + step / 2 + attempt.phase * step;
    const ring: GeometryRing = [];
    for (let corner = 0; corner < attempt.segments; corner += 1) {
      const angle = base + corner * step;
      ring.push([snap(point.x + Math.cos(angle) * capRadius), snap(point.y + Math.sin(angle) * capRadius)]);
    }
    return [[ring]];
  });
  for (let index = 0; index < kept.length - 1; index += 1) {
    const start = kept[index];
    const end = kept[index + 1];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length <= GEOMETRY_EPSILON) continue;
    const normalX = (-(end.y - start.y) / length) * usableRadius;
    const normalY = ((end.x - start.x) / length) * usableRadius;
    pieces.push([[[
      [snap(start.x + normalX), snap(start.y + normalY)],
      [snap(end.x + normalX), snap(end.y + normalY)],
      [snap(end.x - normalX), snap(end.y - normalY)],
      [snap(start.x - normalX), snap(start.y - normalY)],
    ]]]);
  }

  const stroke = chunkedUnion(pieces);
  if (!bounds || !stroke.length) return stroke;
  return intersectionGeometries(stroke, [[
    [0, 0], [bounds.width, 0], [bounds.width, bounds.height], [0, bounds.height],
  ]]);
}

// Preserve both the outer boundary and every unpainted inner boundary.
function brushComponents(components: GeometryMultiPolygon) {
  return components.flatMap((component) => {
    const rings = component.map((ring) => normalizeRing(ring));
    if (rings.some((ring) => !ring)) throw new Error('Invalid clipping result');
    const [outer, ...holes] = rings as GeometryRing[];
    if (Math.abs(ringArea(outer)) < MIN_REGION_AREA) return [];
    return [{ nodes: ringToNodes(outer), ...(holes.length ? { holes: holes.map(ringToNodes) } : {}) }];
  });
}

function resolveBrushStroke(
  polygons: AnnotationPolygon[],
  geometries: Array<GeometryPolygon | null>,
  stroke: GeometryMultiPolygon,
  mode: BrushMode,
  newRegion: { label: string; meta?: AnnotationPolygonMeta },
): BrushStrokeResult {
  const directlyTouched = geometries.map((geometry) => !!geometry
    && intersectionGeometries(geometry, stroke).length > 0);
  if (mode === 'erase') {
    const resultIds: string[] = [];
    const next = polygons.flatMap((polygon, index) => {
      if (!directlyTouched[index]) return [polygon];
      return brushComponents(differenceGeometries(geometries[index]!, stroke)).map((shape) => {
        const created = { ...shape, id: createId(), label: polygon.label, meta: { ...polygon.meta, source: 'human' as const } };
        resultIds.push(created.id);
        return created;
      });
    });
    if (!directlyTouched.some(Boolean)) return { error: 'Nét tẩy chưa chạm vùng mask nào.' };
    return { polygons: next, resultIds };
  }

  // A stroke can touch only the top polygon while another mask overlaps below
  // it. Include the whole overlap-connected component in the local union.
  const affected = new Set(directlyTouched.flatMap((value, index) => value ? [index] : []));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let index = 0; index < geometries.length; index += 1) {
      if (affected.has(index) || polygons[index].meta?.locked) continue;
      if (![...affected].some((affectedIndex) => boundsOverlap(cachedPolygonBounds(polygons[index]), cachedPolygonBounds(polygons[affectedIndex])))) continue;
      const geometry = geometries[index] ?? polygonGeometry(polygons[index]);
      if (!geometry) continue;
      geometries[index] = geometry;
      for (const affectedIndex of affected) {
        if (intersectionGeometries(geometry, geometries[affectedIndex]!).length > 0) {
          affected.add(index);
          expanded = true;
          break;
        }
      }
    }
  }
  const affectedIndexes = [...affected];
  const template = affectedIndexes.length
    ? affectedIndexes.map((index) => polygons[index]).reduce((largest, candidate) =>
      Math.abs(polygonArea(candidate.nodes)) > Math.abs(polygonArea(largest.nodes)) ? candidate : largest)
    : newRegion;
  // Exact local union, including all inner rings. No hull, bridge or hole filling.
  const geometry = chunkedUnion([stroke, ...affectedIndexes.map((index) => [geometries[index]!])]);
  const created = brushComponents(geometry).map((shape): AnnotationPolygon => ({
    ...shape, id: createId(), label: template.label, meta: { ...template.meta, source: 'human' },
  }));
  if (!created.length) return { error: 'Nét vẽ quá nhỏ để tạo vùng mới.' };
  const next = affectedIndexes.length ? polygons.flatMap((polygon, index) =>
    index === affectedIndexes[0] ? created : affected.has(index) ? [] : [polygon])
    : [...polygons, ...created];
  return { polygons: next, resultIds: created.map((polygon) => polygon.id) };
}

/**
 * Áp một nét bút hoặc nét tẩy lên danh sách polygon.
 *
 * - `erase`: mỗi mảnh còn khép kín sau khi trừ nét tẩy trở thành một vùng riêng
 *   biệt, giữ nguyên label như splitPolygonWithCut (trùng label là bình thường).
 * - `add`: hợp nét vẽ với mọi vùng nó chạm tới, nên tô nối hai vùng rời sẽ ra
 *   một vùng mang label/meta của vùng lớn nhất. Không chạm vùng nào thì tạo
 *   vùng mới từ `newRegion`.
 *
 * Polygon đang khóa luôn được giữ nguyên, giống resolvePolygonCut.
 */
export function applyBrushStroke(
  polygons: AnnotationPolygon[],
  strokePoints: Array<{ x: number; y: number }>,
  radius: number,
  mode: BrushMode,
  newRegion: { label: string; meta?: AnnotationPolygonMeta },
  bounds?: { width: number; height: number },
): BrushStrokeResult {
  if (!strokePoints.length) return { error: 'Nét vẽ chưa có điểm nào.' };
  // Reject distant polygons before quadratic ring validation.
  const validPoints = strokePoints.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!validPoints.length) return { error: 'Invalid brush coordinates.' };
  const strokeBounds = ringBounds(validPoints.map((point) => [point.x, point.y]));
  const padding = Math.max(0.5, radius) + 0.1;
  strokeBounds.left -= padding;
  strokeBounds.right += padding;
  strokeBounds.top -= padding;
  strokeBounds.bottom += padding;
  let invalidCandidate = false;
  const rings = polygons.map((polygon) => {
    if (polygon.meta?.locked) return null;
    const bounds = cachedPolygonBounds(polygon);
    if (!boundsOverlap(bounds, strokeBounds)) return null;
    const geometry = polygonGeometry(polygon);
    if (!geometry) invalidCandidate = true;
    return geometry;
  });

  if (invalidCandidate) return { error: 'Biên mask không hợp lệ. Hãy chỉnh lại biên trước khi vẽ.' };

  for (const attempt of BRUSH_ATTEMPTS) {
    let stroke: GeometryMultiPolygon;
    try {
      stroke = brushStrokeGeometry(strokePoints, radius, attempt, bounds);
    } catch {
      continue;
    }
    if (!stroke.length) return { error: 'Nét vẽ nằm ngoài ảnh hoặc quá nhỏ để áp dụng.' };
    try {
      return resolveBrushStroke(polygons, rings, stroke, mode, newRegion);
    } catch {
      continue;
    }
  }
  return { error: 'Không xử lý được nét vẽ này. Hãy vẽ lại một nét ngắn hơn.' };
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

// ── Tự nối biên (auto anchor, giữ Shift khi vẽ polygon) ─────────────────────────────────────────────
// Người dùng xác nhận 2026-11-05: đường tự nối chỉ đi theo biên "tự do" của các mask — cạnh chưa có mask
// khác nối vào và chưa bị chính bản nháp nối — và KHÔNG gộp các mask lân cận. Cách cũ gộp chuỗi mask chạm
// nhau thành một khối (lấp cả vùng trống bị bao quanh) rồi đi vòng ngoài khối đó, nên polygon mới nuốt
// luôn các mask riêng biệt.

/** px ảnh: cạnh cách biên của mask khác không quá giá trị này là đường nối đã có, không đi lại. */
const AUTOFILL_SEAM_TOLERANCE = 2.5;
/** px ảnh: đỉnh của hai mask khác nhau gần hơn giá trị này là một nút (chỗ nối lệch do vector hóa). */
const AUTOFILL_MERGE_TOLERANCE = 2.5;
/** px ảnh: đường tự nối không được đi sát bản nháp hơn giá trị này (trừ tại điểm đầu/cuối). */
const AUTOFILL_TOUCH_TOLERANCE = 0.5;
/** px ảnh: điểm đầu/cuối phải nằm cách biên tự do không quá giá trị này. */
const AUTOFILL_ATTACH_MAX = 6;
/** px ảnh: điểm gắn gần đầu cạnh hơn giá trị này thì dùng luôn đỉnh có sẵn. */
const AUTOFILL_ENDPOINT_SNAP = 0.5;
const AUTOFILL_GRID_CELL = 8;
const AUTOFILL_POLYGON_CELL = 96;

type FlatPoint = { x: number; y: number };

/** Một bước đi trên biên tự do, tọa độ là đỉnh thật của mask (để biên mới trùng khít biên cũ). */
interface BoundaryStep {
  to: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  length: number;
  polygon: number;
}

interface BoundarySegment {
  from: number;
  to: number;
  /** Mask nằm bên trái khi đi a → b. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  polygon: number;
}

interface BoundaryGraph {
  nodeCount: number;
  segments: BoundarySegment[];
  /** Đi theo chiều để mask nằm bên trái: polygon mới (bên phải) có diện tích có dấu âm. */
  maskLeft: BoundaryStep[][];
  /** Đi theo chiều để mask nằm bên phải: polygon mới (bên trái) có diện tích có dấu dương. */
  maskRight: BoundaryStep[][];
  /** Lưới các cạnh vòng biên (nới AUTOFILL_SEAM_TOLERANCE) và đoạn tự do sinh từ mỗi cạnh: [edgeSegmentStart[e], edgeSegmentStart[e + 1]). */
  edgeGrid: DenseGrid;
  edgeSegmentStart: Int32Array;
  /** Đoạn tự do của polygon p: [polygonSegmentStart[p], polygonSegmentStart[p + 1]) (vòng biên được duyệt theo thứ tự polygon). */
  polygonSegmentStart: Int32Array;
}

// Khóa số nhỏ (small integer) cho lưới động dùng khi gộp đỉnh. Ô ngoài ±16384 có thể trùng khóa: chỉ thêm
// ứng viên, mọi ứng viên đều được kiểm lại bằng khoảng cách nên kết quả không đổi.
const gridKey = (cellX: number, cellY: number) => ((cellX & 0x7fff) << 15) | (cellY & 0x7fff);
const NO_ENTRIES: readonly number[] = [];

/**
 * Lưới đều phủ hộp bao, lưu dạng CSR (mảng phẳng) để dựng và tra cứu không cấp phát theo từng ô — với
 * hàng chục nghìn cạnh, Map theo ô chiếm phần lớn thời gian dựng đồ thị.
 */
interface DenseGrid {
  left: number;
  top: number;
  cell: number;
  columns: number;
  rows: number;
  starts: Int32Array;
  items: Int32Array;
  /** Dấu ô đã thăm: ≥ 0 khi dựng (giá trị vừa thêm), < 0 khi tra cứu (mã lượt tra). */
  marks: Int32Array;
  query: number;
}

function denseGrid(
  left: number,
  top: number,
  right: number,
  bottom: number,
  minimumCell: number,
  fill: (grid: DenseGrid, add: (grid: DenseGrid, cellIndex: number, value: number) => void) => void,
): DenseGrid {
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const cell = Math.max(minimumCell, Math.sqrt((width * height) / 2_000_000));
  const columns = Math.floor(width / cell) + 1;
  const rows = Math.floor(height / cell) + 1;
  const cells = columns * rows;
  const grid: DenseGrid = {
    left, top, cell, columns, rows,
    starts: new Int32Array(cells + 1),
    items: new Int32Array(0),
    marks: new Int32Array(cells).fill(-1),
    query: -1,
  };
  fill(grid, (target, cellIndex, value) => {
    if (target.marks[cellIndex] === value) return;
    target.marks[cellIndex] = value;
    target.starts[cellIndex + 1] += 1;
  });
  for (let index = 0; index < cells; index += 1) grid.starts[index + 1] += grid.starts[index];
  grid.items = new Int32Array(grid.starts[cells]);
  const cursor = grid.starts.slice(0, cells);
  grid.marks.fill(-1);
  fill(grid, (target, cellIndex, value) => {
    if (target.marks[cellIndex] === value) return;
    target.marks[cellIndex] = value;
    target.items[cursor[cellIndex]] = value;
    cursor[cellIndex] += 1;
  });
  grid.marks.fill(-1);
  return grid;
}

function denseCellAt(grid: DenseGrid, x: number, y: number): number {
  const cellX = Math.floor((x - grid.left) / grid.cell);
  const cellY = Math.floor((y - grid.top) / grid.cell);
  if (cellX < 0 || cellY < 0 || cellX >= grid.columns || cellY >= grid.rows) return -1;
  return cellY * grid.columns + cellX;
}

/** Gọi visit cho các ô mà đoạn a–b (nới thêm pad) đi qua; đoạn dài chia khúc để không phủ cả hình chữ nhật bao. */
function forSegmentCells(
  grid: DenseGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pad: number,
  value: number,
  visit: (grid: DenseGrid, cellIndex: number, value: number) => void,
) {
  const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / grid.cell));
  for (let piece = 0; piece < pieces; piece += 1) {
    const x0 = ax + ((bx - ax) * piece) / pieces;
    const y0 = ay + ((by - ay) * piece) / pieces;
    const x1 = ax + ((bx - ax) * (piece + 1)) / pieces;
    const y1 = ay + ((by - ay) * (piece + 1)) / pieces;
    const fromX = Math.max(0, Math.floor((Math.min(x0, x1) - pad - grid.left) / grid.cell));
    const toX = Math.min(grid.columns - 1, Math.floor((Math.max(x0, x1) + pad - grid.left) / grid.cell));
    const fromY = Math.max(0, Math.floor((Math.min(y0, y1) - pad - grid.top) / grid.cell));
    const toY = Math.min(grid.rows - 1, Math.floor((Math.max(y0, y1) + pad - grid.top) / grid.cell));
    for (let cellY = fromY; cellY <= toY; cellY += 1) {
      for (let cellX = fromX; cellX <= toX; cellX += 1) visit(grid, cellY * grid.columns + cellX, value);
    }
  }
}

const scratchCells: number[] = [];
/** Các ô (không trùng) mà đoạn a–b nới thêm pad đi qua, ghi vào scratchCells. */
function segmentCellList(grid: DenseGrid, ax: number, ay: number, bx: number, by: number, pad: number): number[] {
  scratchCells.length = 0;
  grid.query -= 1;
  forSegmentCells(grid, ax, ay, bx, by, pad, grid.query, (target, cellIndex, stamp) => {
    if (target.marks[cellIndex] === stamp) return;
    target.marks[cellIndex] = stamp;
    scratchCells.push(cellIndex);
  });
  return scratchCells;
}

function pointSegmentDistance(point: FlatPoint, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSquared));
  return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy));
}

/** Khoảng cách lớn nhất từ một đường gấp khúc (lấy mẫu mỗi ≤ 8 px) tới đường gấp khúc khác. */
function maxDistanceToPolyline(path: FlatPoint[], polyline: FlatPoint[]): number {
  const distanceTo = (point: FlatPoint) => {
    let best = Infinity;
    for (let index = 0; index + 1 < polyline.length; index += 1) {
      const a = polyline[index];
      const b = polyline[index + 1];
      best = Math.min(best, pointSegmentDistance(point, a.x, a.y, b.x, b.y));
    }
    return best;
  };
  let worst = 0;
  for (let index = 0; index < path.length; index += 1) {
    const a = path[index];
    worst = Math.max(worst, distanceTo(a));
    const b = path[index + 1];
    if (!b) break;
    const samples = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8);
    for (let sample = 1; sample < samples; sample += 1) {
      worst = Math.max(worst, distanceTo({ x: a.x + ((b.x - a.x) * sample) / samples, y: a.y + ((b.y - a.y) * sample) / samples }));
    }
  }
  return worst;
}

function segmentDistance(a: FlatPoint, b: FlatPoint, c: FlatPoint, d: FlatPoint): number {
  if (segmentsIntersect([a.x, a.y], [b.x, b.y], [c.x, c.y], [d.x, d.y])) return 0;
  return Math.min(
    pointSegmentDistance(a, c.x, c.y, d.x, d.y),
    pointSegmentDistance(b, c.x, c.y, d.x, d.y),
    pointSegmentDistance(c, a.x, a.y, b.x, b.y),
    pointSegmentDistance(d, a.x, a.y, b.x, b.y),
  );
}

/**
 * Đồ thị các cạnh biên tự do của mọi mask. Cạnh nằm trên đường nối giữa hai mask (hoặc nằm trong mask
 * khác) bị loại; cạnh được tách tại đỉnh của mask khác nằm trên nó (chỗ nối chữ T) và đỉnh của các mask
 * khác nhau trùng/gần nhau được gộp thành một nút, để đường đi chuyển được từ mask này sang mask kế bên.
 */
function buildBoundaryGraph(polygons: AnnotationPolygon[]): BoundaryGraph {
  const rings: Array<{ polygon: number; points: FlatPoint[] }> = [];
  polygons.forEach((polygon, index) => {
    polygonRings(polygon).forEach((ring, ringIndex) => {
      const points: FlatPoint[] = [];
      for (const node of ring) {
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        const last = points[points.length - 1];
        if (!last || Math.hypot(last.x - node.x, last.y - node.y) > 1e-9) points.push({ x: node.x, y: node.y });
      }
      while (points.length > 1 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <= 1e-9) points.pop();
      if (points.length < 3) return;
      const area = polygonArea(points);
      if (Math.abs(area) < 1e-6) return;
      // Vòng ngoài diện tích dương, lỗ diện tích âm: phần mask luôn nằm bên trái mỗi cạnh.
      if ((area > 0) !== (ringIndex === 0)) points.reverse();
      rings.push({ polygon: index, points });
    });
  });

  // Gộp đỉnh của các mask khác nhau; mỗi nút giữ tối đa một đỉnh của mỗi mask nên không gộp dây chuyền dọc đường nối.
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const nodeMembers: number[][] = [];
  const nodeGrid = new Map<number, number[]>();
  const mergeCell = AUTOFILL_MERGE_TOLERANCE * 2;
  const ringNodes = rings.map((ring) => ring.points.map((point) => {
    const cellX = Math.floor(point.x / mergeCell);
    const cellY = Math.floor(point.y / mergeCell);
    // Ô rộng gấp đôi bán kính gộp: chỉ khối 2×2 ô phía điểm đang nằm có thể chứa nút trong bán kính.
    const nearX = point.x - cellX * mergeCell < mergeCell / 2 ? -1 : 1;
    const nearY = point.y - cellY * mergeCell < mergeCell / 2 ? -1 : 1;
    let best = -1;
    let bestDistance = AUTOFILL_MERGE_TOLERANCE;
    for (let corner = 0; corner < 4; corner += 1) {
      const key = gridKey(cellX + (corner & 1 ? nearX : 0), cellY + (corner & 2 ? nearY : 0));
      for (const id of nodeGrid.get(key) ?? NO_ENTRIES) {
        if (nodeMembers[id].includes(ring.polygon)) continue;
        const distanceToNode = Math.hypot(nodeX[id] - point.x, nodeY[id] - point.y);
        if (distanceToNode <= bestDistance) {
          best = id;
          bestDistance = distanceToNode;
        }
      }
    }
    if (best >= 0) {
      nodeMembers[best].push(ring.polygon);
      return best;
    }
    const id = nodeX.length;
    nodeX.push(point.x);
    nodeY.push(point.y);
    nodeMembers.push([ring.polygon]);
    const key = gridKey(cellX, cellY);
    const list = nodeGrid.get(key);
    if (list) list.push(id); else nodeGrid.set(key, [id]);
    return id;
  }));

  const tolerance = AUTOFILL_SEAM_TOLERANCE;
  const vertices: Array<{ x: number; y: number; polygon: number; node: number }> = [];
  const edges: Array<{ ax: number; ay: number; bx: number; by: number; polygon: number }> = [];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  rings.forEach((ring, ringIndex) => {
    ring.points.forEach((a, index) => {
      vertices.push({ x: a.x, y: a.y, polygon: ring.polygon, node: ringNodes[ringIndex][index] });
      const b = ring.points[(index + 1) % ring.points.length];
      edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, polygon: ring.polygon });
      left = Math.min(left, a.x);
      top = Math.min(top, a.y);
      right = Math.max(right, a.x);
      bottom = Math.max(bottom, a.y);
    });
  });
  if (!vertices.length) {
    left = 0;
    top = 0;
    right = 1;
    bottom = 1;
  }
  const margin = AUTOFILL_ATTACH_MAX + 1;
  left -= margin;
  top -= margin;
  right += margin;
  bottom += margin;
  const vertexGrid = denseGrid(left, top, right, bottom, AUTOFILL_GRID_CELL, (grid, add) => {
    vertices.forEach((vertex, index) => {
      const cellIndex = denseCellAt(grid, vertex.x, vertex.y);
      if (cellIndex >= 0) add(grid, cellIndex, index);
    });
  });
  const edgeGrid = denseGrid(left, top, right, bottom, AUTOFILL_GRID_CELL, (grid, add) => {
    edges.forEach((edge, index) => forSegmentCells(grid, edge.ax, edge.ay, edge.bx, edge.by, tolerance, index, add));
  });
  const bounds = polygons.map((polygon) => cachedPolygonBounds(polygon));
  const polygonGrid = denseGrid(left, top, right, bottom, AUTOFILL_POLYGON_CELL, (grid, add) => {
    bounds.forEach((box, index) => {
      if (![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) return;
      const fromX = Math.max(0, Math.floor((box.left - grid.left) / grid.cell));
      const toX = Math.min(grid.columns - 1, Math.floor((box.right - grid.left) / grid.cell));
      const fromY = Math.max(0, Math.floor((box.top - grid.top) / grid.cell));
      const toY = Math.min(grid.rows - 1, Math.floor((box.bottom - grid.top) / grid.cell));
      for (let cellY = fromY; cellY <= toY; cellY += 1) {
        for (let cellX = fromX; cellX <= toX; cellX += 1) add(grid, cellY * grid.columns + cellX, index);
      }
    });
  });
  // Điểm có cạnh của mask khác chạy song song sát bên (đường nối) hoặc nằm trong mask khác (chồng lấn):
  // không phải biên tự do. Chỉ tính cạnh gần song song và có chân đường vuông góc nằm trên cạnh đó, để
  // cạnh của mask kế bên đi tiếp thẳng hàng hoặc rẽ vuông góc tại chỗ nối không làm đứt biên tự do.
  const occupied = (x: number, y: number, own: number, directionX: number, directionY: number) => {
    const edgeCell = denseCellAt(edgeGrid, x, y);
    if (edgeCell < 0) return false;
    for (let slot = edgeGrid.starts[edgeCell]; slot < edgeGrid.starts[edgeCell + 1]; slot += 1) {
      const edge = edges[edgeGrid.items[slot]];
      if (edge.polygon === own) continue;
      const ex = edge.bx - edge.ax;
      const ey = edge.by - edge.ay;
      const edgeLength = Math.hypot(ex, ey);
      if (edgeLength <= 1e-9 || Math.abs(ex * directionX + ey * directionY) < 0.7 * edgeLength) continue;
      const t = ((x - edge.ax) * ex + (y - edge.ay) * ey) / (edgeLength * edgeLength);
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      if (Math.abs((x - edge.ax) * ey - (y - edge.ay) * ex) / edgeLength <= tolerance) return true;
    }
    const polygonCell = denseCellAt(polygonGrid, x, y);
    for (let slot = polygonGrid.starts[polygonCell]; slot < polygonGrid.starts[polygonCell + 1]; slot += 1) {
      const index = polygonGrid.items[slot];
      const box = bounds[index];
      if (index === own || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      if (pointInMask({ x, y }, polygons[index])) return true;
    }
    return false;
  };

  const segments: BoundarySegment[] = [];
  const maskLeft: BoundaryStep[][] = nodeX.map(() => []);
  const maskRight: BoundaryStep[][] = nodeX.map(() => []);
  const splits: Array<{ t: number; x: number; y: number; node: number }> = [];
  // Cạnh được duyệt đúng thứ tự mảng edges, nên các đoạn tự do của một cạnh nằm liền nhau trong segments.
  const edgeSegmentStart = new Int32Array(edges.length + 1);
  let edgeIndex = 0;
  rings.forEach((ring, ringIndex) => {
    const count = ring.points.length;
    for (let index = 0; index < count; index += 1) {
      edgeSegmentStart[edgeIndex] = segments.length;
      edgeIndex += 1;
      const a = ring.points[index];
      const b = ring.points[(index + 1) % count];
      const aNode = ringNodes[ringIndex][index];
      const bNode = ringNodes[ringIndex][(index + 1) % count];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 1e-12) continue;
      // Tách cạnh tại đỉnh của mask khác nằm trên cạnh (chỗ nối chữ T) để chuyển mask được tại đó.
      splits.length = 0;
      for (const cellIndex of segmentCellList(vertexGrid, a.x, a.y, b.x, b.y, tolerance)) {
        for (let slot = vertexGrid.starts[cellIndex]; slot < vertexGrid.starts[cellIndex + 1]; slot += 1) {
          const vertex = vertices[vertexGrid.items[slot]];
          if (vertex.polygon === ring.polygon || vertex.node === aNode || vertex.node === bNode) continue;
          const t = ((vertex.x - a.x) * dx + (vertex.y - a.y) * dy) / lengthSquared;
          if (t <= 0 || t >= 1) continue;
          if (Math.hypot(vertex.x - (a.x + t * dx), vertex.y - (a.y + t * dy)) > tolerance) continue;
          if (Math.hypot(vertex.x - a.x, vertex.y - a.y) <= AUTOFILL_MERGE_TOLERANCE
            || Math.hypot(vertex.x - b.x, vertex.y - b.y) <= AUTOFILL_MERGE_TOLERANCE) continue;
          if (splits.some((split) => split.node === vertex.node)) continue;
          splits.push({ t, x: vertex.x, y: vertex.y, node: vertex.node });
        }
      }
      splits.sort((first, second) => first.t - second.t);
      let px = a.x;
      let py = a.y;
      let pNode = aNode;
      for (let step = 0; step <= splits.length; step += 1) {
        const qx = step < splits.length ? splits[step].x : b.x;
        const qy = step < splits.length ? splits[step].y : b.y;
        const qNode = step < splits.length ? splits[step].node : bNode;
        if (pNode !== qNode) {
          const length = Math.hypot(qx - px, qy - py);
          const ux = (qx - px) / length;
          const uy = (qy - py) / length;
          // Cạnh dài lấy 3 mẫu và cần đa số bị chiếm mới loại (đường nối có thể chỉ phủ một phần cạnh).
          const taken = length > 6 * tolerance
            ? Number(occupied(px + (qx - px) * 0.25, py + (qy - py) * 0.25, ring.polygon, ux, uy))
              + Number(occupied((px + qx) / 2, (py + qy) / 2, ring.polygon, ux, uy))
              + Number(occupied(px + (qx - px) * 0.75, py + (qy - py) * 0.75, ring.polygon, ux, uy)) >= 2
            : occupied((px + qx) / 2, (py + qy) / 2, ring.polygon, ux, uy);
          if (!taken) {
            segments.push({ from: pNode, to: qNode, ax: px, ay: py, bx: qx, by: qy, polygon: ring.polygon });
            maskLeft[pNode].push({ to: qNode, fx: px, fy: py, tx: qx, ty: qy, length, polygon: ring.polygon });
            maskRight[qNode].push({ to: pNode, fx: qx, fy: qy, tx: px, ty: py, length, polygon: ring.polygon });
          }
        }
        px = qx;
        py = qy;
        pNode = qNode;
      }
    }
  });
  edgeSegmentStart[edges.length] = segments.length;
  const polygonSegmentStart = new Int32Array(polygons.length + 1);
  for (let polygon = 0, cursor = 0; polygon <= polygons.length; polygon += 1) {
    while (cursor < segments.length && segments[cursor].polygon < polygon) cursor += 1;
    polygonSegmentStart[polygon] = cursor;
  }
  return { nodeCount: nodeX.length, segments, maskLeft, maskRight, edgeGrid, edgeSegmentStart, polygonSegmentStart };
}

// Mảng polygon của canvas không bị sửa tại chỗ (mỗi thao tác tạo mảng mới), nên cache theo mảng là an toàn.
const boundaryGraphCache = new WeakMap<AnnotationPolygon[], BoundaryGraph>();
function boundaryGraphFor(polygons: AnnotationPolygon[]): BoundaryGraph {
  let graph = boundaryGraphCache.get(polygons);
  if (!graph) {
    graph = buildBoundaryGraph(polygons);
    boundaryGraphCache.set(polygons, graph);
  }
  return graph;
}

function attachToBoundary(graph: BoundaryGraph, point: FlatPoint, tolerance: number) {
  let best: { segment: number; t: number; x: number; y: number; distance: number } | null = null;
  const grid = graph.edgeGrid;
  const centerX = Math.floor((point.x - grid.left) / grid.cell);
  const centerY = Math.floor((point.y - grid.top) / grid.cell);
  // Ô lưới ≥ AUTOFILL_ATTACH_MAX: khối 3×3 ô quanh điểm chứa mọi cạnh trong bán kính gắn.
  for (let cellY = Math.max(0, centerY - 1); cellY <= Math.min(grid.rows - 1, centerY + 1); cellY += 1) {
    for (let cellX = Math.max(0, centerX - 1); cellX <= Math.min(grid.columns - 1, centerX + 1); cellX += 1) {
      const cellIndex = cellY * grid.columns + cellX;
      for (let slot = grid.starts[cellIndex]; slot < grid.starts[cellIndex + 1]; slot += 1) {
        const edge = grid.items[slot];
        for (let index = graph.edgeSegmentStart[edge]; index < graph.edgeSegmentStart[edge + 1]; index += 1) {
          const segment = graph.segments[index];
          const dx = segment.bx - segment.ax;
          const dy = segment.by - segment.ay;
          const t = Math.max(0, Math.min(1, ((point.x - segment.ax) * dx + (point.y - segment.ay) * dy) / (dx * dx + dy * dy)));
          const x = segment.ax + t * dx;
          const y = segment.ay + t * dy;
          const distanceToSegment = Math.hypot(point.x - x, point.y - y);
          if (distanceToSegment <= tolerance && (!best || distanceToSegment < best.distance - 1e-9)) {
            best = { segment: index, t, x, y, distance: distanceToSegment };
          }
        }
      }
    }
  }
  return best;
}

type BoundaryAttach = NonNullable<ReturnType<typeof attachToBoundary>>;
type BoundaryRoute = { nodes: FlatPoint[]; steps: BoundaryStep[]; length: number; sign: -1 | 1 };

function binaryHeap() {
  const heap: Array<[number, number]> = [];
  return {
    get size() { return heap.length; },
    push(item: [number, number]) {
      heap.push(item);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent][0] <= heap[index][0]) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    },
    pop() {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === index) break;
          [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
          index = smallest;
        }
      }
      return top;
    },
  };
}

/**
 * Đường ngắn nhất trên biên tự do từ `fromAttach` tới `toAttach`, cho từng chiều đi (mask luôn ở bên trái
 * hoặc luôn ở bên phải, tức polygon mới luôn ở cùng một phía). Cạnh chạm bản nháp bị loại, trừ tại đầu đường
 * trùng một điểm của bản nháp (`fromDraftIndex`/`toDraftIndex`), nơi chỉ coi là chạm khi hai đoạn chồng lên nhau.
 * `nodes` là các đỉnh giữa hai đầu (không gồm hai đầu), theo thứ tự đi.
 */
function freeBoundaryRoutes(
  graph: BoundaryGraph,
  fromAttach: BoundaryAttach,
  toAttach: BoundaryAttach,
  draft: FlatPoint[],
  fromDraftIndex: number | null,
  toDraftIndex: number | null,
): BoundaryRoute[] {
  // Đầu đường nằm giữa cạnh thì thêm nút tạm (không sửa đồ thị đã cache).
  let nodeCount = graph.nodeCount;
  const overlayLeft = new Map<number, BoundaryStep[]>();
  const overlayRight = new Map<number, BoundaryStep[]>();
  const addOverlay = (overlay: Map<number, BoundaryStep[]>, from: number, step: BoundaryStep) => {
    const list = overlay.get(from);
    if (list) list.push(step); else overlay.set(from, [step]);
  };
  const resolveNode = (attach: BoundaryAttach) => {
    const segment = graph.segments[attach.segment];
    if (Math.hypot(attach.x - segment.ax, attach.y - segment.ay) <= AUTOFILL_ENDPOINT_SNAP) return segment.from;
    if (Math.hypot(attach.x - segment.bx, attach.y - segment.by) <= AUTOFILL_ENDPOINT_SNAP) return segment.to;
    return -1;
  };
  const fromFixed = resolveNode(fromAttach);
  const toFixed = resolveNode(toAttach);
  const fromNode = fromFixed >= 0 ? fromFixed : nodeCount++;
  const toNode = toFixed >= 0 ? toFixed : nodeCount++;
  if (fromNode === toNode) return [];
  const temporary = [
    ...(fromFixed < 0 ? [{ ...fromAttach, node: fromNode }] : []),
    ...(toFixed < 0 ? [{ ...toAttach, node: toNode }] : []),
  ];
  for (const segmentIndex of new Set(temporary.map((item) => item.segment))) {
    const segment = graph.segments[segmentIndex];
    const chain = [
      { x: segment.ax, y: segment.ay, node: segment.from },
      ...temporary.filter((item) => item.segment === segmentIndex).sort((left, right) => left.t - right.t),
      { x: segment.bx, y: segment.by, node: segment.to },
    ];
    for (let index = 0; index + 1 < chain.length; index += 1) {
      const p = chain[index];
      const q = chain[index + 1];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      addOverlay(overlayLeft, p.node, { to: q.node, fx: p.x, fy: p.y, tx: q.x, ty: q.y, length, polygon: segment.polygon });
      addOverlay(overlayRight, q.node, { to: p.node, fx: q.x, fy: q.y, tx: p.x, ty: p.y, length, polygon: segment.polygon });
    }
  }

  let draftLeft = Infinity;
  let draftTop = Infinity;
  let draftRight = -Infinity;
  let draftBottom = -Infinity;
  for (const point of draft) {
    draftLeft = Math.min(draftLeft, point.x - AUTOFILL_TOUCH_TOLERANCE);
    draftTop = Math.min(draftTop, point.y - AUTOFILL_TOUCH_TOLERANCE);
    draftRight = Math.max(draftRight, point.x + AUTOFILL_TOUCH_TOLERANCE);
    draftBottom = Math.max(draftBottom, point.y + AUTOFILL_TOUCH_TOLERANCE);
  }
  const draftIndexOf = (node: number) => (node === fromNode ? fromDraftIndex : node === toNode ? toDraftIndex : null);
  // Cạnh đi sát/cắt bản nháp là phần biên bản nháp đã nối (hoặc sẽ làm polygon tự cắt): không đi.
  const touchesDraft = (step: BoundaryStep, from: number) => {
    if (Math.max(step.fx, step.tx) < draftLeft || Math.min(step.fx, step.tx) > draftRight
      || Math.max(step.fy, step.ty) < draftTop || Math.min(step.fy, step.ty) > draftBottom) return false;
    const f = { x: step.fx, y: step.fy };
    const t = { x: step.tx, y: step.ty };
    const fromIndex = draftIndexOf(from);
    const toIndex = draftIndexOf(step.to);
    for (let index = 0; index + 1 < draft.length; index += 1) {
      const c = draft[index];
      const d = draft[index + 1];
      const sharedFrom = fromIndex === index ? c : fromIndex === index + 1 ? d : null;
      const sharedTo = toIndex === index ? c : toIndex === index + 1 ? d : null;
      if (sharedFrom && sharedTo) continue;
      const shared = sharedFrom ?? sharedTo;
      if (shared) {
        // Cùng xuất phát từ một điểm của bản nháp: chỉ coi là chạm khi hai đoạn chồng lên nhau.
        const edgeFar = sharedFrom ? t : f;
        const draftFar = shared === c ? d : c;
        if (pointSegmentDistance(edgeFar, c.x, c.y, d.x, d.y) <= AUTOFILL_TOUCH_TOLERANCE
          || pointSegmentDistance(draftFar, f.x, f.y, t.x, t.y) <= AUTOFILL_TOUCH_TOLERANCE) return true;
        continue;
      }
      if (segmentDistance(f, t, c, d) <= AUTOFILL_TOUCH_TOLERANCE) return true;
    }
    return false;
  };

  const shortestPath = (base: BoundaryStep[][], overlay: Map<number, BoundaryStep[]>) => {
    const distances = new Float64Array(nodeCount).fill(Infinity);
    const previous: Array<{ node: number; step: BoundaryStep } | undefined> = new Array(nodeCount);
    const heap = binaryHeap();
    distances[fromNode] = 0;
    heap.push([0, fromNode]);
    while (heap.size) {
      const [distanceSoFar, node] = heap.pop();
      if (distanceSoFar > distances[node]) continue;
      if (node === toNode) break;
      const steps = [...(node < graph.nodeCount ? base[node] : []), ...(overlay.get(node) ?? [])];
      for (const step of steps) {
        const next = distanceSoFar + step.length;
        if (next >= distances[step.to] || touchesDraft(step, node)) continue;
        distances[step.to] = next;
        previous[step.to] = { node, step };
        heap.push([next, step.to]);
      }
    }
    if (!Number.isFinite(distances[toNode])) return null;
    const steps: BoundaryStep[] = [];
    for (let node = toNode; node !== fromNode;) {
      const link = previous[node]!;
      steps.unshift(link.step);
      node = link.node;
    }
    return { steps, length: distances[toNode] };
  };

  const routes: BoundaryRoute[] = [];
  for (const [base, overlay, sign] of [[graph.maskLeft, overlayLeft, -1], [graph.maskRight, overlayRight, 1]] as const) {
    const found = shortestPath(base, overlay);
    if (!found) continue;
    const nodes: FlatPoint[] = [];
    const pushNode = (x: number, y: number) => {
      const last = nodes[nodes.length - 1];
      if (!last || Math.hypot(last.x - x, last.y - y) > 0.05) nodes.push({ x, y });
    };
    found.steps.forEach((step, index) => {
      // Tại chỗ chuyển mask, giữ đỉnh của cả hai mask (có thể lệch nhau vài px do vector hóa).
      if (index > 0) pushNode(step.fx, step.fy);
      if (index < found.steps.length - 1) pushNode(step.tx, step.ty);
    });
    const ends = [fromAttach, toAttach];
    routes.push({
      nodes: nodes.filter((node) => ends.every((end) => Math.hypot(node.x - end.x, node.y - end.y) > 0.05)),
      steps: found.steps,
      length: found.length,
      sign,
    });
  }
  return routes;
}

function finiteDraft(draftNodes: Array<{ x: number; y: number }>): FlatPoint[] {
  return draftNodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y)).map((node) => ({ x: node.x, y: node.y }));
}

/**
 * Đường tự nối từ endPoint về startPoint dọc theo biên tự do của các mask (không gồm hai điểm đó). Quy tắc
 * (người dùng xác nhận 2026-11-05): không gộp mask, không đi lại phần biên bản nháp đã nối, mỗi cạnh đi theo chiều
 * giữ mask ở NGOÀI polygon mới; giữ đường có dấu diện tích khớp chiều đó, bỏ đường vòng xa bản nháp, chọn ngắn nhất.
 * Canvas hiện dùng `findAutoAnchorPath` (2026-11-06); hàm này giữ cho việc khép polygon theo biên.
 */
export function findMultiPolygonAutofillPath(
  allPolygons: AnnotationPolygon[],
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
  tolerance = 14,
): MultiPolygonAutofillResult | null {
  if (!allPolygons || allPolygons.length === 0) return null;
  if (Math.hypot(startPoint.x - endPoint.x, startPoint.y - endPoint.y) < 1.0) return null;
  const graph = boundaryGraphFor(allPolygons);
  if (!graph.segments.length) return null;
  const attachTolerance = Math.max(AUTOFILL_SEAM_TOLERANCE + 0.5, Math.min(tolerance, AUTOFILL_ATTACH_MAX));
  const startAttach = attachToBoundary(graph, startPoint, attachTolerance);
  const endAttach = attachToBoundary(graph, endPoint, attachTolerance);
  if (!startAttach || !endAttach) return null;

  const draft = finiteDraft(draftNodes);
  if (!draft.length || Math.hypot(draft[0].x - startPoint.x, draft[0].y - startPoint.y) > 0.01) draft.unshift({ ...startPoint });
  if (Math.hypot(draft[draft.length - 1].x - endPoint.x, draft[draft.length - 1].y - endPoint.y) > 0.01) draft.push({ ...endPoint });
  const routes = freeBoundaryRoutes(graph, endAttach, startAttach, draft, draft.length - 1, 0);

  let draftLeft = Infinity;
  let draftTop = Infinity;
  let draftRight = -Infinity;
  let draftBottom = -Infinity;
  for (const point of draft) {
    draftLeft = Math.min(draftLeft, point.x);
    draftTop = Math.min(draftTop, point.y);
    draftRight = Math.max(draftRight, point.x);
    draftBottom = Math.max(draftBottom, point.y);
  }
  const draftExtent = Math.hypot(draftRight - draftLeft, draftBottom - draftTop);
  const candidates = routes.filter((route) => {
    const ring = [...draft, ...route.nodes];
    if (ring.length < 3) return false;
    const area = polygonArea(ring);
    // Dấu diện tích sai nghĩa là polygon mới sẽ bao luôn mask (đi vòng phía bên kia của mask).
    if (Math.sign(area) !== route.sign || Math.abs(area) < 1) return false;
    // Bỏ đường vòng đi xa bản nháp hơn cả kích thước bản nháp (ví dụ chui vào khe giữa hai mask rồi quay ra).
    const excursion = maxDistanceToPolyline([endPoint, ...route.nodes, startPoint], draft);
    return !(excursion > Math.max(tolerance * 3, 50) && excursion > draftExtent);
  });
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.length - right.length);
  const best = candidates[0];
  const used = new Set(best.steps.map((step) => step.polygon));
  return {
    nodes: best.nodes.map((node) => ({ id: createId(), x: node.x, y: node.y, isAnchor: true })),
    targetPolygons: allPolygons.filter((_, index) => used.has(index)),
  };
}

export interface AutoAnchorResult {
  /** Các điểm chèn vào bản nháp sau điểm vừa chấm, theo thứ tự; kết thúc bằng điểm đích (trừ khi đích là điểm đầu). */
  nodes: Array<{ id: string; x: number; y: number; isAnchor: boolean }>;
  /** Điểm đích trên biên và mask chứa nó (để chèn đỉnh vào mask đó khi người dùng xác nhận). */
  target: { x: number; y: number; polygonId: string };
  /** Đích trùng điểm đầu của bản nháp: đường đã khép polygon theo biên (vẫn chưa hoàn tất). */
  closesToStart: boolean;
}

/**
 * Điểm đích của auto anchor dưới con trỏ: con trỏ trong một mask (mask trên cùng) thì lấy điểm gần nhất trên biên
 * tự do của mask đó; con trỏ ngoài mask nhưng sát biên thì lấy đoạn biên tự do gần nhất.
 */
function autoAnchorTarget(graph: BoundaryGraph, polygons: AnnotationPolygon[], cursor: FlatPoint, tolerance: number): BoundaryAttach | null {
  for (let index = polygons.length - 1; index >= 0; index -= 1) {
    const polygon = polygons[index];
    if (polygon.nodes.length < 3) continue;
    const box = cachedPolygonBounds(polygon);
    if (cursor.x < box.left || cursor.x > box.right || cursor.y < box.top || cursor.y > box.bottom || !pointInMask(cursor, polygon)) continue;
    let best: BoundaryAttach | null = null;
    for (let segmentIndex = graph.polygonSegmentStart[index]; segmentIndex < graph.polygonSegmentStart[index + 1]; segmentIndex += 1) {
      const segment = graph.segments[segmentIndex];
      const dx = segment.bx - segment.ax;
      const dy = segment.by - segment.ay;
      const t = Math.max(0, Math.min(1, ((cursor.x - segment.ax) * dx + (cursor.y - segment.ay) * dy) / (dx * dx + dy * dy)));
      const x = segment.ax + t * dx;
      const y = segment.ay + t * dy;
      const distanceToSegment = Math.hypot(cursor.x - x, cursor.y - y);
      if (!best || distanceToSegment < best.distance - 1e-9) best = { segment: segmentIndex, t, x, y, distance: distanceToSegment };
    }
    // Mask bị bao kín (không còn biên tự do) thì không có đích.
    return best;
  }
  return attachToBoundary(graph, cursor, Math.min(tolerance, graph.edgeGrid.cell));
}

/**
 * Auto anchor khi vẽ polygon (người dùng xác nhận 2026-11-06): giữ Shift và trỏ vào trong mask kế bên để xem trước,
 * Shift + chuột trái để chèn. Đường chạy từ ĐIỂM VỪA CHẤM (phải nằm trên biên tự do) dọc theo biên tự do, qua nhiều
 * mask nếu cần, tới điểm đích trên biên mask đang trỏ; không đi phần biên đã dính mask khác (≤ AUTOFILL_SEAM_TOLERANCE)
 * và không đi lại phần bản nháp đã nối. Trong hai chiều đi quanh biên, chọn đường ngắn nhất; khi đích là điểm đầu
 * (khép polygon) thì ưu tiên chiều không bao mask vào trong. Không bao giờ hoàn tất polygon.
 */
export function findAutoAnchorPath(
  allPolygons: AnnotationPolygon[],
  cursor: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
  tolerance = 14,
): AutoAnchorResult | null {
  const draft = finiteDraft(draftNodes);
  if (!allPolygons?.length || !draft.length) return null;
  const graph = boundaryGraphFor(allPolygons);
  if (!graph.segments.length) return null;
  const last = draft[draft.length - 1];
  const fromAttach = attachToBoundary(graph, last, Math.max(AUTOFILL_SEAM_TOLERANCE + 0.5, Math.min(tolerance, AUTOFILL_ATTACH_MAX)));
  let toAttach = autoAnchorTarget(graph, allPolygons, cursor, tolerance);
  if (!fromAttach || !toAttach) return null;
  // Đích gần điểm đầu (trong ngưỡng bắt điểm) và điểm đầu nằm trên biên tự do: nối về đúng điểm đầu.
  const start = draft[0];
  const startAttach = draft.length >= 2 ? attachToBoundary(graph, start, AUTOFILL_ENDPOINT_SNAP) : null;
  const closesToStart = Boolean(startAttach && Math.hypot(toAttach.x - start.x, toAttach.y - start.y) <= tolerance);
  if (closesToStart && startAttach) toAttach = startAttach;
  if (Math.hypot(toAttach.x - last.x, toAttach.y - last.y) < 0.5) return null;
  const routes = freeBoundaryRoutes(graph, fromAttach, toAttach, draft, draft.length - 1, closesToStart ? 0 : null);
  const valid = closesToStart
    ? routes.filter((route) => Math.sign(polygonArea([...draft, ...route.nodes])) === route.sign)
    : routes;
  const best = [...(valid.length ? valid : routes)].sort((left, right) => left.length - right.length)[0];
  if (!best) return null;
  const target = { x: closesToStart ? start.x : toAttach.x, y: closesToStart ? start.y : toAttach.y };
  const points = closesToStart ? best.nodes : [...best.nodes, target];
  return {
    nodes: points.map((node) => ({ id: createId(), x: Math.round(node.x * 1000) / 1000, y: Math.round(node.y * 1000) / 1000, isAnchor: true })),
    target: { ...target, polygonId: allPolygons[graph.segments[toAttach.segment].polygon].id },
    closesToStart,
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

export function raySegmentIntersection(
  origin: { x: number; y: number },
  dirX: number,
  dirY: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): number | null {
  const vX = end.x - start.x;
  const vY = end.y - start.y;
  const denom = dirX * vY - dirY * vX;
  if (Math.abs(denom) < 1e-7) return null;

  const dX = start.x - origin.x;
  const dY = start.y - origin.y;
  const t = (dX * vY - dY * vX) / denom;
  const u = (dX * dirY - dY * dirX) / denom;

  if (t > 1e-3 && u >= -1e-4 && u <= 1 + 1e-4) {
    return t;
  }
  return null;
}

/**
 * Checks if a query point lies in an empty void/pocket completely surrounded by existing polygons.
 * If surrounded, computes and returns the new polygon that fills this enclosed void with 100% boundary adherence.
 */
export function findEnclosedPocketAtPoint(
  allPolygons: AnnotationPolygon[],
  point: { x: number; y: number },
  maxRadius = 250,
): AnnotationPolygon | null {
  if (!allPolygons || allPolygons.length < 2) return null;

  // 1. Must not be inside any existing polygon
  for (const poly of allPolygons) {
    if (pointInPolygon(point, poly.nodes)) return null;
  }

  // 2. Must not be right on an edge (within 3px) - that's for edge snapping / anchor creation
  for (const poly of allPolygons) {
    const len = poly.nodes.length;
    for (let i = 0; i < len; i += 1) {
      const a = poly.nodes[i];
      const b = poly.nodes[(i + 1) % len];
      if (closestPointOnSegment(point, a, b).distance <= 3.0) return null;
    }
  }

  // 3. Filter nearby polygons
  const nearby = allPolygons.filter((p) => {
    return p.nodes.some((n) => Math.hypot(n.x - point.x, n.y - point.y) <= maxRadius + 50);
  });
  if (nearby.length < 2) return null;

  // 4. Radial enclosure test: cast rays in 12 directions (every 30 deg).
  // All 12 rays MUST hit a polygon boundary within maxRadius.
  const numRays = 12;
  let maxHit = 0;
  for (let r = 0; r < numRays; r += 1) {
    const angle = (r * 2 * Math.PI) / numRays;
    const rayCos = Math.cos(angle);
    const raySin = Math.sin(angle);
    let closestHit = Infinity;
    for (const poly of nearby) {
      const n = poly.nodes.length;
      for (let i = 0; i < n; i += 1) {
        const a = poly.nodes[i];
        const b = poly.nodes[(i + 1) % n];
        const hit = raySegmentIntersection(point, rayCos, raySin, a, b);
        if (hit !== null && hit > 1.0 && hit < closestHit) {
          closestHit = hit;
        }
      }
    }
    if (closestHit > maxRadius) {
      return null; // Open to exterior
    }
    if (closestHit > maxHit) {
      maxHit = closestHit;
    }
  }
  if (maxHit < 4.0) return null;

  const buildPocketPolygon = (
    rawNodes: Array<{ x: number; y: number }>,
    surroundingPolys: AnnotationPolygon[],
  ): AnnotationPolygon | null => {
    const area = polygonArea(rawNodes);
    let nodes = area < 0 ? [...rawNodes].reverse() : [...rawNodes];

    // Snap each node to closest boundary of surrounding polygons
    nodes = nodes.map((nd) => {
      let bestPt = { x: nd.x, y: nd.y };
      let bestDist = Infinity;
      for (const poly of surroundingPolys) {
        const n = poly.nodes.length;
        for (let i = 0; i < n; i += 1) {
          const a = poly.nodes[i];
          const b = poly.nodes[(i + 1) % n];
          const cand = closestPointOnSegment(nd, a, b);
          if (cand.distance < bestDist) {
            bestDist = cand.distance;
            bestPt = cand.point;
          }
        }
      }
      if (bestDist <= 6.0) {
        return { ...nd, x: bestPt.x, y: bestPt.y };
      }
      return nd;
    });

    // Enrich edges with any original nodes from surroundingPolys
    const enriched: Array<{ x: number; y: number }> = [];
    const count = nodes.length;
    for (let i = 0; i < count; i += 1) {
      const p1 = nodes[i];
      const p2 = nodes[(i + 1) % count];
      enriched.push(p1);

      const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (segLen > 2.0) {
        const inter: Array<{ pt: { x: number; y: number }; t: number }> = [];
        for (const poly of surroundingPolys) {
          for (const orig of poly.nodes) {
            const cand = closestPointOnSegment(orig, p1, p2);
            if (cand.distance <= 2.5 && cand.projection > 0.03 && cand.projection < 0.97) {
              const dup = inter.some((item) => Math.hypot(item.pt.x - orig.x, item.pt.y - orig.y) < 1.0);
              if (!dup) {
                inter.push({ pt: { x: orig.x, y: orig.y }, t: cand.projection });
              }
            }
          }
        }
        inter.sort((a, b) => a.t - b.t);
        for (const item of inter) {
          enriched.push(item.pt);
        }
      }
    }

    // Filter near-duplicates
    const filtered = enriched.filter((pt, idx) =>
      idx === 0 || Math.hypot(pt.x - enriched[idx - 1].x, pt.y - enriched[idx - 1].y) >= 1.0
    );

    if (filtered.length < 3 || Math.abs(polygonArea(filtered)) < 15) {
      return null;
    }

    return {
      id: createId(),
      label: 'wart_flesh',
      nodes: filtered.map((pt) => ({
        id: createId(),
        x: Math.round(pt.x * 10) / 10,
        y: Math.round(pt.y * 10) / 10,
        isAnchor: true,
      })),
    };
  };

  // Method 1: Check holes in the union of nearby polygons
  const rings: GeometryRing[] = nearby
    .map((p) => normalizeRing(p.nodes.map((n): GeometryPoint => [n.x, n.y])))
    .filter((r): r is GeometryRing => Boolean(r));

  if (rings.length >= 2) {
    let unionComps: GeometryMultiPolygon = [];
    try {
      unionComps = unionGeometries(rings.map((r) => [r]));
    } catch {
      unionComps = [];
    }

    for (const comp of unionComps) {
      for (let h = 1; h < comp.length; h += 1) {
        const holeRing = comp[h];
        const holeNodes = holeRing.map(([x, y]) => ({ id: createId(), x, y, isAnchor: true }));
        if (pointInPolygon(point, holeNodes)) {
          return buildPocketPolygon(holeNodes, nearby);
        }
      }
    }

    // Method 2: Bridge components across small gaps <= 8px and check holes
    if (unionComps.length > 1) {
      const edges: Array<{ from: number; to: number; distance: number; pointA: { x: number; y: number }; pointB: { x: number; y: number } }> = [];
      for (let from = 0; from < unionComps.length; from += 1) {
        for (let to = from + 1; to < unionComps.length; to += 1) {
          const bp = closestBoundaryPoints(unionComps[from][0], unionComps[to][0]);
          if (bp.distance <= 8.0) {
            edges.push({ from, to, ...bp });
          }
        }
      }
      if (edges.length > 0) {
        const bridges: GeometryPolygon[] = [];
        for (const edge of edges) {
          bridges.push(createBridge(edge.pointA, edge.pointB, 3));
        }
        try {
          const bridgedComps = unionGeometries([...unionComps, ...bridges]);
          for (const comp of bridgedComps) {
            for (let h = 1; h < comp.length; h += 1) {
              const holeRing = comp[h];
              const holeNodes = holeRing.map(([x, y]) => ({ id: createId(), x, y, isAnchor: true }));
              if (pointInPolygon(point, holeNodes)) {
                return buildPocketPolygon(holeNodes, nearby);
              }
            }
          }
        } catch {
          // Fall through to Method 3
        }
      }
    }
  }

  // Method 3: Box difference with dilated rings
  const boxRadius = maxHit + 30;
  const boxRing: GeometryRing = [
    [point.x - boxRadius, point.y - boxRadius],
    [point.x + boxRadius, point.y - boxRadius],
    [point.x + boxRadius, point.y + boxRadius],
    [point.x - boxRadius, point.y + boxRadius],
  ];

  try {
    const dilatedPolygons: GeometryPolygon[] = [];
    for (const poly of nearby) {
      const pRing = normalizeRing(poly.nodes.map((n): GeometryPoint => [n.x, n.y]));
      if (!pRing) continue;
      const segBridges: GeometryPolygon[] = [];
      const n = poly.nodes.length;
      for (let i = 0; i < n; i += 1) {
        segBridges.push(createBridge(poly.nodes[i], poly.nodes[(i + 1) % n], 4));
      }
      try {
        const dilated = unionGeometries([[pRing], ...segBridges]);
        dilatedPolygons.push(...dilated);
      } catch {
        dilatedPolygons.push([pRing]);
      }
    }

    const diff = polygonClipping.difference([boxRing], ...dilatedPolygons);
    for (const comp of diff) {
      const outerRing = comp[0];
      const outerNodes = outerRing.map(([x, y]) => ({ id: createId(), x, y, isAnchor: true }));
      if (pointInPolygon(point, outerNodes)) {
        const touchesBox = outerRing.some(([x, y]) =>
          Math.abs(x - (point.x - boxRadius)) < 3 ||
          Math.abs(x - (point.x + boxRadius)) < 3 ||
          Math.abs(y - (point.y - boxRadius)) < 3 ||
          Math.abs(y - (point.y + boxRadius)) < 3
        );
        if (!touchesBox) {
          return buildPocketPolygon(outerNodes, nearby);
        }
      }
    }
  } catch {
    // Difference error
  }

  return null;
}
/**
 * Magnet khi kéo node trong Select (V) — người dùng xác nhận 2026-11-05: đỉnh (vòng ngoài và lỗ) gần (x, y) nhất
 * trong `tolerance`, bỏ qua polygon trong `excludePolygonIds` (các polygon đang kéo, để node không dính vào đỉnh
 * kề của chính nó). Trả về null nếu không có đỉnh nào đủ gần.
 */
export function nearestMagnetVertex(
  polygons: AnnotationPolygon[],
  excludePolygonIds: ReadonlySet<string>,
  x: number,
  y: number,
  tolerance: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = tolerance;
  for (const polygon of polygons) {
    if (excludePolygonIds.has(polygon.id) || polygon.nodes.length < 3) continue;
    const bounds = cachedPolygonBounds(polygon);
    if (x < bounds.left - tolerance || x > bounds.right + tolerance || y < bounds.top - tolerance || y > bounds.bottom + tolerance) continue;
    for (const ring of polygonRings(polygon)) {
      for (const node of ring) {
        const distanceToNode = Math.hypot(node.x - x, node.y - y);
        if (distanceToNode <= bestDistance) {
          best = { x: node.x, y: node.y };
          bestDistance = distanceToNode;
        }
      }
    }
  }
  return best;
}
