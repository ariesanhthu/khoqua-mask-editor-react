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

export interface ExactUnionResult {
  outerRing: GeometryRing;
  holeRings: GeometryRing[];
  area: number;
}

/**
 * Hợp hình học chính xác (Exact Boolean Union) giữa các polygon trong cùng một cụm liên thông.
 * - KHÔNG tạo bridge qua khoảng trống.
 * - KHÔNG xóa/lấp lỗ hổng (giữ nguyên holeRings).
 * - Diện tích được bảo toàn chuẩn xác: S_merged = S(outerRing) - sum(S(holeRings)).
 */
export function exactUnionPolygons(
  polygons: AnnotationPolygon[],
  gapTolerance = 2.0,
): ExactUnionResult | null {
  if (!polygons || polygons.length === 0) return null;
  if (polygons.length === 1) {
    const rawRing = polygons[0].nodes.map((node): GeometryPoint => [node.x, node.y]);
    const ring = normalizeRing(rawRing) || normalizeRing(convexHull(rawRing));
    if (!ring) return null;
    return {
      outerRing: ring,
      holeRings: (polygons[0].holes ?? []).map((h) => normalizeRing(h.map((n): GeometryPoint => [n.x, n.y]))).filter(Boolean) as GeometryRing[],
      area: Math.abs(polygonArea(polygons[0].nodes)),
    };
  }

  const rawRings: GeometryRing[] = [];
  for (const polygon of polygons) {
    if (polygon.nodes.length < 3) continue;
    const rawRing = polygon.nodes.map((node): GeometryPoint => [node.x, node.y]);
    const ring = normalizeRing(rawRing) || normalizeRing(convexHull(rawRing));
    if (ring) rawRings.push(ring);
  }
  if (!rawRings.length) return null;

  // Snap subpixel gap vertices between touching polygons if gap <= gapTolerance
  const adjustedRings = rawRings.map((ring, ringIdx) => {
    return ring.map((pt): GeometryPoint => {
      let closestPt = pt;
      let minD = gapTolerance;
      for (let otherIdx = 0; otherIdx < rawRings.length; otherIdx += 1) {
        if (otherIdx === ringIdx) continue;
        const otherRing = rawRings[otherIdx];
        for (let i = 0; i < otherRing.length - 1; i += 1) {
          const a = { x: otherRing[i][0], y: otherRing[i][1] };
          const b = { x: otherRing[i + 1][0], y: otherRing[i + 1][1] };
          const cand = closestPointOnSegment({ x: pt[0], y: pt[1] }, a, b);
          if (cand.distance < minD) {
            minD = cand.distance;
            closestPt = [cand.point.x, cand.point.y];
          }
        }
      }
      return closestPt;
    });
  });

  try {
    const multiPoly = polygonClipping.union(adjustedRings.map((ring) => [ring]));
    if (!multiPoly || !multiPoly.length) return null;

    let bestPoly = multiPoly[0];
    let maxArea = -1;
    for (const poly of multiPoly) {
      if (!poly.length) continue;
      const a = Math.abs(ringArea(poly[0]));
      if (a > maxArea) {
        maxArea = a;
        bestPoly = poly;
      }
    }

    if (!bestPoly || !bestPoly.length) return null;

    const outerRing = bestPoly[0];
    const holeRings = bestPoly.slice(1);

    let totalArea = Math.abs(ringArea(outerRing));
    for (const hole of holeRings) {
      totalArea -= Math.abs(ringArea(hole));
    }

    return {
      outerRing,
      holeRings,
      area: Math.max(0, totalArea),
    };
  } catch {
    return null;
  }
}

/**
 * Tạo polygon bao ngoài tổng quát (Outermost Boundary Envelope) từ một cụm mask liên thông.
 * Biên ngoài cùng này đã lọc sạch toàn bộ seam tiếp xúc nội bộ và không đi vào lỗ hổng bên trong.
 */
