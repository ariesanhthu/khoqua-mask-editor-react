import type { AnnotationPolygon, PolygonNode } from '@/types';
import { cachedPolygonBounds, pointInMask, polygonArea, polygonRings, projectOntoSegment } from './geometry-primitives';
import { segmentIntersection, splitPolygonWithCut } from './polygon-geometry';

/**
 * TÁCH MASK BẰNG ĐƯỜNG CẮT trong Paint (−) — spec người dùng 2026-11-16 (Rule 2–5):
 *
 * - Đường 2 điểm có hai đầu trên biên chia mask làm hai mask độc lập, KHÔNG mất diện tích: đường cắt là biên chung,
 *   mỗi mảnh có đỉnh riêng cùng tọa độ tại hai giao điểm (lõi `splitPolygonWithCut`, dùng chung với công cụ cắt).
 * - Chỉ cấp ID mới khi mask THỰC SỰ bị chia: quyết định theo cấu trúc liên thông, không theo số đường cắt. Đường
 *   chưa chia được mask (kết thúc giữa mask) được giữ làm ĐƯỜNG CHỜ của phiên; mỗi đường mới được đánh giá cùng
 *   toàn bộ đường chờ trên một đồ thị: đỉnh = giao với biên, giao giữa các đường, đầu mút; cạnh = đoạn nằm trong
 *   mask. Có đường đi nối hai đỉnh biên khác nhau ⇔ có ranh giới phân tách hoàn chỉnh → tách dọc đường đó, các đỉnh
 *   trên đường thành đỉnh biên của hai mảnh rồi lặp lại (nên hai đường chéo nhau cho 4 mảnh, đường qua mask lõm cho
 *   3+ mảnh).
 * - Mảnh lớn nhất giữ ID gốc, các mảnh còn lại nhận ID mới từ cơ chế sẵn có (`createId` trong lõi tách); nhãn/meta
 *   giữ nguyên. Mask khác không bị đụng (cùng tham chiếu đối tượng).
 *
 * Giới hạn (báo rõ thay vì làm tạm): mô hình dữ liệu polygon không biểu diễn được khe hở rộng 0, nên đường chờ chỉ
 * sống trong phiên chỉnh sửa (không lưu); đường cắt chạm một LỖ của mask bị từ chối vì lõi tách chưa xử lý vòng lỗ.
 *
 * Hàm thuần: trả mảng polygon mới + bản đồ đường chờ mới, không sửa đầu vào.
 */

export type CutPoint = { x: number; y: number };
export interface CutSegment { a: CutPoint; b: CutPoint }
export type PendingCuts = ReadonlyMap<string, CutSegment[]>;

export interface LineCutOptions {
  selectedIds?: ReadonlySet<string>;
  /** Đường chờ của phiên, khóa theo id mask. */
  pending?: PendingCuts;
  /** Dung sai "gần" theo px ảnh (canvas truyền theo zoom): đầu mút lệch trong tầm này được đưa về đúng biên/đường chờ. */
  tolerance?: number;
}

export type LineCutResult =
  | { kind: 'split'; polygons: AnnotationPolygon[]; resultIds: string[]; pending: Map<string, CutSegment[]>; message: string }
  | { kind: 'pending'; polygonId: string; pending: Map<string, CutSegment[]>; message: string }
  | { kind: 'error'; error: string };

/** Hai điểm coi là một khi lệch dưới mức này (sai số dấu phẩy động của phép giao, không phải dung sai người dùng). */
const SAME_POINT = 1e-4;

