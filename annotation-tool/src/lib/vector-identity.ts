import type { AnnotationPolygon } from '../types/index';

export type PolygonBounds = { left: number; right: number; top: number; bottom: number };

const boundsCache = new WeakMap<AnnotationPolygon, PolygonBounds>();

/**
 * Bounds of the outer ring, cached per (immutable) polygon object. A plain loop: the previous
 * `reduce` allocated one object per node, which dominated adopting large vector results.
 */
export function polygonBounds(polygon: AnnotationPolygon): PolygonBounds {
  const cached = boundsCache.get(polygon);
  if (cached) return cached;
  let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
  for (const node of polygon.nodes) {
    if (node.x < left) left = node.x;
    if (node.x > right) right = node.x;
    if (node.y < top) top = node.y;
    if (node.y > bottom) bottom = node.y;
  }
  const bounds = { left, right, top, bottom };
  boundsCache.set(polygon, bounds);
  return bounds;
}

function boxIou(a: PolygonBounds, b: PolygonBounds) {
  const intersection = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Carries ids/labels/meta from the previous polygons over to freshly traced ones. Greedy in `next`
 * order: each new polygon takes the still-available previous polygon with the highest bounding-box IoU
 * (first one wins a tie), and keeps its own identity below IoU 0.1.
 *
 * Only boxes that overlap can score above zero, so candidates come from a uniform grid over the
 * previous boxes instead of a scan of all of them: O(n) for typical masks instead of O(n²). Candidates
 * are visited in their original order, so the result is identical to the exhaustive scan.
 */
export function preserveVectorIdentity(next: AnnotationPolygon[], previous: AnnotationPolygon[]): AnnotationPolygon[] {
  const available = new Set(previous.map((polygon) => polygon.id));
  const boxes = previous.map(polygonBounds);
  let sizeSum = 0; let sized = 0;
  for (const box of boxes) {
    const size = Math.max(box.right - box.left, box.bottom - box.top);
    if (Number.isFinite(size) && size > 0) { sizeSum += size; sized += 1; }
  }
  const cell = Math.max(16, sized ? sizeSum / sized : 16);
  const grid = new Map<number, number[]>();
  // 2^21 columns keeps keys exact for any realistic image coordinate.
  const key = (column: number, row: number) => row * 2097152 + column;
  const span = (box: PolygonBounds) => (Number.isFinite(box.left) && Number.isFinite(box.right)
    && Number.isFinite(box.top) && Number.isFinite(box.bottom) && box.right > box.left && box.bottom > box.top
    ? {
      left: Math.floor(box.left / cell), right: Math.floor(box.right / cell),
      top: Math.floor(box.top / cell), bottom: Math.floor(box.bottom / cell),
    } : null);
  boxes.forEach((box, index) => {
    const cells = span(box);
    if (!cells) return;
    for (let row = cells.top; row <= cells.bottom; row += 1) {
      for (let column = cells.left; column <= cells.right; column += 1) {
        const bucket = grid.get(key(column, row));
        if (bucket) bucket.push(index); else grid.set(key(column, row), [index]);
      }
    }
  });

  return next.map((polygon) => {
    const box = polygonBounds(polygon);
    const cells = span(box);
    if (!cells) return polygon;
    const seen = new Set<number>();
    for (let row = cells.top; row <= cells.bottom; row += 1) {
      for (let column = cells.left; column <= cells.right; column += 1) {
        for (const index of grid.get(key(column, row)) ?? []) seen.add(index);
      }
    }
    let best: AnnotationPolygon | undefined;
    let bestScore = 0;
    for (const index of [...seen].sort((a, b) => a - b)) {
      const candidate = previous[index];
      if (!available.has(candidate.id)) continue;
      const score = boxIou(box, boxes[index]);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best || bestScore < 0.1) return polygon;
    available.delete(best.id);
    return { ...polygon, id: best.id, label: best.label, meta: best.meta };
  });
}