export function getCollectiveBoundaryEnvelope(
  polygons: AnnotationPolygon[],
): AnnotationPolygon | null {
  if (!polygons.length) return null;
  if (polygons.length === 1) return polygons[0];

  const unionRes = exactUnionPolygons(polygons);
  if (!unionRes) return null;

  const pts = unionRes.outerRing.slice(0, unionRes.outerRing.length - 1);
  return {
    id: 'collective_envelope',
    label: polygons[0].label,
    nodes: pts.map(([x, y]) => ({ id: createId(), x, y, isAnchor: true })),
  };
}

/**
 * Làm giàu đường đi bám biên bằng các đỉnh gốc của các mask thành phần.
 * Đảm bảo các đoạn thẳng sau phép union vẫn giữ nguyên từng đỉnh cong uốn lượn ban đầu.
 */
export function enrichPathWithOriginalNodes(
  pathPoints: Array<{ x: number; y: number }>,
  sourcePolygons: AnnotationPolygon[],
  tolerance = 2.0,
): Array<{ id: string; x: number; y: number; isAnchor: boolean }> {
  if (pathPoints.length < 2) {
    return pathPoints.map((p) => ({ id: createId(), x: p.x, y: p.y, isAnchor: true }));
  }

  const enriched: Array<{ id: string; x: number; y: number; isAnchor: boolean }> = [];
  for (let i = 0; i < pathPoints.length - 1; i += 1) {
    const p1 = pathPoints[i];
    const p2 = pathPoints[i + 1];
    enriched.push({ id: createId(), x: p1.x, y: p1.y, isAnchor: true });

    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (segLen > 1.0) {
      const intermediate: Array<{ x: number; y: number; t: number }> = [];
      for (const poly of sourcePolygons) {
        for (const orig of poly.nodes) {
          const cand = closestPointOnSegment(orig, p1, p2);
          if (cand.distance <= tolerance && cand.projection > 0.02 && cand.projection < 0.98) {
            const dup = intermediate.some((item) => Math.hypot(item.x - orig.x, item.y - orig.y) < 0.5);
            if (!dup) {
              intermediate.push({ x: orig.x, y: orig.y, t: cand.projection });
            }
          }
        }
      }
      intermediate.sort((a, b) => a.t - b.t);
      for (const item of intermediate) {
        enriched.push({ id: createId(), x: item.x, y: item.y, isAnchor: true });
      }
    }
  }

  const last = pathPoints[pathPoints.length - 1];
  enriched.push({ id: createId(), x: last.x, y: last.y, isAnchor: true });
  return enriched;
}

function doesPolygonTouchDraftInterior(
  polygon: AnnotationPolygon,
  draftNodes?: Array<{ x: number; y: number }>,
): boolean {
  if (!draftNodes || draftNodes.length <= 2) return false;
  for (let i = 1; i < draftNodes.length - 1; i += 1) {
    const pt = draftNodes[i];
    const cand = closestPointOnPolygon(polygon, pt);
    if (cand.distance <= 1.0) return true;
  }
  return false;
}

function draftProximityToPolygon(
  polygon: AnnotationPolygon,
  draftNodes: Array<{ x: number; y: number }>,
): number {
  if (!draftNodes || draftNodes.length < 2) return 0;
  const points = draftNodes.length >= 3 ? draftNodes.slice(1, -1) : draftNodes;
  let totalD = 0;
  for (const pt of points) {
    totalD += closestPointOnPolygon(polygon, pt).distance;
  }
  return totalD / points.length;
}

export function findBestSnapTarget(
  allPolygons: AnnotationPolygon[],
  point: { x: number; y: number },
  tolerance: number,
  draftNodes?: Array<{ x: number; y: number }>,
): SnapTarget | null {
  const candidates = allPolygons.filter((p) => {
    return closestPointOnPolygon(p, point).distance <= tolerance;
  });
  if (!candidates.length) return null;
  if (candidates.length > 1 && draftNodes && draftNodes.length >= 2) {
    candidates.sort((a, b) => draftProximityToPolygon(a, draftNodes) - draftProximityToPolygon(b, draftNodes));
  }
  return findSnapTargetToPolygons(candidates, point, tolerance);
}

/**
 * Tìm chuỗi các polygon tiếp xúc kề nhau (connected chain) từ startId tới endId.
 * Ưu tiên các polygon gần draftNodes nhất.
 * Loại bỏ các polygon trung gian mà bản nháp đã đi qua bên trong.
 * Nếu tách rời nhau (không liên thông) trả về null.
 */