const distance = (a: CutPoint, b: CutPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (segment: CutSegment, t: number): CutPoint => ({
  x: segment.a.x + (segment.b.x - segment.a.x) * t,
  y: segment.a.y + (segment.b.y - segment.a.y) * t,
});

interface Breakpoint { t: number; point: CutPoint; boundary: boolean; hole: boolean }

/** Giao của một đoạn với mọi vòng của mask: vòng ngoài là đỉnh BIÊN, vòng lỗ được đánh dấu riêng. */
function ringBreakpoints(polygon: AnnotationPolygon, segment: CutSegment): Breakpoint[] {
  const result: Breakpoint[] = [];
  polygonRings(polygon).forEach((ring, ringIndex) => {
    for (let index = 0; index < ring.length; index += 1) {
      const hit = segmentIntersection(ring[index], ring[(index + 1) % ring.length], segment.a, segment.b);
      if (!hit) continue;
      result.push({ t: Math.min(1, Math.max(0, hit.cutT)), point: { x: hit.x, y: hit.y }, boundary: ringIndex === 0, hole: ringIndex > 0 });
    }
  });
  return result;
}

/** Tổng độ dài phần đoạn thẳng nằm trong mask (để chọn mask đích khi đường đi qua nhiều mask). */
function insideLength(polygon: AnnotationPolygon, segment: CutSegment): number {
  const stops = [0, 1, ...ringBreakpoints(polygon, segment).map((item) => item.t)].sort((a, b) => a - b);
  let total = 0;
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index] - stops[index - 1] <= 0) continue;
    const middle = lerp(segment, (stops[index] + stops[index - 1]) / 2);
    if (pointInMask(middle, polygon)) total += distance(lerp(segment, stops[index - 1]), lerp(segment, stops[index]));
  }
  return total;
}

function nearestOnBoundary(polygon: AnnotationPolygon, point: CutPoint): { point: CutPoint; distance: number } | null {
  let best: { point: CutPoint; distance: number } | null = null;
  const ring = polygon.nodes;
  for (let index = 0; index < ring.length; index += 1) {
    const hit = projectOntoSegment(point, ring[index], ring[(index + 1) % ring.length]);
    if (!best || hit.distance < best.distance) best = { point: { x: hit.x, y: hit.y }, distance: hit.distance };
  }
  return best;
}

/**
 * Đưa đầu mút của đường mới về đúng chỗ người dùng nhắm tới, trong `tolerance`: đầu mút đường chờ, điểm trên thân
 * đường chờ, hoặc điểm trên biên mask — lấy cái gần nhất. Đầu mút đã nằm ngoài mask thì giữ nguyên (đường sẽ cắt
 * qua biên).
 */
function settleEndpoint(polygon: AnnotationPolygon, point: CutPoint, others: CutSegment[], tolerance: number): CutPoint {
  if (tolerance <= 0) return point;
  let best: { point: CutPoint; distance: number } | null = null;
  const consider = (candidate: CutPoint, gap: number) => {
    if (gap <= tolerance && (!best || gap < best.distance)) best = { point: candidate, distance: gap };
  };
  for (const other of others) {
    consider(other.a, distance(point, other.a));
    consider(other.b, distance(point, other.b));
    const hit = projectOntoSegment(point, other.a, other.b);
    consider({ x: hit.x, y: hit.y }, hit.distance);
  }
  if (pointInMask(point, polygon)) {
    const boundary = nearestOnBoundary(polygon, point);
    if (boundary) consider(boundary.point, boundary.distance);
  }
  return (best as { point: CutPoint; distance: number } | null)?.point ?? point;
}

interface GraphNode { point: CutPoint; boundary: boolean; hole: boolean }
interface GraphEdge { from: number; to: number; used: boolean }

