import type { AnnotationPolygon, PolygonNode } from '@/types';
import {
  boundsOverlap,
  cachedPolygonBounds,
  closestPointOnSegment,
  createId,
  intersectionGeometries,
  maskClipGeometry,
  multiPolygonArea,
  normalizeRing,
  pathDistanceToDraft,
  pointInMask,
  polygonArea,
  polygonGeometry,
  polygonRings,
  projectOntoSegment,
  ringBounds,
  segmentsIntersect,
  unionGeometries,
  type GeometryBounds,
  type GeometryMultiPolygon,
  type GeometryPoint,
  type GeometryPolygon,
  type GeometryRing,
} from './geometry-primitives';

/**
 * Neo + Tự hoàn thiện (người dùng xác nhận 2026-11-12), dùng chung cho công cụ P, Paint và kéo điểm trong Select.
 *
 * - Neo: con trỏ/điểm đang kéo tới gần biên mask thì nối vào đúng điểm đó (trùng đỉnh nếu rất gần, không thì
 *   điểm trên cạnh và mask kia được chèn đỉnh này).
 * - Tự hoàn thiện: từ điểm đã neo, tạo các điểm dọc biên tự do của nhóm mask liền nhau tới điểm neo kế tiếp.
 *   Nhóm = thành phần liên thông theo khoảng cách ≤ TOUCH_TOLERANCE (px ảnh, không đổi theo zoom). Biên tự do =
 *   các vòng của phép hợp ảo nhóm (vòng ngoài + khoảng trống bị bao kín); mask gốc không đổi.
 *
 * Mọi hàm thuần và bất biến. Mô hình biên được cache theo danh tính mảng polygon: canvas luôn tạo mảng mới khi
 * đổi polygon (không sửa tại chỗ), nên rê chuột trên cùng một mảng dùng lại đồ thị chạm, nhóm và vòng hợp.
 */

export const TOUCH_TOLERANCE = 2.5;
/** Đỉnh gốc cách vòng hợp ≤ ngưỡng này được chèn lại vào vòng (giữ đỉnh thật, chỗ nối chữ T). */
const ENRICH_TOLERANCE = 2;
/** Bỏ các đỉnh của đường cách hai đầu < 2 px (như bản 2026-11-07). */
const ENDPOINT_GAP = 2;
const CELL_SIZE = 32;

export type Point = { x: number; y: number };

export interface AnchorTarget {
  polygonId: string;
  /** 0 = vòng ngoài, k = holes[k - 1]; -1 khi điểm chỉ dùng để khép bản nháp (không chèn đỉnh). */
  ring: number;
  edgeIndex: number;
  point: Point;
  /** Có khi điểm neo trùng một đỉnh sẵn có (không cần chèn). */
  vertexId?: string;
}

export interface AnchorOptions {
  excludeIds?: ReadonlySet<string>;
  /** Hình đang dựng (bản nháp / polygon đang sửa): khi điểm nằm sát hai mask, ưu tiên mask gần hình này hơn. */
  context?: Point[];
  /** Không trúng biên nào nhưng điểm nằm trong một mask: lấy điểm biên gần nhất của mask đó (chỉ dùng khi giữ Shift). */
  inside?: boolean;
}

const hypot = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function contextProximity(polygon: AnnotationPolygon, context: Point[]): number {
  const points = context.length >= 3 ? context.slice(1, -1) : context;
  let total = 0;
  for (const point of points) {
    let best = Infinity;
    for (const ring of polygonRings(polygon)) {
      for (let index = 0; index < ring.length; index += 1) {
        best = Math.min(best, projectOntoSegment(point, ring[index], ring[(index + 1) % ring.length]).distance);
      }
    }
    total += best;
  }
  return points.length ? total / points.length : 0;
}

/** Điểm biên gần `point` nhất trên mọi vòng của một polygon, làm tròn 0.1 px như mọi điểm neo. */
function nearestBoundaryTarget(polygon: AnnotationPolygon, point: Point): { target: AnchorTarget; distance: number } | null {
  let best: { target: AnchorTarget; distance: number } | null = null;
  const rings = polygonRings(polygon);
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];
    if (ring.length < 3) continue;
    for (let index = 0; index < ring.length; index += 1) {
      const candidate = closestPointOnSegment(point, ring[index], ring[(index + 1) % ring.length]);
      if (!best || candidate.distance < best.distance) {
        best = { distance: candidate.distance, target: { polygonId: polygon.id, ring: ringIndex, edgeIndex: index, point: candidate.point } };
      }
    }
  }
  return best ? { distance: best.distance, target: withVertex(polygon, best.target) } : null;
}

/** Điểm trên cạnh nhưng trùng (≤ 0.05 px) một đầu mút: coi là trúng đỉnh đó, tránh chèn đỉnh trùng. */
function withVertex(polygon: AnnotationPolygon, target: AnchorTarget, tolerance = 0.05): AnchorTarget {
  const ring = polygonRings(polygon)[target.ring];
  if (!ring) return target;
  const candidates = [ring[target.edgeIndex], ring[(target.edgeIndex + 1) % ring.length]];
  const vertex = candidates.find((node) => node && hypot(node, target.point) <= tolerance);
  return vertex ? { ...target, point: { x: vertex.x, y: vertex.y }, vertexId: vertex.id } : target;
}

/**
 * NEO: điểm trên biên mask gần `p` nhất trong `tolerance` (px ảnh, thường là 14 px màn hình / zoom).
 * Trúng đỉnh (≤ 3 px, hoặc ≤ min(0.35·tolerance, 4) với đỉnh anchor) thắng trúng cạnh; xét cả vòng ngoài và lỗ.
 */
