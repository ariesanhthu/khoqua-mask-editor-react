import type { AnnotationPolygon, AnnotationPolygonMeta, PolygonNode } from '@/types';
import {
  boundsOverlap,
  cachedPolygonBounds,
  createId,
  differenceGeometries,
  indexSourceVertices,
  intersectionGeometries,
  multiPolygonArea,
  maskClipGeometry,
  normalizeRing,
  polygonRings,
  projectOntoSegment,
  restoreSourceVertices,
  ringArea,
  ringBounds,
  segmentsIntersect,
  unionClipInputs,
  type GeometryBounds,
  type GeometryMultiPolygon,
  type GeometryPoint,
  type GeometryPolygon,
  type GeometryRing,
} from './geometry-primitives';
import { TOUCH_TOLERANCE } from './mask-anchor';
import { applyLineCut, type CutSegment, type PendingCuts } from './mask-cut';

/**
 * Paint (công cụ B) nối (+) / trừ (−) bằng polygon — người dùng xác nhận 2026-11-12. Thay cho tô pixel rồi vector
 * hóa lại (cách cũ làm các mask chạm nhau bị gộp thành một). Chỉ những mask polygon chạm/chồng mới đổi:
 *
 * - add: hợp vào MỘT mask đích (đang chọn, không thì mask bị chồng nhiều nhất, chỉ chạm thì mask lớn nhất). Phần
 *   polygon chồng lên các mask khác (kể cả mask khóa) bị cắt bỏ nên chúng giữ nguyên. Không chạm mask nào thì tạo
 *   mask mới. Mảnh chỉ chạm đích tại một điểm thành polygon riêng cùng nhãn.
 * - subtract: trừ khỏi mọi mask không khóa bị chồng; trừ ở giữa thành lỗ, cắt đôi thì mảnh lớn giữ id.
 *
 * Hàm thuần: trả mảng mới (thứ tự polygon giữ nguyên) hoặc `error` và không đổi gì.
 */

export type PaintMode = 'add' | 'subtract';

export interface PaintOptions {
  selectedIds?: ReadonlySet<string>;
  /** Nhãn/meta cho mask mới khi polygon (+) không chạm mask nào. */
  newRegion: { label: string; meta?: AnnotationPolygonMeta };
  bounds: { width: number; height: number };
  /** Đường cắt chờ của phiên (chỉ dùng cho đường cắt 2 điểm ở chế độ trừ), xem mask-cut.ts. */
  pendingCuts?: PendingCuts;
  /** Dung sai "gần" theo px ảnh cho đầu mút đường cắt (canvas truyền theo zoom). */
  tolerance?: number;
}

export type PaintResult =
  | { polygons: AnnotationPolygon[]; resultIds: string[]; message: string; pendingCuts?: Map<string, CutSegment[]> }
  | { error: string };

const AREA_EPSILON = 0.01;

type Point = { x: number; y: number };

interface Candidate {
  index: number;
  polygon: AnnotationPolygon;
  /** Hình học clipping (đã sửa nếu mask tự chạm/tự cắt, xem maskClipGeometry). */
  geometry: GeometryMultiPolygon;
  overlap: number;
  touches: boolean;
}

const expand = (bounds: GeometryBounds, margin: number): GeometryBounds => ({
  left: bounds.left - margin, right: bounds.right + margin, top: bounds.top - margin, bottom: bounds.bottom + margin,
});

/** Hai biên cách nhau ≤ tolerance (trùng cạnh/trùng điểm/khe hở nhỏ) hoặc cắt nhau. */
function boundariesWithin(ring: GeometryRing, polygon: AnnotationPolygon, tolerance: number): boolean {
  const points = ring.map(([x, y]) => ({ x, y }));
  for (const other of polygonRings(polygon)) {
    for (let i = 0; i < other.length; i += 1) {
      const a = other[i];
      const b = other[(i + 1) % other.length];
      for (let j = 0; j < points.length; j += 1) {
        const c = points[j];
        const d = points[(j + 1) % points.length];
        if (projectOntoSegment(c, a, b).distance <= tolerance || projectOntoSegment(a, c, d).distance <= tolerance) return true;
        if (segmentsIntersect([a.x, a.y], [b.x, b.y], [c.x, c.y], [d.x, d.y])) return true;
      }
    }
  }
  return false;
}