/** Đồ thị đường cắt của một mask: các đoạn nằm trong mask giữa những điểm dừng liên tiếp trên từng đường. */
function buildGraph(polygon: AnnotationPolygon, segments: CutSegment[]) {
  const nodes: GraphNode[] = [];
  const nodeAt = (point: CutPoint, boundary: boolean, hole: boolean) => {
    const found = nodes.findIndex((node) => distance(node.point, point) <= SAME_POINT);
    if (found >= 0) {
      nodes[found].boundary = nodes[found].boundary || boundary;
      nodes[found].hole = nodes[found].hole || hole;
      return found;
    }
    nodes.push({ point, boundary, hole });
    return nodes.length - 1;
  };
  const edges: GraphEdge[] = [];
  segments.forEach((segment, segmentIndex) => {
    const stops: Breakpoint[] = [
      { t: 0, point: segment.a, boundary: false, hole: false },
      { t: 1, point: segment.b, boundary: false, hole: false },
      ...ringBreakpoints(polygon, segment),
    ];
    segments.forEach((other, otherIndex) => {
      if (otherIndex === segmentIndex) return;
      const hit = segmentIntersection(other.a, other.b, segment.a, segment.b);
      if (hit) stops.push({ t: Math.min(1, Math.max(0, hit.cutT)), point: { x: hit.x, y: hit.y }, boundary: false, hole: false });
    });
    stops.sort((a, b) => a.t - b.t);
    // Các điểm dừng trùng nhau (đầu mút nằm đúng trên biên) gộp thành một đỉnh, giữ cờ biên/lỗ.
    const merged: Breakpoint[] = [];
    for (const stop of stops) {
      const last = merged[merged.length - 1];
      if (last && distance(last.point, stop.point) <= SAME_POINT) {
        last.boundary = last.boundary || stop.boundary;
        last.hole = last.hole || stop.hole;
        if (stop.boundary || stop.hole) last.point = stop.point;
      } else {
        merged.push({ ...stop });
      }
    }
    for (let index = 1; index < merged.length; index += 1) {
      const start = merged[index - 1];
      const end = merged[index];
      const middle = { x: (start.point.x + end.point.x) / 2, y: (start.point.y + end.point.y) / 2 };
      if (!pointInMask(middle, polygon)) continue;
      const from = nodeAt(start.point, start.boundary, start.hole);
      const to = nodeAt(end.point, end.boundary, end.hole);
      if (from !== to && !edges.some((edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from))) {
        edges.push({ from, to, used: false });
      }
    }
  });
  return { nodes, edges };
}

/** Đường đi ngắn nhất (theo số cạnh) nối hai đỉnh biên khác nhau qua các cạnh chưa dùng. */
function findSeparatingPath(nodes: GraphNode[], edges: GraphEdge[]): number[] | null {
  let best = null as number[] | null;
  nodes.forEach((start, startIndex) => {
    if (!start.boundary) return;
    const previous = new Map<number, number>([[startIndex, -1]]);
    const queue = [startIndex];
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      if (current !== startIndex && nodes[current].boundary) {
        const path: number[] = [];
        for (let step = current; step !== -1; step = previous.get(step)!) path.push(step);
        if (!best || path.length < best.length) best = path;
        return;
      }
      for (const edge of edges) {
        if (edge.used) continue;
        const next = edge.from === current ? edge.to : edge.to === current ? edge.from : -1;
        if (next < 0 || previous.has(next)) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
  });
  return best;
}

const maskArea = (polygon: AnnotationPolygon) => Math.abs(polygonArea(polygon.nodes))
  - (polygon.holes ?? []).reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);

/**
 * Áp một đường cắt 2 điểm lên mask đích (mask duy nhất đang chọn trong số bị cắt, không thì mask mà đường nằm trong
 * nhiều nhất), cùng toàn bộ đường chờ của mask đó.
 */