export function findTouchingChain(
  allPolygons: AnnotationPolygon[],
  startId: string,
  endId: string,
  tolerance = 14,
  draftNodes?: Array<{ x: number; y: number }>,
): string[] | null {
  if (startId === endId) return [startId];

  type QueueItem = { path: string[]; cost: number };
  const queue: QueueItem[] = [{ path: [startId], cost: 0 }];
  const bestCost = new Map<string, number>([[startId, 0]]);
  let foundPath: string[] | null = null;

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { path: currentPath, cost: currentCost } = queue.shift()!;
    const currentId = currentPath[currentPath.length - 1];

    if (currentId === endId) {
      foundPath = currentPath;
      break;
    }

    if (currentCost > (bestCost.get(currentId) ?? Infinity)) continue;

    const currentPoly = allPolygons.find((p) => p.id === currentId);
    if (!currentPoly) continue;

    for (const other of allPolygons) {
      if (currentPath.includes(other.id)) continue;
      // Không đi qua mask trung gian mà bản nháp đã đi qua bên trong
      if (other.id !== startId && other.id !== endId && doesPolygonTouchDraftInterior(other, draftNodes)) {
        continue;
      }
      if (arePolygonsTouching(currentPoly, other, Math.max(tolerance * 0.5, 4))) {
        const proxCost = draftNodes && draftNodes.length >= 2 ? polygonDistanceToDraft(other, draftNodes) : 0;
        const nextCost = currentCost + 1 + proxCost;
        if (nextCost < (bestCost.get(other.id) ?? Infinity)) {
          bestCost.set(other.id, nextCost);
          queue.push({ path: [...currentPath, other.id], cost: nextCost });
        }
      }
    }
  }

  return foundPath;
}

const collectiveCache = new Map<string, AnnotationPolygon>();

export function getCachedCollectivePolygon(polygons: AnnotationPolygon[]): AnnotationPolygon | null {
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return polygons[0];

  const key = polygons.map((p) => `${p.id}_${p.nodes.length}`).sort().join('|');
  const cached = collectiveCache.get(key);
  if (cached) return cached;

  const res = getCollectiveBoundaryEnvelope(polygons);
  if (res) {
    if (collectiveCache.size > 20) collectiveCache.clear();
    collectiveCache.set(key, res);
    return res;
  }
  return null;
}

// ── Tự nối biên (auto anchor, giữ Shift khi vẽ polygon) ─────────────────────────────────────────────
// Người dùng xác nhận 2026-11-07:
// Dựa trên các mask có sẵn merge lại thành mask chung theo thành phần đồ thị liên thông (Connected Components)
// để chỉ có 1 biên bao quanh tổng quát (outer boundary envelope).
// Auto-fill bám tới phần biên ngoài cùng của mask chung đó.
// Bảo toàn diện tích tuyệt đối (S_merged = S(A U B) = S_A + S_B - S_AB), không thêm diện tích, không bắc cầu qua khoảng trống.
// Trong trường hợp các mask tạo thành Ring (có khoảng trống ở giữa), bảo toàn toàn bộ lỗ hổng ring, không auto-fill nội dung bên trong.

type FlatPoint = { x: number; y: number };

function finiteDraft(draftNodes: Array<{ x: number; y: number }>): FlatPoint[] {
  return draftNodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y)).map((node) => ({ x: node.x, y: node.y }));
}