export function findAnchorTarget(
  polygons: readonly AnnotationPolygon[],
  p: Point,
  tolerance: number,
  options: AnchorOptions = {},
): AnchorTarget | null {
  const { excludeIds, context, inside } = options;
  const anchorTolerance = Math.min(tolerance * 0.35, 4);
  let candidates = polygons.filter((polygon) => {
    if (excludeIds?.has(polygon.id) || polygon.nodes.length < 3) return false;
    const bounds = cachedPolygonBounds(polygon);
    return p.x >= bounds.left - tolerance && p.x <= bounds.right + tolerance
      && p.y >= bounds.top - tolerance && p.y <= bounds.bottom + tolerance;
  });
  if (context && context.length >= 2 && candidates.length > 1) {
    const scored = candidates.map((polygon) => ({ polygon, score: contextProximity(polygon, context) }));
    scored.sort((a, b) => a.score - b.score);
    candidates = scored.map((item) => item.polygon);
  }

  let vertexHit: { target: AnchorTarget; distance: number } | null = null;
  let edgeHit: { target: AnchorTarget; distance: number; polygon: AnnotationPolygon } | null = null;
  for (const polygon of candidates) {
    const rings = polygonRings(polygon);
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      const ring = rings[ringIndex];
      if (ring.length < 3) continue;
      for (let index = 0; index < ring.length; index += 1) {
        const node = ring[index];
        const distance = hypot(node, p);
        const direct = (node.isAnchor && distance <= anchorTolerance) || distance <= 3;
        if (direct && (!vertexHit || distance < vertexHit.distance)) {
          vertexHit = { distance, target: { polygonId: polygon.id, ring: ringIndex, edgeIndex: index, point: { x: node.x, y: node.y }, vertexId: node.id } };
        }
        const candidate = closestPointOnSegment(p, node, ring[(index + 1) % ring.length]);
        if (candidate.distance <= tolerance && (!edgeHit || candidate.distance < edgeHit.distance)) {
          edgeHit = { polygon, distance: candidate.distance, target: { polygonId: polygon.id, ring: ringIndex, edgeIndex: index, point: candidate.point } };
        }
      }
    }
  }
  if (vertexHit) return vertexHit.target;
  if (edgeHit) return withVertex(edgeHit.polygon, edgeHit.target);
  if (inside) {
    for (let index = polygons.length - 1; index >= 0; index -= 1) {
      const polygon = polygons[index];
      if (excludeIds?.has(polygon.id) || polygon.nodes.length < 3 || !pointInMask(p, polygon)) continue;
      return nearestBoundaryTarget(polygon, p)?.target ?? null;
    }
  }
  return null;
}

/**
 * Áp điểm neo: chèn đỉnh vào mask đích nếu điểm rơi giữa cạnh (mask khóa thì không chèn). Trả mảng mới khi có
 * thay đổi, nếu không trả nguyên mảng cũ. `point` là tọa độ cuối cùng của điểm neo (trùng đỉnh của mask).
 */
export function applyAnchor(
  polygons: AnnotationPolygon[],
  target: AnchorTarget,
): { polygons: AnnotationPolygon[]; point: Point; nodeId?: string } {
  if (target.vertexId) return { polygons, point: { ...target.point }, nodeId: target.vertexId };
  const index = polygons.findIndex((polygon) => polygon.id === target.polygonId);
  const polygon = polygons[index];
  const ring = polygon ? polygonRings(polygon)[target.ring] : undefined;
  if (!polygon || !ring || target.edgeIndex < 0 || target.edgeIndex >= ring.length) return { polygons, point: { ...target.point } };
  const existing = ring.find((node) => hypot(node, target.point) <= 0.05);
  if (existing) return { polygons, point: { x: existing.x, y: existing.y }, nodeId: existing.id };
  if (polygon.meta?.locked) return { polygons, point: { ...target.point } };
  const node: PolygonNode = { id: createId(), x: Math.round(target.point.x * 10) / 10, y: Math.round(target.point.y * 10) / 10, isAnchor: true };
  const nextRing = [...ring.slice(0, target.edgeIndex + 1), node, ...ring.slice(target.edgeIndex + 1)];
  const updated: AnnotationPolygon = {
    ...polygon,
    nodes: target.ring === 0 ? nextRing : polygon.nodes,
    ...(polygon.holes ? { holes: polygon.holes.map((hole, holeIndex) => (holeIndex === target.ring - 1 ? nextRing : hole)) } : {}),
    meta: { ...polygon.meta, source: 'human' },
  };
  const next = polygons.slice();
  next[index] = updated;
  return { polygons: next, point: { x: node.x, y: node.y }, nodeId: node.id };
}

// ── Mô hình biên tự do (cache theo mảng polygon) ─────────────────────────────────────────────────────

interface SegmentRef { polygon: number; a: Point; b: Point }
interface VertexRef { polygon: number; node: PolygonNode }

interface BoundaryRing {
  points: Point[];
  /** Mask sở hữu từng cạnh (cạnh i: points[i] → points[i+1]); -1 nếu không xác định. */
  owners: Int32Array;
  /**
   * 1 nếu cạnh nằm sát (≤ TOUCH) hoặc trong một mask CÙNG NHÓM nhưng ở ngoài cửa sổ: trong phép hợp cả nhóm,
   * cạnh đó là seam nên đường không được đi qua. Luôn 0 khi vòng dựng từ cả nhóm.
   */
  blocked: Uint8Array;
  bounds: GeometryBounds;
}

interface GroupBoundary {
  /** Các mask đã hợp (cả nhóm, hoặc phần nhóm giao cửa sổ). */
  members: number[];
  memberSet: Set<number>;
  /** Phép hợp ảo (null nếu polygon-clipping không xử lý được, khi đó mỗi mask là một vòng riêng). */
  union: GeometryMultiPolygon | null;
  unionBounds: GeometryBounds;
  rings: BoundaryRing[];
}

