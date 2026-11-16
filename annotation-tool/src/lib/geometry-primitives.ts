import type { AnnotationPolygon, PolygonNode } from '@/types';
import polygonClipping from 'polygon-clipping';

/**
 * Hình học cấp thấp dùng chung (không DOM, không React) cho polygon-geometry, mask-anchor, polygon-paint và
 * node-anchor. Chuyển nguyên văn từ polygon-geometry.ts (2026-11-12) để các module mới dùng chung mà không
 * import vòng; polygon-geometry.ts re-export các tên public cũ nên API không đổi.
 */

export const EPSILON = 1e-6;
export const GEOMETRY_EPSILON = 1e-6;
export const MIN_REGION_AREA = 1e-6;

export type GeometryPoint = [number, number];
export type GeometryRing = GeometryPoint[];
export type GeometryPolygon = GeometryRing[];
export type GeometryMultiPolygon = GeometryPolygon[];
export type ClipInput = GeometryPolygon | GeometryMultiPolygon;
export type GeometryBounds = { left: number; right: number; top: number; bottom: number };

export const createId = () => crypto.randomUUID();

export const pointsEqual = (a: GeometryPoint, b: GeometryPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= GEOMETRY_EPSILON;

export function ringArea(ring: GeometryRing): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

export function orientation(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function pointOnSegment(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint): boolean {
  return Math.abs(orientation(start, end, point)) <= GEOMETRY_EPSILON
    && point[0] >= Math.min(start[0], end[0]) - GEOMETRY_EPSILON
    && point[0] <= Math.max(start[0], end[0]) + GEOMETRY_EPSILON
    && point[1] >= Math.min(start[1], end[1]) - GEOMETRY_EPSILON
    && point[1] <= Math.max(start[1], end[1]) + GEOMETRY_EPSILON;
}

export function segmentsIntersect(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint, d: GeometryPoint): boolean {
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

export function ringSelfIntersects(ring: GeometryRing): boolean {
  // Ring lớn (mask raster vừa vector hóa có hàng chục nghìn đỉnh): chỉ so các cặp cạnh chung ô lưới, cùng kết quả
  // với vòng lặp O(n²) bên dưới nhưng nhanh hơn nhiều bậc (2026-11-12, Paint trên mask lớn từng treo 41 s).
  if (ring.length > 64) return ringSelfIntersectsGrid(ring);
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

function ringSelfIntersectsGrid(ring: GeometryRing): boolean {
  const count = ring.length;
  let totalLength = 0;
  for (let index = 0; index < count; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % count];
    totalLength += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const cell = Math.max(1e-3, (totalLength / count) * 4);
  const pad = GEOMETRY_EPSILON;
  // Hộp bao (đã nới pad) của từng cạnh, tính theo ô lưới.
  const boxes = new Float64Array(count * 4);
  const grid = new Map<string, number[]>();
  for (let index = 0; index < count; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % count];
    const left = Math.min(a[0], b[0]) - pad; const right = Math.max(a[0], b[0]) + pad;
    const top = Math.min(a[1], b[1]) - pad; const bottom = Math.max(a[1], b[1]) + pad;
    boxes.set([left, top, right, bottom], index * 4);
    for (let cx = Math.floor(left / cell); cx <= Math.floor(right / cell); cx += 1) {
      for (let cy = Math.floor(top / cell); cy <= Math.floor(bottom / cell); cy += 1) {
        const key = `${cx}:${cy}`;
        const list = grid.get(key);
        if (list) list.push(index); else grid.set(key, [index]);
      }
    }
  }
  for (const [key, list] of grid) {
    const separator = key.indexOf(':');
    const cx = Number(key.slice(0, separator));
    const cy = Number(key.slice(separator + 1));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const first = Math.min(list[i], list[j]);
        const second = Math.max(list[i], list[j]);
        const firstNext = (first + 1) % count;
        const secondNext = (second + 1) % count;
        if (firstNext === second || secondNext === first) continue;
        // Loại sớm theo hộp bao; mỗi cặp chỉ xét ở ô chung đầu tiên (ô chứa góc trên trái của phần giao hai hộp).
        const overlapLeft = Math.max(boxes[first * 4], boxes[second * 4]);
        const overlapTop = Math.max(boxes[first * 4 + 1], boxes[second * 4 + 1]);
        if (overlapLeft > Math.min(boxes[first * 4 + 2], boxes[second * 4 + 2])
          || overlapTop > Math.min(boxes[first * 4 + 3], boxes[second * 4 + 3])) continue;
        if (Math.floor(overlapLeft / cell) !== cx || Math.floor(overlapTop / cell) !== cy) continue;
        if (segmentsIntersect(ring[first], ring[firstNext], ring[second], ring[secondNext])) return true;
      }
    }
  }
  return false;
}

export function normalizeRing(nodes: Array<Pick<PolygonNode, 'x' | 'y'> | GeometryPoint>): GeometryRing | null {
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

export function unionGeometries(geometries: GeometryPolygon[]): GeometryMultiPolygon {
  const union = polygonClipping.union as unknown as (...items: GeometryPolygon[]) => GeometryMultiPolygon;
  return union(...geometries);
}

export function differenceGeometries(subject: ClipInput, clip: ClipInput): GeometryMultiPolygon {
  const difference = polygonClipping.difference as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return difference(subject, clip);
}

export function unionClipInputs(items: ClipInput[]): GeometryMultiPolygon {
  const union = polygonClipping.union as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return union(items[0], ...items.slice(1));
}

export function intersectionGeometries(subject: ClipInput, clip: ClipInput): GeometryMultiPolygon {
  const intersection = polygonClipping.intersection as unknown as (first: ClipInput, ...rest: ClipInput[]) => GeometryMultiPolygon;
  return intersection(subject, clip);
}

/** Tổng diện tích (dương) của một MultiPolygon: vòng ngoài trừ các lỗ. */
export function multiPolygonArea(geometry: GeometryMultiPolygon): number {
  let total = 0;
  for (const polygon of geometry) {
    polygon.forEach((ring, index) => { total += index === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring)); });
  }
  return Math.max(0, total);
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

export function pointInPolygon(point: Pick<PolygonNode, 'x' | 'y'>, nodes: Array<Pick<PolygonNode, 'x' | 'y'>>): boolean {
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

export function ringBounds(ring: GeometryRing): GeometryBounds {
  return ring.reduce<GeometryBounds>((result, [x, y]) => ({
    left: Math.min(result.left, x),
    right: Math.max(result.right, x),
    top: Math.min(result.top, y),
    bottom: Math.max(result.bottom, y),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}

export function boundsOverlap(a: GeometryBounds, b: GeometryBounds): boolean {
  return a.right >= b.left && a.left <= b.right && a.bottom >= b.top && a.top <= b.bottom;
}

/** Validate every brush boundary without replacing the shape with a convex hull. */
const geometryCache = new WeakMap<AnnotationPolygon, GeometryPolygon | null>();
const geometryBoundsCache = new WeakMap<AnnotationPolygon, GeometryBounds>();
export function cachedPolygonBounds(polygon: AnnotationPolygon): GeometryBounds {
  const cached = geometryBoundsCache.get(polygon);
  if (cached) return cached;
  const bounds = ringBounds(polygon.nodes.map((node) => [node.x, node.y]));
  geometryBoundsCache.set(polygon, bounds);
  return bounds;
}
export function polygonGeometry(polygon: AnnotationPolygon): GeometryPolygon | null {
  if (geometryCache.has(polygon)) return geometryCache.get(polygon)!;
  const rings = polygonRings(polygon).map((nodes) => normalizeRing(nodes));
  const geometry = rings.some((ring) => !ring) ? null : rings as GeometryPolygon;
  geometryCache.set(polygon, geometry);
  return geometry;
}

const clipGeometryCache = new WeakMap<AnnotationPolygon, GeometryMultiPolygon | null>();
/**
 * Hình học để clipping của một mask, kể cả mask tự chạm/tự cắt mà `polygonGeometry` trả null. Prelabel vector hóa
 * từ raster có ~26% polygon tự chạm tại một đỉnh (đỉnh trùng, điểm thắt), đo trên drive/prelabel-production
 * 2026-11-13. polygon-clipping nhận vòng tự chạm/tự cắt (luật non-zero), nên vòng thô đi qua union một lần để
 * được MultiPolygon sạch. Polygon hợp lệ thì trả nguyên `[polygonGeometry]`. Không sửa polygon gốc.
 */
export function maskClipGeometry(polygon: AnnotationPolygon): GeometryMultiPolygon | null {
  if (clipGeometryCache.has(polygon)) return clipGeometryCache.get(polygon)!;
  const valid = polygonGeometry(polygon);
  let result: GeometryMultiPolygon | null = valid ? [valid] : null;
  if (!valid && polygon.nodes.length >= 3) {
    const cleanRing = (ring: PolygonNode[]) => {
      const points = ring
        .filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y))
        .map((node): GeometryPoint => [node.x, node.y])
        .filter((point, index, all) => index === 0 || !pointsEqual(point, all[index - 1]));
      if (points.length > 1 && pointsEqual(points[0], points[points.length - 1])) points.pop();
      return points;
    };
    const outer = cleanRing(polygon.nodes);
    const rings = [outer, ...(polygon.holes ?? []).map(cleanRing).filter((ring) => ring.length >= 3)];
    if (outer.length >= 3) {
      try {
        const cleaned = unionGeometries([rings]);
        result = multiPolygonArea(cleaned) > MIN_REGION_AREA ? cleaned : null;
      } catch {
        result = null;
      }
    }
  }
  clipGeometryCache.set(polygon, result);
  return result;
}

export function polygonRings(polygon: AnnotationPolygon): PolygonNode[][] {
  return [polygon.nodes, ...(polygon.holes ?? [])];
}

export function pointInMask(point: Pick<PolygonNode, 'x' | 'y'>, polygon: AnnotationPolygon): boolean {
  return pointInPolygon(point, polygon.nodes)
    && !(polygon.holes ?? []).some((ring) => pointInPolygon(point, ring));
}

export function ringToNodes(ring: GeometryRing): PolygonNode[] {
  return ring.map(([x, y]) => ({ id: createId(), x, y }));
}

/** Preserve both the outer boundary and every unpainted inner boundary. */
export function geometryComponents(components: GeometryMultiPolygon) {
  return components.flatMap((component) => {
    const rings = component.map((ring) => normalizeRing(ring));
    if (rings.some((ring) => !ring)) throw new Error('Invalid clipping result');
    const [outer, ...holes] = rings as GeometryRing[];
    if (Math.abs(ringArea(outer)) < MIN_REGION_AREA) return [];
    return [{ nodes: ringToNodes(outer), ...(holes.length ? { holes: holes.map(ringToNodes) } : {}) }];
  });
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

/** Chân đường vuông góc chính xác (không làm tròn) và khoảng cách từ `point` tới đoạn `start`–`end`. */
export function projectOntoSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number; distance: number; t: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared <= 1e-12 ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const x = start.x + t * dx;
  const y = start.y + t * dy;
  return { x, y, distance: Math.hypot(point.x - x, point.y - y), t };
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

/**
 * Gắn lại id/isAnchor của đỉnh gốc vào vòng kết quả của phép clipping, và chèn lại các đỉnh gốc nằm trên
 * cạnh của vòng đó (polygon-clipping bỏ đỉnh thẳng hàng). Nhờ vậy phần biên không đổi giữ nguyên đỉnh, kể
 * cả đỉnh dùng chung với mask kế bên. `tolerance` tính bằng px ảnh. Đỉnh không khớp đỉnh gốc nào được tạo id mới.
 *
 * Nhanh trên ring lớn (mask raster vừa vector hóa): cạnh nối hai đỉnh gốc liền nhau của cùng một vòng gốc không thể
 * có đỉnh gốc nào bị bỏ ở giữa, nên chỉ cạnh mới do clipping tạo ra mới phải tra lưới đỉnh gốc.
 */
const SOURCE_CELL = 16;
const positionKey = (point: { x: number; y: number }) => `${Math.round(point.x * 1e6)}:${Math.round(point.y * 1e6)}`;

/** Chỉ mục đỉnh gốc cho restoreSourceVertices: dựng một lần, dùng cho mọi vòng của cùng một kết quả clipping. */
export interface SourceVertexIndex {
  sources: PolygonNode[][];
  /** Vị trí → (vòng gốc, chỉ số) của lần xuất hiện đầu tiên. */
  byPosition: Map<string, { node: PolygonNode; source: number; index: number }>;
  /** Lưới đỉnh gốc, dựng lười khi có cạnh mới cần tra. */
  grid(): Map<string, PolygonNode[]>;
}

export function indexSourceVertices(sources: PolygonNode[][]): SourceVertexIndex {
  const byPosition = new Map<string, { node: PolygonNode; source: number; index: number }>();
  sources.forEach((source, sourceIndex) => source.forEach((node, index) => {
    const nodeKey = positionKey(node);
    if (!byPosition.has(nodeKey)) byPosition.set(nodeKey, { node, source: sourceIndex, index });
  }));
  let cells: Map<string, PolygonNode[]> | null = null;
  return {
    sources,
    byPosition,
    grid() {
      if (cells) return cells;
      cells = new Map();
      for (const source of sources) {
        for (const node of source) {
          const cellKey = `${Math.floor(node.x / SOURCE_CELL)}:${Math.floor(node.y / SOURCE_CELL)}`;
          const list = cells.get(cellKey);
          if (list) list.push(node); else cells.set(cellKey, [node]);
        }
      }
      return cells;
    },
  };
}

export function restoreSourceVertices(
  ring: Array<Pick<PolygonNode, 'x' | 'y'> & Partial<PolygonNode>>,
  sourcesOrIndex: PolygonNode[][] | SourceVertexIndex,
  tolerance = 0.05,
): PolygonNode[] {
  const fresh = (point: Pick<PolygonNode, 'x' | 'y'> & Partial<PolygonNode>): PolygonNode => ({
    ...point, id: point.id ?? createId(), x: point.x, y: point.y, isAnchor: point.isAnchor ?? true,
  });
  const index = Array.isArray(sourcesOrIndex) ? indexSourceVertices(sourcesOrIndex) : sourcesOrIndex;
  const { sources, byPosition } = index;
  if (!byPosition.size || ring.length < 3) return ring.map(fresh);
  const CELL = SOURCE_CELL;
  const gridOf = () => index.grid();
  const onSegment = (node: PolygonNode, start: { x: number; y: number }, end: { x: number; y: number }) => {
    const hit = projectOntoSegment(node, start, end);
    if (hit.distance > tolerance || hit.t <= 1e-9 || hit.t >= 1 - 1e-9) return null;
    if (Math.hypot(node.x - start.x, node.y - start.y) <= 1e-6 || Math.hypot(node.x - end.x, node.y - end.y) <= 1e-6) return null;
    return hit.t;
  };
  const matched = ring.map((point) => byPosition.get(positionKey(point)));
  const result: PolygonNode[] = [];
  for (let position = 0; position < ring.length; position += 1) {
    const start = ring[position];
    const end = ring[(position + 1) % ring.length];
    const a = matched[position];
    const b = matched[(position + 1) % ring.length];
    result.push(a ? { ...a.node } : fresh(start));
    let candidates: PolygonNode[] | null = null;
    if (a && b && a.source === b.source) {
      const source = sources[a.source];
      const count = source.length;
      const forward = (b.index - a.index + count) % count;
      const backward = (a.index - b.index + count) % count;
      if (forward === 1 || backward === 1) continue;
      // Các đỉnh gốc nằm giữa theo chiều ngắn hơn (đỉnh thẳng hàng bị polygon-clipping bỏ).
      const steps = Math.min(forward, backward);
      if (steps <= 256) {
        const direction = forward <= backward ? 1 : -1;
        candidates = [];
        for (let step = 1; step < steps; step += 1) candidates.push(source[(a.index + direction * step + count) % count]);
      }
    }
    if (!candidates) {
      const left = Math.min(start.x, end.x) - tolerance;
      const right = Math.max(start.x, end.x) + tolerance;
      const top = Math.min(start.y, end.y) - tolerance;
      const bottom = Math.max(start.y, end.y) + tolerance;
      candidates = [];
      const cells = gridOf();
      for (let cx = Math.floor(left / CELL); cx <= Math.floor(right / CELL); cx += 1) {
        for (let cy = Math.floor(top / CELL); cy <= Math.floor(bottom / CELL); cy += 1) {
          for (const node of cells.get(`${cx}:${cy}`) ?? []) {
            if (node.x >= left && node.x <= right && node.y >= top && node.y <= bottom) candidates.push(node);
          }
        }
      }
    }
    const inserted: Array<{ node: PolygonNode; t: number }> = [];
    for (const node of candidates) {
      const t = onSegment(node, start, end);
      if (t === null || inserted.some((item) => Math.hypot(item.node.x - node.x, item.node.y - node.y) <= 1e-6)) continue;
      inserted.push({ node: { ...node }, t });
    }
    inserted.sort((first, second) => first.t - second.t);
    for (const item of inserted) result.push(item.node);
  }
  return result;
}
