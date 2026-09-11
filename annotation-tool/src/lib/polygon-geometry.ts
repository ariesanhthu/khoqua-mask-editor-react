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
function polygonGeometry(polygon: AnnotationPolygon): GeometryPolygon | null {
  const rings = polygonRings(polygon).map((nodes) => normalizeRing(nodes));
  return rings.some((ring) => !ring) ? null : rings as GeometryPolygon;
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
      ring.push([snap(point.x + Math.cos(angle) * usableRadius), snap(point.y + Math.sin(angle) * usableRadius)]);
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
  const touched = geometries.map((geometry) => !!geometry
    && intersectionGeometries(geometry, stroke).length > 0);
  if (mode === 'erase') {
    const resultIds: string[] = [];
    const next = polygons.flatMap((polygon, index) => {
      if (!touched[index]) return [polygon];
      return brushComponents(differenceGeometries(geometries[index]!, stroke)).map((shape) => {
        const created = { ...shape, id: createId(), label: polygon.label, meta: { ...polygon.meta, source: 'human' as const } };
        resultIds.push(created.id);
        return created;
      });
    });
    if (!touched.some(Boolean)) return { error: 'Nét tẩy chưa chạm vùng mask nào.' };
    return { polygons: next, resultIds };
  }

  const affectedIndexes = touched.flatMap((value, index) => value ? [index] : []);
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
  const affected = new Set(affectedIndexes);
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
    const bounds = ringBounds(polygon.nodes.map((node) => [node.x, node.y]));
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