interface SceneModel {
  valid: boolean[];
  /** Hình học clipping của từng mask (sửa cả mask tự chạm), xem maskClipGeometry. */
  geometry: Array<GeometryMultiPolygon | null>;
  segmentGrid: Map<number, SegmentRef[]>;
  vertexGrid: Map<number, VertexRef[]>;
  groupOf: Int32Array;
  groupMembers: number[][];
  /** Biên đã dựng, khóa = danh sách mask đã hợp. */
  boundaries: Map<string, GroupBoundary>;
  /** Hợp con dùng đo phần chồng, khóa = danh sách mask. */
  overlapUnions: Map<string, GeometryMultiPolygon | null>;
}

const sceneCache = new WeakMap<readonly AnnotationPolygon[], SceneModel>();

const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
const cellOf = (value: number) => Math.floor(value / CELL_SIZE);

function forEachCell(bounds: GeometryBounds, visit: (key: number) => void) {
  for (let cx = cellOf(bounds.left); cx <= cellOf(bounds.right); cx += 1) {
    for (let cy = cellOf(bounds.top); cy <= cellOf(bounds.bottom); cy += 1) visit(cellKey(cx, cy));
  }
}

function pushCell<T>(grid: Map<number, T[]>, key: number, value: T) {
  const list = grid.get(key);
  if (list) list.push(value); else grid.set(key, [value]);
}

const expandBounds = (bounds: GeometryBounds, margin: number): GeometryBounds => ({
  left: bounds.left - margin, right: bounds.right + margin, top: bounds.top - margin, bottom: bounds.bottom + margin,
});

const mergeBounds = (a: GeometryBounds, b: GeometryBounds): GeometryBounds => ({
  left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom),
});

