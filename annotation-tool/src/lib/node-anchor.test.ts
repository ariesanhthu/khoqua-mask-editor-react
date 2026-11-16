import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '@/types';
import { planNodeAnchorDrag } from './node-anchor';

const polygon = (id: string, points: Array<[number, number]>, label = id): AnnotationPolygon => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});
const xy = (item: AnnotationPolygon) => item.nodes.map(({ x, y }) => [x, y]);

// Kéo điểm + Shift trong Select (người dùng xác nhận 2026-11-12): điểm NEO vào biên mask đang trỏ, cạnh tới
// điểm kề đã nằm trên biên đó được TỰ HOÀN THIỆN bằng các đỉnh thật của mask đích.
describe('planNodeAnchorDrag', () => {
  // Q có biên trái gấp khúc (100,100)→(95,80)→(95,20)→(100,0).
  const Q = polygon('Q', [[100, 0], [200, 0], [200, 100], [100, 100], [95, 80], [95, 20]]);
  // P chạm Q tại (100,0) và (100,100); điểm N = P-2 đang lõm vào trong.
  const P = polygon('P', [[0, 0], [100, 0], [60, 50], [100, 100], [0, 100]]);
  const plan = (polygons: AnnotationPolygon[], nodeId: string, cursor: { x: number; y: number }, polygonId = 'P') => planNodeAnchorDrag({
    polygons, others: polygons.filter((item) => item.id !== polygonId), polygonId, nodeId, cursor, tolerance: 14,
  });

  it('neo N vào biên Q và tự hoàn thiện cả hai phía bằng đỉnh thật của Q', () => {
    const result = plan([P, Q], 'P-2', { x: 96, y: 50 })!;
    expect(result).not.toBeNull();
    expect(xy(result.preview)).toEqual([[0, 0], [100, 0], [95, 20], [95, 50], [95, 80], [100, 100], [0, 100]]);
    expect(result.preview.nodes[3].id).toBe('P-2');
    expect(result.inserted).toBe(2);
    expect(result.target).toMatchObject({ polygonId: 'Q', point: { x: 95, y: 50 } });
    // Commit: P mới + Q được chèn đỉnh neo (95,50) để hai mask chung điểm.
    expect(result.next[0]).toBe(result.preview);
    expect(xy(result.next[1])).toEqual([[100, 0], [200, 0], [200, 100], [100, 100], [95, 80], [95, 50], [95, 20]]);
  });

  it('chỉ một điểm kề nằm trên biên Q: tự hoàn thiện đúng phía đó, đúng thứ tự', () => {
    const oneSide = polygon('P', [[0, 0], [100, 0], [60, 50], [50, 100], [0, 100]]);
    const result = plan([oneSide, Q], 'P-2', { x: 96, y: 50 })!;
    expect(xy(result.preview)).toEqual([[0, 0], [100, 0], [95, 20], [95, 50], [50, 100], [0, 100]]);
    expect(result.inserted).toBe(1);
    expect(result.routes).toEqual([[{ id: 'P-1', x: 100, y: 0 }, expect.objectContaining({ x: 95, y: 20 }), { x: 95, y: 50 }]]);
  });

  it('điểm kề chưa nằm trên biên Q thì chỉ neo, không chèn thêm điểm', () => {
    const loose = polygon('P', [[0, 0], [50, 0], [60, 50], [50, 100], [0, 100]]);
    const result = plan([loose, Q], 'P-2', { x: 96, y: 50 })!;
    expect(xy(result.preview)).toEqual([[0, 0], [50, 0], [95, 50], [50, 100], [0, 100]]);
    expect(result.inserted).toBe(0);
  });

  it('Q khóa: vẫn neo và đi theo biên, nhưng Q không bị chèn đỉnh', () => {
    const lockedQ = { ...Q, meta: { locked: true } };
    const result = plan([P, lockedQ], 'P-2', { x: 96, y: 50 })!;
    expect(result.inserted).toBe(2);
    expect(result.next[1]).toBe(lockedQ);
  });

  it('node thuộc lỗ chỉ neo', () => {
    const holed: AnnotationPolygon = {
      ...polygon('P', [[-100, -100], [90, -100], [90, 200], [-100, 200]]),
      holes: [[{ id: 'h0', x: 0, y: 0 }, { id: 'h1', x: 60, y: 50 }, { id: 'h2', x: 0, y: 100 }]],
    };
    const far = polygon('F', [[300, 0], [400, 0], [400, 100], [300, 100]]);
    const result = plan([holed, far], 'h1', { x: 302, y: 50 })!;
    expect(result.preview.holes![0].map(({ x, y }) => [x, y])).toEqual([[0, 0], [300, 50], [0, 100]]);
    expect(result.inserted).toBe(0);
  });

  it('không có mask nào gần con trỏ, hoặc P khóa: không neo', () => {
    expect(plan([P, Q], 'P-2', { x: 40, y: 50 })).toBeNull();
    expect(plan([{ ...P, meta: { locked: true } }, Q], 'P-2', { x: 96, y: 50 })).toBeNull();
  });
});