/**
 * Tự nối biên qua nhiều mask (findMultiPolygonAutofillPath):
 * Dựa trên các mask có sẵn, gộp (merge) lại thành mask chung theo thành phần liên thông
 * (kề nhau thì merge, tách rời nhau thì KHÔNG merge), tạo 1 biên bao quanh tổng quát.
 * Auto-fill bám theo biên ngoài cùng của mask chung đó.
 * Bảo toàn diện tích tuyệt đối: không tạo bridge, không xóa lỗ rỗng, diện tích trước và sau bằng nhau.
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

  const startSnap = findBestSnapTarget(allPolygons, startPoint, tolerance, draftNodes);
  const endSnap = findBestSnapTarget(allPolygons, endPoint, tolerance, draftNodes);
  if (!startSnap || !endSnap) return null;

  // Trường hợp cùng 1 polygon
  if (startSnap.polygonId === endSnap.polygonId) {
    const cluster = getConnectedPolygonCluster(allPolygons, [startSnap.polygonId], tolerance);
    if (cluster.length > 1) {
      const collective = getCollectiveBoundaryEnvelope(cluster);
      if (collective) {
        const dStart = closestPointOnPolygon(collective, startSnap.point).distance;
        const dEnd = closestPointOnPolygon(collective, endSnap.point).distance;
        if (dStart > tolerance || dEnd > tolerance) {
          // Điểm nằm trên đường nối nội bộ (seam) giữa 2 mask, không có biên tự do
          return null;
        }
      }
    }

    const singlePath = getSharedBoundaryAutofillPath(
      startSnap.polygon,
      startSnap.point,
      endSnap.point,
      draftNodes,
    );
    if (singlePath && singlePath.length >= 0) {
      const enriched = enrichPathWithOriginalNodes([endSnap.point, ...singlePath, startSnap.point], [startSnap.polygon]);
      return {
        nodes: enriched.slice(1, -1),
        targetPolygons: [startSnap.polygon],
      };
    }
    return null;
  }

  // Trường hợp nhiều polygon: chỉ merge nếu các mask kế nhau (cùng thành phần liên thông)
  const chainIds = findTouchingChain(allPolygons, startSnap.polygonId, endSnap.polygonId, tolerance, draftNodes);
  if (!chainIds || chainIds.length < 2) {
    // Tách rời nhau: tuyệt đối không merge
    return null;
  }

  const chainPolygons = chainIds
    .map((id) => allPolygons.find((p) => p.id === id))
    .filter((p): p is AnnotationPolygon => Boolean(p));

  // Kiểm tra không đi đường vòng quá xa bản nháp
  if (draftNodes && draftNodes.length >= 2) {
    let draftLeft = Infinity, draftTop = Infinity, draftRight = -Infinity, draftBottom = -Infinity;
    for (const p of draftNodes) {
      draftLeft = Math.min(draftLeft, p.x);
      draftTop = Math.min(draftTop, p.y);
      draftRight = Math.max(draftRight, p.x);
      draftBottom = Math.max(draftBottom, p.y);
    }
    const draftExtent = Math.hypot(draftRight - draftLeft, draftBottom - draftTop);
    const maxAllowedDist = Math.max(tolerance * 3, 50, draftExtent * 1.5);
    for (const poly of chainPolygons) {
      const d = polygonDistanceToDraft(poly, draftNodes);
      if (d > maxAllowedDist && d > 100) {
        return null; // Bỏ đường vòng xa
      }
    }
  }

  // Gộp các mask liên thông thành 1 mask chung (Outermost boundary envelope)
  const collectivePoly = getCollectiveBoundaryEnvelope(chainPolygons);
  if (!collectivePoly) return null;

  const closestToOuterStart = closestPointOnPolygon(collectivePoly, startSnap.point);
  const closestToOuterEnd = closestPointOnPolygon(collectivePoly, endSnap.point);
  if (closestToOuterStart.distance > tolerance || closestToOuterEnd.distance > tolerance) {
    // Nằm trong seam nội bộ hoặc trong lỗ hổng đã bị loại bỏ khỏi biên ngoài
    return null;
  }

  const autofillNodes = getSharedBoundaryAutofillPath(
    collectivePoly,
    closestToOuterStart.point,
    closestToOuterEnd.point,
    draftNodes,
  );
  if (!autofillNodes) return null;

  const waypoints = [closestToOuterEnd.point, ...autofillNodes, closestToOuterStart.point];
  const enrichedNodes = enrichPathWithOriginalNodes(waypoints, chainPolygons);
  const finalNodes = enrichedNodes.slice(1, -1);

  const ring = [...draftNodes, ...finalNodes];
  if (ring.length >= 3) {
    const area = polygonArea(ring);
    if (Math.abs(area) < 1) return null;
  }

  return {
    nodes: finalNodes,
    targetPolygons: chainPolygons,
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
 * Auto anchor khi vẽ polygon (Shift):
 * Dựa trên các mask có sẵn, gộp các mask liên thông kề nhau thành mask chung để có 1 biên bao quanh tổng quát.
 * Sau đó auto-fill bám tới biên ngoài cùng của mask.
 * Nếu tách rời nhau thì không merge.
 * Giữ nguyên lỗ rỗng (nếu có dạng Ring), không auto-fill nội dung bên trong của mask.
 * Diện tích trước và sau khi gộp bằng nhau chuẩn xác.
 */