function pointBounds(points: Point[]): GeometryBounds {
  return points.reduce<GeometryBounds>((bounds, point) => ({
    left: Math.min(bounds.left, point.x), right: Math.max(bounds.right, point.x),
    top: Math.min(bounds.top, point.y), bottom: Math.max(bounds.bottom, point.y),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}

function sceneModel(polygons: readonly AnnotationPolygon[]): SceneModel {
  const cached = sceneCache.get(polygons);
  if (cached) return cached;
  const geometry = polygons.map((polygon) => (polygon.nodes.length >= 3 ? maskClipGeometry(polygon) : null));
  const valid = geometry.map(Boolean);
  const segmentGrid = new Map<number, SegmentRef[]>();
  const vertexGrid = new Map<number, VertexRef[]>();
  polygons.forEach((polygon, polygonIndex) => {
    if (!valid[polygonIndex]) return;
    for (const ring of polygonRings(polygon)) {
      ring.forEach((node, index) => {
        pushCell(vertexGrid, cellKey(cellOf(node.x), cellOf(node.y)), { polygon: polygonIndex, node });
        const next = ring[(index + 1) % ring.length];
        const segment: SegmentRef = { polygon: polygonIndex, a: node, b: next };
        // Đăng ký theo hộp bao nới TOUCH: mọi điểm cách đoạn ≤ TOUCH nằm trong một ô đã đăng ký đoạn đó.
        forEachCell({
          left: Math.min(node.x, next.x) - TOUCH_TOLERANCE, right: Math.max(node.x, next.x) + TOUCH_TOLERANCE,
          top: Math.min(node.y, next.y) - TOUCH_TOLERANCE, bottom: Math.max(node.y, next.y) + TOUCH_TOLERANCE,
        }, (key) => pushCell(segmentGrid, key, segment));
      });
    }
  });
  const model: SceneModel = {
    valid, geometry, segmentGrid, vertexGrid,
    groupOf: new Int32Array(polygons.length).fill(-1),
    groupMembers: [],
    boundaries: new Map(),
    overlapUnions: new Map(),
  };
  sceneCache.set(polygons, model);
  return model;
}

/** Các đoạn (của mask được `accept`) cách `point` ≤ TOUCH, kèm chân vuông góc chính xác. */
function segmentsNear(model: SceneModel, point: Point, accept: (polygon: number) => boolean) {
  const result: Array<{ segment: SegmentRef; x: number; y: number; distance: number }> = [];
  for (const segment of model.segmentGrid.get(cellKey(cellOf(point.x), cellOf(point.y))) ?? []) {
    if (!accept(segment.polygon)) continue;
    const hit = projectOntoSegment(point, segment.a, segment.b);
    if (hit.distance <= TOUCH_TOLERANCE) result.push({ segment, x: hit.x, y: hit.y, distance: hit.distance });
  }
  return result;
}

function neighbors(polygons: readonly AnnotationPolygon[], model: SceneModel, index: number): Set<number> {
  const found = new Set<number>();
  const polygon = polygons[index];
  const bounds = cachedPolygonBounds(polygon);
  const other = (candidate: number) => candidate !== index && !found.has(candidate);
  for (const ring of polygonRings(polygon)) {
    ring.forEach((node, nodeIndex) => {
      // Đỉnh của mask này sát cạnh mask khác.
      for (const hit of segmentsNear(model, node, other)) found.add(hit.segment.polygon);
      // Đỉnh của mask khác sát cạnh của mask này, hoặc hai cạnh cắt nhau (chồng nhau mà không đỉnh nào gần cạnh nào).
      const next = ring[(nodeIndex + 1) % ring.length];
      const segmentBounds = {
        left: Math.min(node.x, next.x) - TOUCH_TOLERANCE, right: Math.max(node.x, next.x) + TOUCH_TOLERANCE,
        top: Math.min(node.y, next.y) - TOUCH_TOLERANCE, bottom: Math.max(node.y, next.y) + TOUCH_TOLERANCE,
      };
      forEachCell(segmentBounds, (key) => {
        for (const vertex of model.vertexGrid.get(key) ?? []) {
          if (!other(vertex.polygon)) continue;
          if (projectOntoSegment(vertex.node, node, next).distance <= TOUCH_TOLERANCE) found.add(vertex.polygon);
        }
        for (const segment of model.segmentGrid.get(key) ?? []) {
          if (!other(segment.polygon)) continue;
          if (segmentsIntersect([node.x, node.y], [next.x, next.y], [segment.a.x, segment.a.y], [segment.b.x, segment.b.y])) found.add(segment.polygon);
        }
      });
    });
  }
  // Mask nằm trọn trong mask khác (không cạnh nào gần nhau).
  polygons.forEach((candidate, candidateIndex) => {
    if (!other(candidateIndex) || !model.valid[candidateIndex]) return;
    const candidateBounds = cachedPolygonBounds(candidate);
    if (!boundsOverlap(bounds, candidateBounds)) return;
    if (pointInMask(candidate.nodes[0], polygon) || pointInMask(polygon.nodes[0], candidate)) found.add(candidateIndex);
  });
  return found;
}

function groupIndexOf(polygons: readonly AnnotationPolygon[], model: SceneModel, seed: number): number {
  if (model.groupOf[seed] >= 0) return model.groupOf[seed];
  const groupIndex = model.groupMembers.length;
  const members: number[] = [];
  const queue = [seed];
  model.groupOf[seed] = groupIndex;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    members.push(current);
    for (const next of neighbors(polygons, model, current)) {
      if (!model.valid[next] || model.groupOf[next] >= 0) continue;
      model.groupOf[next] = groupIndex;
      queue.push(next);
    }
  }
  members.sort((a, b) => a - b);
  model.groupMembers.push(members);
  return groupIndex;
}

function closeRing(ring: GeometryRing): GeometryRing {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

/**
 * Bản sao của mỗi mask với đỉnh cách biên mask khác đang hợp ≤ TOUCH được kéo lên biên đó (khép khe hở).
 * Mask tự chạm/tự cắt dùng hình học đã sửa, không kéo đỉnh.
 */
function snappedGeometry(polygons: readonly AnnotationPolygon[], model: SceneModel, memberSet: Set<number>, member: number): GeometryPolygon[] {
  const original = polygonGeometry(polygons[member]);
  if (!original) return model.geometry[member] ?? [];
  const rings = polygonRings(polygons[member]).map((ring) => {
    const moved: GeometryRing = ring.map((node) => {
      let best: { x: number; y: number; distance: number } | null = null;
      for (const hit of segmentsNear(model, node, (polygon) => polygon !== member && memberSet.has(polygon))) {
        if (!best || hit.distance < best.distance) best = hit;
      }
      return best && best.distance > 1e-9 ? [best.x, best.y] : [node.x, node.y];
    });
    return normalizeRing(moved);
  });
  return [rings.every(Boolean) ? rings as GeometryRing[] : original];
}

function unionOf(geometries: GeometryPolygon[]): GeometryMultiPolygon | null {
  try {
    return unionGeometries(geometries);
  } catch {
    // polygon-clipping thỉnh thoảng vỡ khi hai biên gần trùng: thử lại một lần trên lưới 1/64 px.
    const snap = (value: number) => Math.round(value * 64) / 64;
    try {
      return unionGeometries(geometries.map((polygon) => polygon.map((ring) => ring.map(([x, y]): GeometryPoint => [snap(x), snap(y)]))));
    } catch {
      return null;
    }
  }
}

function nearestOriginalVertex(model: SceneModel, memberSet: Set<number>, point: Point, tolerance: number): PolygonNode | null {
  let best: PolygonNode | null = null;
  let bestDistance = tolerance;
  forEachCell({ left: point.x - tolerance, right: point.x + tolerance, top: point.y - tolerance, bottom: point.y + tolerance }, (key) => {
    for (const vertex of model.vertexGrid.get(key) ?? []) {
      if (!memberSet.has(vertex.polygon)) continue;
      const distance = hypot(vertex.node, point);
      if (distance <= bestDistance) { best = vertex.node; bestDistance = distance; }
    }
  });
  return best;
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect([a.x, a.y], [b.x, b.y], [c.x, c.y], [d.x, d.y])) return 0;
  return Math.min(
    projectOntoSegment(a, c, d).distance, projectOntoSegment(b, c, d).distance,
    projectOntoSegment(c, a, b).distance, projectOntoSegment(d, a, b).distance,
  );
}

/** Cạnh a→b của vòng cục bộ chạm/nằm trong một mask cùng nhóm ở ngoài cửa sổ (`excluded`). */
function touchesExcluded(polygons: readonly AnnotationPolygon[], model: SceneModel, excluded: Set<number>, a: Point, b: Point): boolean {
  let hit = false;
  forEachCell({
    left: Math.min(a.x, b.x) - TOUCH_TOLERANCE, right: Math.max(a.x, b.x) + TOUCH_TOLERANCE,
    top: Math.min(a.y, b.y) - TOUCH_TOLERANCE, bottom: Math.max(a.y, b.y) + TOUCH_TOLERANCE,
  }, (key) => {
    if (hit) return;
    for (const segment of model.segmentGrid.get(key) ?? []) {
      if (excluded.has(segment.polygon) && segmentDistance(a, b, segment.a, segment.b) <= TOUCH_TOLERANCE) { hit = true; return; }
    }
  });
  if (hit) return true;
  const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const index of excluded) {
    const bounds = cachedPolygonBounds(polygons[index]);
    if (middle.x < bounds.left || middle.x > bounds.right || middle.y < bounds.top || middle.y > bounds.bottom) continue;
    if (pointInMask(middle, polygons[index])) return true;
  }
  return false;
}

/**
 * Dựng một vòng biên tự do: đỉnh của vòng hợp được thay bằng đỉnh gốc gần nhất (≤ 0.5 px), rồi chèn lại các đỉnh
 * gốc nằm trên cạnh (polygon-clipping bỏ đỉnh thẳng hàng, nên chỗ nối giữa các mask phải được trả lại).
 */
function buildBoundaryRing(
  polygons: readonly AnnotationPolygon[],
  model: SceneModel,
  memberSet: Set<number>,
  excluded: Set<number>,
  raw: GeometryRing,
): BoundaryRing {
  const base = closeRing(raw).map(([x, y]) => {
    const original = nearestOriginalVertex(model, memberSet, { x, y }, 0.5);
    return original ? { x: original.x, y: original.y } : { x, y };
  });
  const points: Point[] = [];
  for (let index = 0; index < base.length; index += 1) {
    const start = base[index];
    const end = base[(index + 1) % base.length];
    points.push(start);
    const length = hypot(start, end);
    if (length <= 1) continue;
    const inserted: Array<{ point: Point; t: number }> = [];
    forEachCell({
      left: Math.min(start.x, end.x) - ENRICH_TOLERANCE, right: Math.max(start.x, end.x) + ENRICH_TOLERANCE,
      top: Math.min(start.y, end.y) - ENRICH_TOLERANCE, bottom: Math.max(start.y, end.y) + ENRICH_TOLERANCE,
    }, (key) => {
      for (const vertex of model.vertexGrid.get(key) ?? []) {
        if (!memberSet.has(vertex.polygon)) continue;
        const hit = projectOntoSegment(vertex.node, start, end);
        if (hit.distance > ENRICH_TOLERANCE || hit.t <= 0.02 || hit.t >= 0.98) continue;
        if (inserted.some((item) => hypot(item.point, vertex.node) < 0.5)) continue;
        inserted.push({ point: { x: vertex.node.x, y: vertex.node.y }, t: hit.t });
      }
    });
    inserted.sort((a, b) => a.t - b.t);
    for (const item of inserted) points.push(item.point);
  }
  const owners = new Int32Array(points.length).fill(-1);
  const blocked = new Uint8Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    let best = Infinity;
    for (const hit of segmentsNear(model, middle, (polygon) => memberSet.has(polygon))) {
      if (hit.distance < best || (hit.distance === best && hit.segment.polygon < owners[index])) {
        best = hit.distance;
        owners[index] = hit.segment.polygon;
      }
    }
    if (excluded.size && touchesExcluded(polygons, model, excluded, start, end)) blocked[index] = 1;
  }
  return { points, owners, blocked, bounds: ringBounds(points.map((point): GeometryPoint => [point.x, point.y])) };
}