export function applyLineCut(polygons: AnnotationPolygon[], line: CutSegment, options: LineCutOptions = {}): LineCutResult {
  const tolerance = options.tolerance ?? 0;
  const lineBounds = {
    left: Math.min(line.a.x, line.b.x) - tolerance, right: Math.max(line.a.x, line.b.x) + tolerance,
    top: Math.min(line.a.y, line.b.y) - tolerance, bottom: Math.max(line.a.y, line.b.y) + tolerance,
  };
  let candidates = polygons
    .filter((polygon) => {
      if (polygon.meta?.locked || polygon.nodes.length < 3) return false;
      const bounds = cachedPolygonBounds(polygon);
      return bounds.left <= lineBounds.right && bounds.right >= lineBounds.left && bounds.top <= lineBounds.bottom && bounds.bottom >= lineBounds.top;
    })
    .map((polygon) => ({ polygon, inside: insideLength(polygon, line) }))
    .filter((item) => item.inside > SAME_POINT);
  if (!candidates.length) return { kind: 'error', error: 'Đường cắt chưa đi qua mask nào (không khóa).' };
  const selected = candidates.filter((item) => options.selectedIds?.has(item.polygon.id));
  if (selected.length) candidates = selected;
  const target = candidates.reduce((best, item) => (item.inside > best.inside ? item : best)).polygon;

  const waiting = options.pending?.get(target.id) ?? [];
  const settled: CutSegment = {
    a: settleEndpoint(target, line.a, waiting, tolerance),
    b: settleEndpoint(target, line.b, waiting, tolerance),
  };
  if (distance(settled.a, settled.b) <= SAME_POINT) return { kind: 'error', error: 'Đường cắt quá ngắn.' };
  const segments = [...waiting, settled];
  const { nodes, edges } = buildGraph(target, segments);
  if (!edges.length) return { kind: 'error', error: 'Đường cắt chưa đi qua mask nào (không khóa).' };
  if (nodes.some((node) => node.hole)) {
    return { kind: 'error', error: 'Đường cắt đi qua một lỗ của mask. Hãy cắt tránh lỗ, hoặc vẽ polygon trừ (−) kín.' };
  }

  // Tách lặp: mỗi đường đi nối hai đỉnh biên chia một mảnh làm hai; các đỉnh trên đường thành đỉnh biên của hai mảnh.
  let pieces: AnnotationPolygon[] = [target];
  let failure: string | undefined;
  for (let guard = 0; guard <= edges.length; guard += 1) {
    const path = findSeparatingPath(nodes, edges);
    if (!path) break;
    const cutPath: PolygonNode[] = path.map((index) => ({ id: crypto.randomUUID(), x: nodes[index].point.x, y: nodes[index].point.y }));
    const probe = { x: (cutPath[0].x + cutPath[1].x) / 2, y: (cutPath[0].y + cutPath[1].y) / 2 };
    const ordered = [...pieces].sort((a, b) => Number(pointInMask(probe, b)) - Number(pointInMask(probe, a)));
    let done = false;
    for (const piece of ordered) {
      const outcome = splitPolygonWithCut(piece, cutPath);
      if (!outcome.polygons) { failure = outcome.error; continue; }
      pieces = pieces.flatMap((item) => (item === piece ? outcome.polygons! : [item]));
      done = true;
      break;
    }
    for (let index = 1; index < path.length; index += 1) {
      const edge = edges.find((item) => (item.from === path[index - 1] && item.to === path[index]) || (item.to === path[index - 1] && item.from === path[index]));
      if (edge) edge.used = true;
    }
    if (done) for (const index of path) nodes[index].boundary = true;
  }

  const pending = new Map<string, CutSegment[]>();
  for (const [id, list] of options.pending ?? []) {
    if (id !== target.id && polygons.some((polygon) => polygon.id === id)) pending.set(id, list);
  }
  if (pieces.length === 1) {
    if (failure) return { kind: 'error', error: failure };
    // Chưa chia được mask: không ID mới, không đổi polygon; giữ đường làm đường chờ của phiên.
    pending.set(target.id, segments);
    return {
      kind: 'pending',
      polygonId: target.id,
      pending,
      message: 'Đường cắt chưa chia được mask nên được giữ làm đường chờ (nét đỏ). Cắt tiếp tới khi nối kín hai biên; Esc để bỏ các đường chờ.',
    };
  }

  // Mảnh lớn nhất giữ ID gốc; các mảnh còn lại giữ ID mới do lõi tách cấp.
  const largest = pieces.reduce((best, piece) => (maskArea(piece) > maskArea(best) ? piece : best));
  pieces = pieces.map((piece) => (piece === largest ? { ...piece, id: target.id } : piece));
  // Cạnh chưa dùng (đường còn dở) tiếp tục chờ trên mảnh chứa nó.
  for (const edge of edges) {
    if (edge.used) continue;
    const segment = { a: nodes[edge.from].point, b: nodes[edge.to].point };
    const middle = { x: (segment.a.x + segment.b.x) / 2, y: (segment.a.y + segment.b.y) / 2 };
    const owner = pieces.find((piece) => pointInMask(middle, piece));
    if (owner) pending.set(owner.id, [...(pending.get(owner.id) ?? []), segment]);
  }
  return {
    kind: 'split',
    polygons: polygons.flatMap((polygon) => (polygon === target ? pieces : [polygon])),
    resultIds: pieces.map((piece) => piece.id),
    pending,
    message: `Đã tách mask ${target.label} thành ${pieces.length} phần tại đường cắt.`,
  };
}
