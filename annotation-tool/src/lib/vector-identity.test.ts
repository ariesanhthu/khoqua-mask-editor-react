import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '../types/index';
import { polygonBounds, preserveVectorIdentity } from './vector-identity';

/** The exhaustive scan used by the canvas before the grid index (2026-10-25). */
function exhaustive(next: AnnotationPolygon[], previous: AnnotationPolygon[]) {
  const available = new Set(previous.map((polygon) => polygon.id));
  return next.map((polygon) => {
    const bounds = polygonBounds(polygon);
    let best: AnnotationPolygon | undefined;
    let bestScore = 0;
    for (const candidate of previous) {
      if (!available.has(candidate.id)) continue;
      const old = polygonBounds(candidate);
      const intersection = Math.max(0, Math.min(bounds.right, old.right) - Math.max(bounds.left, old.left))
        * Math.max(0, Math.min(bounds.bottom, old.bottom) - Math.max(bounds.top, old.top));
      const union = (bounds.right - bounds.left) * (bounds.bottom - bounds.top)
        + (old.right - old.left) * (old.bottom - old.top) - intersection;
      const score = union > 0 ? intersection / union : 0;
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best || bestScore < 0.1) return polygon;
    available.delete(best.id);
    return { ...polygon, id: best.id, label: best.label, meta: best.meta };
  });
}

function boxes(seed: number, count: number, prefix: string): AnnotationPolygon[] {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, (_, index) => {
    const x = random() * 900; const y = random() * 600;
    const w = random() < 0.1 ? 700 * random() : 3 + random() * 60; const h = 3 + random() * 60;
    const nodes = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([nx, ny], i) => ({ id: `${prefix}${index}-${i}`, x: nx, y: ny }));
    return { id: `${prefix}${index}`, label: `w${index + 1}`, nodes, meta: { source: 'human' as const } };
  });
}

describe('vector identity preservation', () => {
  it('matches the exhaustive IoU scan exactly, including ties, big boxes and duplicated ids', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const previous = boxes(seed, 40 + seed * 7, 'old');
      if (seed % 5 === 0) previous.push({ ...previous[0], nodes: previous[0].nodes.map((node) => ({ ...node })) });
      // New results: shifted copies (should inherit), plus unrelated shapes (should not).
      const shifted = previous.slice(0, Math.floor(previous.length * 0.7)).map((polygon, index) => ({
        id: `new${index}`, label: `w${index + 1}`,
        nodes: polygon.nodes.map((node) => ({ ...node, x: node.x + (index % 3), y: node.y - (index % 2) })),
      }));
      const next = [...shifted, ...boxes(seed + 100, 20, 'fresh')];
      expect(preserveVectorIdentity(next, previous), `seed ${seed}`).toEqual(exhaustive(next, previous));
    }
  });

  it('keeps identity from the best overlap and leaves weak overlaps alone', () => {
    const square = (id: string, x: number, size = 10): AnnotationPolygon => ({
      id, label: id, nodes: [[x, 0], [x + size, 0], [x + size, size], [x, size]].map(([nx, ny], i) => ({ id: `${id}-${i}`, x: nx, y: ny })),
    });
    const previous = [{ ...square('r1', 0), meta: { semantic: 'main_flesh_band' } }, square('w7', 30), square('w8', 60)];
    // IoU: mask-1/r1 = 90/110; mask-2/w7 = 20/180 ≈ 0.11 (inherits); mask-3/w8 = 10/190 ≈ 0.05 (keeps own id).
    const [first, second, third] = preserveVectorIdentity([square('mask-1', 1), square('mask-2', 38), square('mask-3', 69)], previous);
    expect(first).toMatchObject({ id: 'r1', label: 'r1', meta: { semantic: 'main_flesh_band' } });
    expect(second).toMatchObject({ id: 'w7', label: 'w7' });
    expect(third).toMatchObject({ id: 'mask-3', label: 'mask-3' });
  });

  it('treats degenerate and empty polygons as unmatched', () => {
    const flat: AnnotationPolygon = { id: 'flat', label: 'w1', nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }, { id: 'c', x: 9, y: 0 }] };
    const empty: AnnotationPolygon = { id: 'empty', label: 'w2', nodes: [] };
    expect(preserveVectorIdentity([flat, empty], [flat, empty])).toEqual([flat, empty]);
    expect(polygonBounds(empty)).toEqual({ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    expect(polygonBounds(flat)).toBe(polygonBounds(flat));
  });
});