/** Biên tự do của `members` (cả nhóm hoặc phần nhóm trong cửa sổ); cạnh chạm mask nhóm ngoài cửa sổ bị chặn. */
function groupBoundary(polygons: readonly AnnotationPolygon[], model: SceneModel, members: number[], groupMembers: number[]): GroupBoundary {
  const key = members.join(',');
  const cached = model.boundaries.get(key);
  if (cached) return cached;
  const memberSet = new Set(members);
  const excluded = new Set(groupMembers.filter((member) => !memberSet.has(member)));
  const union = members.length === 1
    ? model.geometry[members[0]]
    : unionOf(members.flatMap((member) => snappedGeometry(polygons, model, memberSet, member)));
  // Không hợp được thì mỗi mask là một vòng riêng: vẫn neo và đi theo biên từng mask, nhưng không qua chỗ nối.
  const pieces = union ?? members.flatMap((member) => model.geometry[member] ?? []);
  const rings = pieces.flatMap((component) => component.map((ring) => buildBoundaryRing(polygons, model, memberSet, excluded, ring)));
  const unionBounds = rings.reduce<GeometryBounds>((bounds, ring) => mergeBounds(bounds, ring.bounds), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  const boundary: GroupBoundary = { members, memberSet, union: pieces, unionBounds, rings };
  model.boundaries.set(key, boundary);
  return boundary;
}

// ── Vị trí trên vòng và hai chiều đi ─────────────────────────────────────────────────────────────────

interface RingPosition { segment: number; t: number; u: number; x: number; y: number; distance: number }

function locateOnRing(ring: BoundaryRing, point: Point, accept: (segment: number) => boolean = () => true): RingPosition | null {
  const count = ring.points.length;
  let best: RingPosition | null = null;
  for (let index = 0; index < count; index += 1) {
    if (!accept(index)) continue;
    const hit = projectOntoSegment(point, ring.points[index], ring.points[(index + 1) % count]);
    if (!best || hit.distance < best.distance) {
      // Chân trùng đầu mút cuối của đoạn: chuẩn hóa thành đầu đoạn kế tiếp (u nguyên).
      const atEnd = hit.t >= 1 - 1e-9;
      best = { segment: atEnd ? (index + 1) % count : index, t: atEnd ? 0 : hit.t, u: atEnd ? (index + 1) % count : index + hit.t, x: hit.x, y: hit.y, distance: hit.distance };
    }
  }
  return best;
}

/** Đỉnh của vòng nằm giữa `from` và `to` theo chiều thuận (+1) hoặc nghịch (-1), theo thứ tự từ `from`. */
function arcVertices(ring: BoundaryRing, from: RingPosition, to: RingPosition, direction: 1 | -1): Point[] {
  const count = ring.points.length;
  const modulo = (value: number) => ((value % count) + count) % count;
  const span = direction === 1 ? modulo(to.u - from.u) : modulo(from.u - to.u);
  const result: Point[] = [];
  for (let step = 0; step < count; step += 1) {
    const vertex = direction === 1 ? modulo(Math.floor(from.u) + 1 + step) : modulo(Math.ceil(from.u) - 1 - step);
    const offset = direction === 1 ? modulo(vertex - from.u) : modulo(from.u - vertex);
    if (offset <= 1e-9 || offset >= span - 1e-9) {
      if (offset >= span - 1e-9) break;
      continue;
    }
    result.push(ring.points[vertex]);
  }
  return result;
}

/** Các cạnh của vòng mà đường từ `from` tới `to` theo `direction` đi qua (kể cả cạnh chỉ đi một phần). */
function arcSegments(ring: BoundaryRing, from: RingPosition, to: RingPosition, direction: 1 | -1): number[] {
  const count = ring.points.length;
  const modulo = (value: number) => ((value % count) + count) % count;
  const span = direction === 1 ? modulo(to.u - from.u) : modulo(from.u - to.u);
  // Cùng một khoảng trên trục u chưa quấn: [lowU, lowU + span].
  const lowU = direction === 1 ? from.u : from.u - span;
  const first = Math.floor(lowU + 1e-9);
  const last = Math.ceil(lowU + span - 1e-9) - 1;
  const segments: number[] = [];
  for (let segment = first; segment <= last && segments.length < count; segment += 1) segments.push(modulo(segment));
  return segments;
}

function pathLength(points: Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += hypot(points[index - 1], points[index]);
  return total;
}

interface Evaluation {
  arc: Point[];
  direction: 1 | -1;
  /** Đường đi qua cạnh bị chặn (seam với mask nhóm ngoài cửa sổ): không dùng được trong cửa sổ này. */
  blocked: boolean;
  overlap: number;
  threshold: number;
  valid: boolean;
  proximity: number;
  length: number;
  bounds: GeometryBounds;
}

/**
 * Diện tích ứng viên ∩ các mask đang hợp. Chỉ giao với hợp con của các mask có hộp bao giao hộp bao ứng viên
 * (cache theo danh sách mask): ứng viên thường nhỏ so với nhóm, nên mỗi lần rê không phải cắt cả vòng hợp lớn.
 */
function overlapArea(polygons: readonly AnnotationPolygon[], model: SceneModel, candidate: Point[], group: GroupBoundary): number {
  if (candidate.length < 3 || !group.union) return 0;
  const ring = candidate.map((point): GeometryPoint => [point.x, point.y]);
  const bounds = ringBounds(ring);
  if (!boundsOverlap(bounds, group.unionBounds)) return 0;
  const near = group.members.filter((member) => boundsOverlap(cachedPolygonBounds(polygons[member]), bounds));
  if (!near.length) return 0;
  let clip = group.union;
  if (near.length < group.members.length) {
    const key = near.join(',');
    if (!model.overlapUnions.has(key)) model.overlapUnions.set(key, unionOf(near.flatMap((member) => model.geometry[member] ?? [])));
    clip = model.overlapUnions.get(key) ?? group.union;
  }
  try {
    return multiPolygonArea(intersectionGeometries([ring], clip));
  } catch {
    return Infinity;
  }
}

/**
 * Chọn chiều: (0) chiều không đi qua cạnh bị chặn thắng; (1) chiều không chồng mask của nhóm thắng; (2) cả hai
 * cùng chồng thì chồng ít hơn thắng; (3) polygon hợp lệ (không tự cắt) thắng; (4) gần hình đang dựng hơn
 * (`pathDistanceToDraft`); (5) ngắn hơn.
 */
function compareEvaluations(a: Evaluation, b: Evaluation): number {
  if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
  const aClean = a.overlap <= a.threshold;
  const bClean = b.overlap <= b.threshold;
  if (aClean !== bClean) return aClean ? -1 : 1;
  if (!aClean && Math.abs(a.overlap - b.overlap) > Math.max(a.threshold, b.threshold)) return a.overlap - b.overlap;
  if (a.valid !== b.valid) return a.valid ? -1 : 1;
  if (Math.abs(a.proximity - b.proximity) > 1e-6) return a.proximity - b.proximity;
  return a.length - b.length;
}

export type CompletionFailure = 'NO_TARGET' | 'FROM_NOT_ON_FREE_BOUNDARY' | 'DISCONNECTED' | 'TARGET_OFF_RING' | 'NO_ROUTE';

export interface CompletionRequest {
  polygons: readonly AnnotationPolygon[];
  /** Điểm xuất phát đã neo (điểm nháp cuối, hoặc điểm kề của node đang kéo). */
  from: Point;
  /** Vị trí con trỏ; đích là điểm biên tự do gần nó nhất trên mask đích. */
  cursor: Point;
  /** Dung sai "gần" theo px ảnh (14 px màn hình / zoom). */
  tolerance: number;
  /** Hình đang dựng, dùng để chọn chiều (bản nháp, hoặc vòng polygon đang sửa). */
  context: Point[];
  /** Điểm đầu bản nháp: con trỏ gần nó thì đường khép về đúng điểm này. */
  closeTo?: Point;
  /** Ép mask đích (khi kéo điểm, đích đã được neo trước). */
  targetPolygonId?: string;
  /** Dung sai riêng cho điểm xuất phát (mặc định = tolerance). */
  fromTolerance?: number;
  /** Dựng polygon ứng viên cho một chiều từ các điểm của đường (không gồm `from`) và điểm đích (null khi khép). */
  candidate?: (arc: Point[], end: Point | null) => Point[];
  /**
   * Bỏ cửa sổ cục bộ và hợp cả nhóm ngay. Chỉ dùng để kiểm chứng (test so hai đường đi phải trùng nhau); canvas
   * luôn để mặc định vì trên dữ liệu thật hợp cả nhóm tốn hàng trăm ms mỗi lần mảng polygon đổi.
   */
  exhaustive?: boolean;
}

export interface CompletionRoute {
  /** Các điểm chèn sau `from`, theo thứ tự; kết thúc bằng điểm đích trừ khi khép về điểm đầu. */
  nodes: PolygonNode[];
  target: AnchorTarget;
  closesToStart: boolean;
  /** Id các mask mà đường thực sự đi dọc, theo thứ tự trong mảng polygon. */
  ownerIds: string[];
}

export type CompletionResult = { route: CompletionRoute } | { failure: CompletionFailure };

function topmostMaskAt(polygons: readonly AnnotationPolygon[], model: SceneModel, point: Point): number {
  for (let index = polygons.length - 1; index >= 0; index -= 1) {
    if (!model.valid[index]) continue;
    const bounds = cachedPolygonBounds(polygons[index]);
    if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) continue;
    if (pointInMask(point, polygons[index])) return index;
  }
  return -1;
}