/** Tách kết quả clipping thành các polygon (vòng ngoài + lỗ), gắn lại đỉnh gốc từ `sources`. */
function toShapes(geometry: GeometryMultiPolygon, sourceRings: PolygonNode[][]) {
  // Chỉ mục đỉnh gốc dựng một lần cho mọi vòng (kết quả trên mask lớn có thể có rất nhiều lỗ).
  const sources = indexSourceVertices(sourceRings);
  return geometry.flatMap((component) => {
    const rings = component.map((item) => normalizeRing(item));
    if (rings.some((item) => !item)) throw new Error('Invalid clipping result');
    const [outer, ...holes] = rings as GeometryRing[];
    const shapeArea = Math.abs(ringArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0);
    if (shapeArea < AREA_EPSILON) return [];
    // Id chỉ được tạo cho đỉnh mới; đỉnh trùng đỉnh gốc giữ nguyên id (restoreSourceVertices).
    const toNodes = (item: GeometryRing) => restoreSourceVertices(item.map(([x, y]) => ({ x, y })), sources);
    return [{
      geometry: component,
      area: shapeArea,
      nodes: toNodes(outer),
      ...(holes.length ? { holes: holes.map(toNodes) } : {}),
    }];
  });
}

/** Kéo các đỉnh cách biên `target` ≤ TOUCH lên biên đó để seam tan khi hợp. Không hợp lệ thì giữ nguyên. */
function snapRingTo(ring: GeometryRing, target: AnnotationPolygon): GeometryRing {
  const moved = ring.map(([x, y]): GeometryPoint => {
    let best: { x: number; y: number; distance: number } | null = null;
    for (const other of polygonRings(target)) {
      for (let index = 0; index < other.length; index += 1) {
        const hit = projectOntoSegment({ x, y }, other[index], other[(index + 1) % other.length]);
        if (hit.distance <= TOUCH_TOLERANCE && (!best || hit.distance < best.distance)) best = hit;
      }
    }
    return best ? [best.x, best.y] : [x, y];
  });
  return normalizeRing(moved) ?? ring;
}

function clip(operation: () => GeometryMultiPolygon): GeometryMultiPolygon | null {
  try {
    return operation();
  } catch {
    return null;
  }
}

export function applyPolygonPaint(
  polygons: AnnotationPolygon[],
  ring: Point[],
  mode: PaintMode,
  options: PaintOptions,
): PaintResult {
  // Paint (−) với ĐÚNG 2 điểm = đường cắt TÁCH mask (người dùng xác nhận 2026-11-16): đường đi qua mask (hai
  // điểm trên/ngoài biên) thì mask được tách làm hai tại đúng hai giao điểm, mỗi mảnh nhận thêm điểm tại đó.
  if (mode === 'subtract' && ring.length === 2) return cutWithLine(polygons, ring, options);
  const drawnRing = normalizeRing(ring);
  if (!drawnRing) return { error: 'Polygon vẽ bị tự cắt hoặc quá nhỏ. Hãy vẽ lại.' };
  const { width, height } = options.bounds;
  const imageRect: GeometryPolygon = [[[0, 0], [width, 0], [width, height], [0, height]]];
  const drawn = clip(() => intersectionGeometries([drawnRing], imageRect));
  if (!drawn || multiPolygonArea(drawn) < AREA_EPSILON) return { error: 'Polygon nằm ngoài ảnh.' };
  const drawnBounds = expand(ringBounds(drawnRing), TOUCH_TOLERANCE);
  const drawnNodes = drawnRing.map(([x, y]) => ({ id: createId(), x, y, isAnchor: true }));

  const nearby: Candidate[] = [];
  for (let index = 0; index < polygons.length; index += 1) {
    const polygon = polygons[index];
    if (polygon.nodes.length < 3 || !boundsOverlap(cachedPolygonBounds(polygon), drawnBounds)) continue;
    // Mask tự chạm/tự cắt (≈26 % polygon prelabel thật) dùng hình học đã sửa thay vì chặn cả thao tác: trước
    // 2026-11-16 một mask như vậy nằm gần vùng vẽ là Paint báo "biên không hợp lệ" và bản nháp không bao giờ áp
    // dụng được (đo: 52 % lần trừ trên drive/prelabel-production bị từ chối). Mask không có diện tích thì bỏ qua.
    const geometry = maskClipGeometry(polygon);
    if (!geometry) continue;
    const overlapGeometry = clip(() => intersectionGeometries(drawn, geometry));
    if (!overlapGeometry) return { error: 'Không xử lý được polygon này. Hãy vẽ lại đơn giản hơn.' };
    const overlap = multiPolygonArea(overlapGeometry);
    nearby.push({ index, polygon, geometry, overlap, touches: overlap > AREA_EPSILON || boundariesWithin(drawnRing, polygon, TOUCH_TOLERANCE) });
  }

  return mode === 'subtract'
    ? subtract(polygons, drawn, drawnNodes, nearby)
    : add(polygons, drawnRing, drawnNodes, imageRect, nearby, options);
}

