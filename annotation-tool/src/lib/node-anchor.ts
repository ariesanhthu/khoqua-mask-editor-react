import type { AnnotationPolygon, PolygonNode } from '@/types';
import { normalizeRing, polygonRings } from './geometry-primitives';
import { applyAnchor, findAnchorTarget, findCompletionRoute, TOUCH_TOLERANCE, type AnchorTarget, type Point } from './mask-anchor';

/**
 * Kéo điểm + Shift trong Select (V), người dùng xác nhận 2026-11-12. Ghép hai khái niệm dùng chung của
 * mask-anchor.ts:
 *  1. NEO: điểm đang kéo N nối vào điểm biên của mask Q đang trỏ tới (gần biên ≤ tolerance, hoặc con trỏ trong Q).
 *  2. TỰ HOÀN THIỆN: với mỗi điểm kề M của N (chỉ vòng ngoài) đã nằm trên biên tự do đó (≤ TOUCH), cạnh M→N được
 *     thay bằng các đỉnh thật của Q dọc biên, chọn chiều không bao Q vào trong P.
 * P mới phải là vòng đơn; không thì lùi về một phía, rồi chỉ neo. Hàm thuần: canvas xem trước `preview` khi kéo và
 * commit `next` (P mới + Q được chèn đỉnh neo) khi nhả chuột.
 */

export interface NodeAnchorRequest {
  polygons: AnnotationPolygon[];
  /** `polygons` trừ polygon đang kéo; tính một lần mỗi lần kéo để cache mô hình biên được dùng lại. */
  others: AnnotationPolygon[];
  polygonId: string;
  nodeId: string;
  cursor: Point;
  tolerance: number;
}

export interface NodeAnchorPlan {
  /** Polygon P sau khi neo + tự hoàn thiện (xem trước trong lúc kéo). */
  preview: AnnotationPolygon;
  /** Toàn bộ danh sách polygon để commit: P mới và mask đích đã chèn đỉnh neo. */
  next: AnnotationPolygon[];
  /** Các đường tự hoàn thiện, mỗi đường từ điểm kề qua các điểm chèn tới điểm neo (để vẽ xem trước). */
  routes: Point[][];
  target: AnchorTarget;
  /** Số điểm tự hoàn thiện được chèn vào P. */
  inserted: number;
}

function assemble(ring: PolygonNode[], index: number, moved: PolygonNode, before: PolygonNode[], after: PolygonNode[]): PolygonNode[] {
  // Giữ nguyên thứ tự đỉnh gốc (đỉnh đầu không đổi): … M_trước, [before], N, [after], M_sau …
  const result: PolygonNode[] = [];
  ring.forEach((node, position) => {
    if (position !== index) { result.push(node); return; }
    if (index !== 0) result.push(...before);
    result.push(moved, ...after);
  });
  if (index === 0) result.push(...before);
  return result;
}

export function planNodeAnchorDrag(request: NodeAnchorRequest): NodeAnchorPlan | null {
  const { polygons, others, polygonId, nodeId, cursor, tolerance } = request;
  const polygonIndex = polygons.findIndex((item) => item.id === polygonId);
  const polygon = polygons[polygonIndex];
  if (!polygon || polygon.meta?.locked) return null;
  const rings = polygonRings(polygon);
  const ringIndex = rings.findIndex((ring) => ring.some((node) => node.id === nodeId));
  if (ringIndex < 0) return null;

  const anchor = findAnchorTarget(others, cursor, tolerance, { inside: true, context: polygon.nodes });
  if (!anchor) return null;
  const target = anchor.point;
  const ring = rings[ringIndex];
  const index = ring.findIndex((node) => node.id === nodeId);
  const moved: PolygonNode = { ...ring[index], x: target.x, y: target.y };

  let before: PolygonNode[] = [];
  let after: PolygonNode[] = [];
  if (ringIndex === 0 && ring.length >= 3) {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const next = ring[(index + 1) % ring.length];
    const route = (from: PolygonNode, build: (arc: Point[], end: Point) => Point[]): PolygonNode[] | null => {
      const outcome = findCompletionRoute({
        polygons: others,
        from,
        cursor: target,
        tolerance,
        fromTolerance: TOUCH_TOLERANCE,
        targetPolygonId: anchor.polygonId,
        context: polygon.nodes,
        candidate: (arc, end) => build(arc, end ?? target),
      });
      if (!('route' in outcome) || outcome.route.closesToStart) return null;
      // Đường phải kết thúc đúng tại điểm neo (điểm neo nằm trên seam thì không có biên tự do để đi).
      if (Math.hypot(outcome.route.target.point.x - target.x, outcome.route.target.point.y - target.y) > TOUCH_TOLERANCE) return null;
      return outcome.route.nodes.slice(0, -1);
    };
    const asNodes = (points: Point[]) => points.map((point, order) => ({ id: `candidate-${order}`, x: point.x, y: point.y }));
    before = route(previous, (arc, end) => assemble(ring, index, { ...moved, ...end }, asNodes(arc), [])) ?? [];
    after = route(next, (arc, end) => assemble(ring, index, { ...moved, ...end }, [], asNodes([...arc].reverse()))) ?? [];
  }

  // `before` theo thứ tự M_trước → T, `after` theo thứ tự M_sau → T (đảo lại khi ghép sau N).
  const attempts: Array<[PolygonNode[], PolygonNode[]]> = [[before, after]];
  const sides: Array<[PolygonNode[], PolygonNode[]]> = [[before, []], [[], after]];
  if (before.length && after.length) attempts.push(...sides.sort((a, b) => a[0].length + a[1].length - (b[0].length + b[1].length)));
  attempts.push([[], []]);
  let chosen: [PolygonNode[], PolygonNode[]] = [[], []];
  for (const [beforeNodes, afterNodes] of attempts) {
    const nodes = assemble(ring, index, moved, beforeNodes, [...afterNodes].reverse());
    if ((!beforeNodes.length && !afterNodes.length) || ringIndex !== 0 || normalizeRing(nodes)) {
      chosen = [beforeNodes, afterNodes];
      break;
    }
  }
  const [beforeNodes, afterNodes] = chosen;
  const updatedRing = assemble(ring, index, moved, beforeNodes, [...afterNodes].reverse());
  const preview: AnnotationPolygon = {
    ...polygon,
    ...(ringIndex === 0 ? { nodes: updatedRing } : { holes: polygon.holes!.map((hole, holeIndex) => (holeIndex === ringIndex - 1 ? updatedRing : hole)) }),
    meta: { ...polygon.meta, source: 'human' },
  };
  const withPreview = polygons.map((item, position) => (position === polygonIndex ? preview : item));
  const next = applyAnchor(withPreview, anchor).polygons;
  const routes: Point[][] = [];
  if (ringIndex === 0) {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const following = ring[(index + 1) % ring.length];
    if (beforeNodes.length) routes.push([previous, ...beforeNodes, target]);
    if (afterNodes.length) routes.push([following, ...afterNodes, target]);
  }
  return { preview, next, routes, target: anchor, inserted: beforeNodes.length + afterNodes.length };
}