/** Lề cửa sổ (px ảnh) quanh điểm xuất phát, con trỏ và hình đang dựng; cửa sổ được làm tròn ra lưới để cache trúng khi rê. */
const WINDOW_MARGIN = 64;
const WINDOW_GRID = 128;

function snapWindow(bounds: GeometryBounds): GeometryBounds {
  return {
    left: Math.floor(bounds.left / WINDOW_GRID) * WINDOW_GRID, top: Math.floor(bounds.top / WINDOW_GRID) * WINDOW_GRID,
    right: Math.ceil(bounds.right / WINDOW_GRID) * WINDOW_GRID, bottom: Math.ceil(bounds.bottom / WINDOW_GRID) * WINDOW_GRID,
  };
}

interface RouteContext {
  request: CompletionRequest;
  polygons: readonly AnnotationPolygon[];
  model: SceneModel;
  target: number;
  /** Mask chứa điểm xuất phát nằm ngoài nhóm đích (chỉ dùng để báo DISCONNECTED). */
  fromOutsideGroup: boolean;
  groupMembers: number[];
}

/** Kết quả trong một cửa sổ; `exact` = chắc chắn giống kết quả trên cả nhóm, `need` = vùng cần thêm nếu không. */
type WindowOutcome = { result: CompletionResult; exact: boolean; need?: GeometryBounds };