/**
 * Đường cắt 2 điểm trong Paint (−): giao cho `mask-cut.applyLineCut` (đồ thị đường cắt + đường chờ). Đường chưa
 * chia được mask trả về NGUYÊN mảng polygon (không ID mới) kèm bản đồ đường chờ mới.
 */
function cutWithLine(polygons: AnnotationPolygon[], line: Point[], options: PaintOptions): PaintResult {
  const outcome = applyLineCut(polygons, { a: line[0], b: line[1] }, {
    selectedIds: options.selectedIds, pending: options.pendingCuts, tolerance: options.tolerance,
  });
  if (outcome.kind === 'error') return { error: outcome.error };
  if (outcome.kind === 'pending') return { polygons, resultIds: [], message: outcome.message, pendingCuts: outcome.pending };
  return { polygons: outcome.polygons, resultIds: outcome.resultIds, message: outcome.message, pendingCuts: outcome.pending };
}

function subtract(polygons: AnnotationPolygon[], drawn: GeometryMultiPolygon, drawnNodes: PolygonNode[], nearby: Candidate[]): PaintResult {
  const affected = new Map(nearby
    .filter((item) => !item.polygon.meta?.locked && item.overlap > AREA_EPSILON)
    .map((item) => [item.index, item]));
  if (!affected.size) return { error: 'Polygon trừ chưa chồng lên mask nào (không khóa).' };
  const next: AnnotationPolygon[] = [];
  const resultIds: string[] = [];
  let removed = 0;
  for (let index = 0; index < polygons.length; index += 1) {
    const item = affected.get(index);
    if (!item) { next.push(polygons[index]); continue; }
    const rest = clip(() => differenceGeometries(item.geometry, drawn));
    if (!rest) return { error: 'Không xử lý được polygon này. Hãy vẽ lại đơn giản hơn.' };
    let shapes;
    try { shapes = toShapes(rest, [...polygonRings(item.polygon), drawnNodes]); } catch { return { error: 'Kết quả trừ không hợp lệ. Hãy vẽ lại.' }; }
    if (!shapes.length) { removed += 1; continue; }
    shapes.sort((a, b) => b.area - a.area);
    shapes.forEach((shape, order) => {
      const { holes, nodes } = shape;
      const created: AnnotationPolygon = order === 0
        ? { ...item.polygon, nodes, holes, meta: { ...item.polygon.meta, source: 'human' } }
        : { id: createId(), label: item.polygon.label, nodes, ...(holes ? { holes } : {}), meta: { ...item.polygon.meta, source: 'human' } };
      if (!holes) delete created.holes;
      next.push(created);
      resultIds.push(created.id);
    });
  }
  const message = removed
    ? `Đã trừ khỏi ${affected.size} mask (${removed} mask bị xóa hết).`
    : `Đã trừ khỏi ${affected.size} mask.`;
  return { polygons: next, resultIds, message };
}