export function findAutoAnchorPath(
  allPolygons: AnnotationPolygon[],
  cursor: { x: number; y: number },
  draftNodes: Array<{ x: number; y: number }>,
  tolerance = 14,
): AutoAnchorResult | null {
  const draft = finiteDraft(draftNodes);
  if (!allPolygons?.length || !draft.length) return null;

  const last = draft[draft.length - 1];
  const start = draft[0];

  const lastSnap = findBestSnapTarget(allPolygons, last, Math.max(tolerance, 6), draft);
  if (!lastSnap) return null;

  let targetPoly: AnnotationPolygon | null = null;
  for (let i = allPolygons.length - 1; i >= 0; i -= 1) {
    const p = allPolygons[i];
    if (pointInMask(cursor, p)) {
      targetPoly = p;
      break;
    }
  }
  if (!targetPoly) {
    const cursorSnap = findBestSnapTarget(allPolygons, cursor, tolerance, draft);
    targetPoly = cursorSnap?.polygon ?? null;
  }
  if (!targetPoly) return null;

  const startSnap = draft.length >= 2 ? findBestSnapTarget(allPolygons, start, tolerance, draft) : null;
  const closesToStart = Boolean(startSnap && Math.hypot(cursor.x - start.x, cursor.y - start.y) <= tolerance);

  const destinationId = closesToStart ? startSnap!.polygonId : targetPoly.id;

  // Tìm chuỗi các mask tiếp xúc liên thông
  let chainPolygons: AnnotationPolygon[];
  if (lastSnap.polygonId === destinationId) {
    chainPolygons = [lastSnap.polygon];
  } else {
    const chainIds = findTouchingChain(allPolygons, lastSnap.polygonId, destinationId, tolerance, draft);
    if (!chainIds) {
      // Tách rời nhau: không merge
      return null;
    }
    chainPolygons = chainIds
      .map((id) => allPolygons.find((p) => p.id === id))
      .filter((p): p is AnnotationPolygon => Boolean(p));
  }

  // Gộp thành 1 biên bao ngoài tổng quát duy nhất
  const collectivePoly = getCollectiveBoundaryEnvelope(chainPolygons);
  if (!collectivePoly) return null;

  const pFrom = closestPointOnPolygon(collectivePoly, last).point;
  const pTo = closesToStart ? start : closestPointOnPolygon(collectivePoly, cursor).point;

  if (Math.hypot(pTo.x - pFrom.x, pTo.y - pFrom.y) < 0.5) return null;

  // Điểm bắt đầu phải nằm sát biên ngoài của cụm
  if (Math.hypot(pFrom.x - last.x, pFrom.y - last.y) > tolerance) {
    return null;
  }

  // Tìm đường đi bám biên ngoài từ pFrom tới pTo
  const rawPath = getSharedBoundaryAutofillPath(collectivePoly, pTo, pFrom, draft);
  if (!rawPath) return null;

  const waypoints = [pFrom, ...rawPath, pTo];
  const enriched = enrichPathWithOriginalNodes(waypoints, chainPolygons);
  const nodes = enriched.slice(1, -1);

  const target = { x: closesToStart ? start.x : pTo.x, y: closesToStart ? start.y : pTo.y };
  const finalNodes = closesToStart ? nodes : [...nodes, { id: createId(), ...target, isAnchor: true }];

  return {
    nodes: finalNodes.map((n) => ({ id: n.id, x: Math.round(n.x * 1000) / 1000, y: Math.round(n.y * 1000) / 1000, isAnchor: true })),
    target: { ...target, polygonId: targetPoly.id },
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