function routeWithin(context: RouteContext, group: GroupBoundary, windowed: boolean): WindowOutcome {
  const { request, polygons, target, groupMembers } = context;
  const { from, cursor, tolerance, closeTo } = request;
  const fromTolerance = request.fromTolerance ?? tolerance;
  const draft = request.context;

  // 3. Vòng biên tự do chứa điểm xuất phát. Biên cục bộ chứa mọi điểm của biên cả nhóm, nên không tìm thấy ở đây
  //    thì cả nhóm cũng không có (kết quả chính xác).
  let start: { ring: BoundaryRing; position: RingPosition } | null = null;
  for (const ring of group.rings) {
    const position = locateOnRing(ring, from);
    if (position && position.distance <= fromTolerance && (!start || position.distance < start.position.distance)) start = { ring, position };
  }
  if (!start) return { result: { failure: context.fromOutsideGroup ? 'DISCONNECTED' : 'FROM_NOT_ON_FREE_BOUNDARY' }, exact: true };
  const { ring } = start;
  // Vòng không có cạnh bị chặn là một vòng trọn vẹn của cả nhóm.
  const ringComplete = !ring.blocked.includes(1);
  const fromPosition = start.position;
  // Điểm xuất phát nằm trên cạnh bị chặn: trong cả nhóm đó có thể là seam.
  if (ring.blocked[fromPosition.segment]) return { result: { failure: 'FROM_NOT_ON_FREE_BOUNDARY' }, exact: false };
  const fromPoint = { x: fromPosition.x, y: fromPosition.y };

  // 4. Đích: khép về điểm đầu, hoặc điểm gần con trỏ nhất trên các cạnh thuộc mask đích.
  let closesToStart = false;
  let toPosition: RingPosition | null = null;
  let endPoint: Point | null = null;
  let anchorTarget: AnchorTarget | null = null;
  if (closeTo && hypot(cursor, closeTo) <= tolerance) {
    const position = locateOnRing(ring, closeTo);
    if (position && position.distance <= tolerance) {
      closesToStart = true;
      toPosition = position;
      const owner = ring.owners[position.segment];
      anchorTarget = { polygonId: polygons[owner >= 0 ? owner : target].id, ring: -1, edgeIndex: -1, point: { ...closeTo } };
    }
  }
  if (!closesToStart) {
    toPosition = locateOnRing(ring, cursor, (segment) => ring.owners[segment] === target);
    if (!toPosition) return { result: { failure: 'TARGET_OFF_RING' }, exact: ringComplete };
    // Đặt đích đúng trên biên gốc của mask đích (bản hợp có thể lệch ≤ TOUCH do khép khe hở).
    const onMask = nearestBoundaryTarget(polygons[target], { x: toPosition.x, y: toPosition.y });
    if (!onMask || onMask.distance > TOUCH_TOLERANCE) return { result: { failure: 'TARGET_OFF_RING' }, exact: ringComplete };
    const snapped = onMask.target.vertexId ? onMask.target : withVertex(polygons[target], onMask.target, 0.5);
    anchorTarget = snapped;
    endPoint = snapped.point;
  }
  const finalTo = toPosition!;
  if (ring.blocked[finalTo.segment]) return { result: { failure: 'TARGET_OFF_RING' }, exact: false };
  if (hypot(fromPoint, closesToStart ? closeTo! : endPoint!) < 0.5) return { result: { failure: 'NO_ROUTE' }, exact: true };

  // 5–6. Hai chiều đi quanh vòng, chọn theo compareEvaluations.
  const endForDistance = closesToStart ? closeTo! : endPoint!;
  const buildCandidate = request.candidate
    ?? ((arc: Point[], end: Point | null) => [...draft, ...arc, ...(end ? [end] : [])]);
  const evaluations = ([1, -1] as const).map((direction): Evaluation => {
    const blocked = arcSegments(ring, fromPosition, finalTo, direction).some((segment) => ring.blocked[segment]);
    const arc = arcVertices(ring, fromPosition, finalTo, direction)
      .filter((point) => hypot(point, fromPoint) >= ENDPOINT_GAP && hypot(point, endForDistance) >= ENDPOINT_GAP);
    const candidate = buildCandidate(arc, endPoint);
    const area = candidate.length >= 3 ? Math.abs(polygonArea(candidate)) : 0;
    return {
      arc,
      direction,
      blocked,
      // Polygon tự cắt có thể có diện tích shoelace ≈ 0 nhưng vẫn bao mask, nên luôn đo phần chồng thật.
      overlap: blocked ? Infinity : overlapArea(polygons, context.model, candidate, group),
      threshold: Math.max(1, area * 0.005),
      valid: candidate.length >= 3 && normalizeRing(candidate) !== null,
      proximity: draft.length >= 2 ? pathDistanceToDraft(arc, endForDistance, fromPoint, draft) : 0,
      length: pathLength([fromPoint, ...arc, endForDistance]),
      bounds: pointBounds([fromPoint, ...candidate]),
    };
  });
  evaluations.sort(compareEvaluations);
  const chosen = evaluations[0];

  let exact = true;
  let need: GeometryBounds | undefined;
  if (windowed) {
    // Chiều được chọn phải đi trọn trên biên tự do thật. Chiều kia bị chặn thì trên cả nhóm nó phải vòng qua các
    // mask ngoài cửa sổ; khi mọi mask giao hộp bao ứng viên đã được hợp (kiểm tra dưới), ứng viên của chiều đó bao
    // trọn các mask ngoài cửa sổ nên không thể chồng ít hơn chiều đã chọn: bỏ qua được.
    if (chosen.blocked) exact = false;
    // Phần chồng chỉ chính xác khi mọi mask của nhóm giao hộp bao ứng viên đều đã được hợp.
    for (const evaluation of evaluations) {
      if (evaluation.blocked) continue;
      const bounds = expandBounds(evaluation.bounds, TOUCH_TOLERANCE);
      const missing = groupMembers.some((member) => !group.memberSet.has(member) && boundsOverlap(cachedPolygonBounds(polygons[member]), bounds));
      if (missing) {
        exact = false;
        need = need ? mergeBounds(need, bounds) : bounds;
      }
    }
  }
  if (chosen.blocked) return { result: { failure: 'NO_ROUTE' }, exact, need };

  const rounded = (point: Point) => ({ x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 });
  const nodes: PolygonNode[] = [...chosen.arc, ...(endPoint ? [endPoint] : [])]
    .map((point) => ({ id: createId(), ...rounded(point), isAnchor: true }));
  const owners = new Set<number>();
  for (const segment of arcSegments(ring, fromPosition, finalTo, chosen.direction)) {
    if (ring.owners[segment] >= 0) owners.add(ring.owners[segment]);
  }
  return {
    result: {
      route: {
        nodes,
        target: anchorTarget!,
        closesToStart,
        ownerIds: [...owners].sort((a, b) => a - b).map((index) => polygons[index].id),
      },
    },
    exact,
    need,
  };
}