function add(
  polygons: AnnotationPolygon[],
  drawnRing: GeometryRing,
  drawnNodes: PolygonNode[],
  imageRect: GeometryPolygon,
  nearby: Candidate[],
  options: PaintOptions,
): PaintResult {
  const candidates = nearby.filter((item) => !item.polygon.meta?.locked && item.touches);
  const byOverlap = (a: Candidate, b: Candidate) => (Math.abs(b.overlap - a.overlap) > AREA_EPSILON
    ? b.overlap - a.overlap
    : multiPolygonArea(b.geometry) - multiPolygonArea(a.geometry));
  const selected = candidates.filter((item) => options.selectedIds?.has(item.polygon.id)).sort(byOverlap);
  const target = selected[0] ?? [...candidates].sort(byOverlap)[0];

  const subject = target ? snapRingTo(drawnRing, target.polygon) : drawnRing;
  const drawn = clip(() => intersectionGeometries([subject], imageRect));
  const others = nearby.filter((item) => item !== target).map((item) => item.geometry);
  const piece = drawn && (others.length ? clip(() => differenceGeometries(drawn, unionClipInputs(others))) : drawn);
  if (!piece) return { error: 'Không xử lý được polygon này. Hãy vẽ lại đơn giản hơn.' };
  const sources = [drawnNodes, ...nearby.flatMap((item) => polygonRings(item.polygon))];

  if (!target) {
    let shapes;
    try { shapes = toShapes(piece, sources); } catch { return { error: 'Kết quả nối không hợp lệ. Hãy vẽ lại.' }; }
    if (!shapes.length) return { error: 'Vùng vẽ đã nằm trọn trong các mask khác.' };
    const created = shapes.map(({ nodes, holes }): AnnotationPolygon => ({
      id: createId(), label: options.newRegion.label, nodes, ...(holes ? { holes } : {}),
      ...(options.newRegion.meta ? { meta: { ...options.newRegion.meta } } : {}),
    }));
    return { polygons: [...polygons, ...created], resultIds: created.map((item) => item.id), message: `Đã tạo mask ${options.newRegion.label}.` };
  }

  const merged = clip(() => unionClipInputs([target.geometry, piece]));
  if (!merged) return { error: 'Không xử lý được polygon này. Hãy vẽ lại đơn giản hơn.' };
  if (multiPolygonArea(merged) - multiPolygonArea(target.geometry) < AREA_EPSILON) {
    return { error: `Vùng vẽ đã nằm trong mask ${target.polygon.label}, không có gì để nối.` };
  }
  let shapes;
  try { shapes = toShapes(merged, sources); } catch { return { error: 'Kết quả nối không hợp lệ. Hãy vẽ lại.' }; }
  // Mảnh chứa mask đích giữ id; mảnh còn lại (chỉ chạm tại một điểm) là polygon riêng cùng nhãn.
  const overlapWithTarget = (geometry: GeometryPolygon) => {
    const shared = clip(() => intersectionGeometries([geometry], target.geometry));
    return shared ? multiPolygonArea(shared) : 0;
  };
  const ranked = shapes.map((shape) => ({ shape, overlap: overlapWithTarget(shape.geometry) })).sort((a, b) => b.overlap - a.overlap);
  const meta = { ...target.polygon.meta, source: 'human' as const };
  const created = ranked.map(({ shape }, order): AnnotationPolygon => {
    const base = order === 0 ? { ...target.polygon } : { id: createId(), label: target.polygon.label };
    const result: AnnotationPolygon = { ...base, nodes: shape.nodes, meta };
    if (shape.holes) result.holes = shape.holes; else delete result.holes;
    return result;
  });
  const next = polygons.flatMap((polygon, index) => (index === target.index ? created : [polygon]));
  return { polygons: next, resultIds: created.map((item) => item.id), message: `Đã nối vào mask ${target.polygon.label}.` };
}