/**
 * TỰ HOÀN THIỆN: đường dọc biên tự do của nhóm mask đích, từ `from` tới điểm biên gần con trỏ nhất.
 *
 * Hiệu năng (2026-11-13, prelabel thật: cả quả là MỘT nhóm ~130 mảnh, hợp cả nhóm ~200 ms Node / ~1 s trình duyệt
 * mỗi lần mảng polygon đổi): chỉ hợp các mask của nhóm giao một cửa sổ quanh điểm xuất phát, con trỏ và hình đang
 * dựng. Cạnh của vòng cục bộ chạm mask nhóm ngoài cửa sổ bị chặn. Kết quả cửa sổ được nhận khi chắc chắn giống kết
 * quả cả nhóm (routeWithin `exact`); không thì nới cửa sổ một lần, rồi dùng cả nhóm.
 */
export function findCompletionRoute(request: CompletionRequest): CompletionResult {
  const { polygons, from, cursor, tolerance, context, closeTo, targetPolygonId } = request;
  const fromTolerance = request.fromTolerance ?? tolerance;
  if (!polygons.length) return { failure: 'NO_TARGET' };
  const model = sceneModel(polygons);

  // 1. Mask đích.
  let target = targetPolygonId ? polygons.findIndex((polygon) => polygon.id === targetPolygonId) : topmostMaskAt(polygons, model, cursor);
  if (target < 0) {
    const anchor = findAnchorTarget(polygons, cursor, tolerance, { context });
    target = anchor ? polygons.findIndex((polygon) => polygon.id === anchor.polygonId) : -1;
  }
  if (target < 0 || !model.valid[target]) return { failure: 'NO_TARGET' };

  // 2. Nhóm của mask đích; mask chứa điểm xuất phát phải cùng nhóm (không nối qua khoảng trống).
  const groupIndex = groupIndexOf(polygons, model, target);
  const groupMembers = model.groupMembers[groupIndex];
  const fromAnchor = findAnchorTarget(polygons, from, Math.max(fromTolerance, TOUCH_TOLERANCE), { context });
  const fromMask = fromAnchor ? polygons.findIndex((polygon) => polygon.id === fromAnchor.polygonId) : -1;
  const routeContext: RouteContext = {
    request, polygons, model, target, groupMembers,
    fromOutsideGroup: fromMask >= 0 && model.groupOf[fromMask] !== groupIndex,
  };

  const margin = Math.max(WINDOW_MARGIN, tolerance * 2);
  let window: GeometryBounds | null = request.exhaustive
    ? null
    : snapWindow(expandBounds(pointBounds([from, cursor, ...(closeTo ? [closeTo] : []), ...context]), margin));
  for (let attempt = 0; ; attempt += 1) {
    let members = groupMembers;
    if (window) {
      const area = window;
      members = groupMembers.filter((member) => member === target || boundsOverlap(cachedPolygonBounds(polygons[member]), area));
      if (members.length === groupMembers.length) window = null;
    }
    const outcome = routeWithin(routeContext, groupBoundary(polygons, model, window ? members : groupMembers, groupMembers), Boolean(window));
    if (!window || outcome.exact) return outcome.result;
    window = attempt === 0 ? snapWindow(expandBounds(outcome.need ? mergeBounds(window, outcome.need) : window, margin * 4)) : null;
  }
}
