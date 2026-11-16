import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '@/types';
import { polygonArea } from './geometry-primitives';
import { applyLineCut, type CutSegment, type LineCutResult } from './mask-cut';

const polygon = (id: string, points: Array<[number, number]>, label = id): AnnotationPolygon => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});
const rectangle = (id: string, left: number, top: number, right: number, bottom: number) => polygon(id, [
  [left, top], [right, top], [right, bottom], [left, bottom],
]);
const line = (ax: number, ay: number, bx: number, by: number): CutSegment => ({ a: { x: ax, y: ay }, b: { x: bx, y: by } });
const area = (item: AnnotationPolygon) => Math.abs(polygonArea(item.nodes))
  - (item.holes ?? []).reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
const split = (result: LineCutResult) => {
  if (result.kind !== 'split') throw new Error(`expected split, got ${result.kind}: ${'error' in result ? result.error : ''}`);
  return result;
};

// Spec người dùng 2026-11-16 (Rule 2–5 của "Polygon Trim Mode"), tiêu chí nghiệm thu 5–11.
describe('applyLineCut — Rule 2: đường 2 điểm trên biên chia mask, không khe hở', () => {
  it('chia làm hai mask; đường cắt là biên chung (đỉnh trùng tọa độ ở cả hai mảnh), không mất diện tích', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const result = split(applyLineCut([A], line(40, 0, 60, 100)));
    expect(result.polygons).toHaveLength(2);
    const [first, second] = result.polygons;
    expect(area(first) + area(second)).toBeCloseTo(10000, 6);
    for (const piece of result.polygons) {
      expect(piece.nodes.some((node) => node.x === 40 && node.y === 0)).toBe(true);
      expect(piece.nodes.some((node) => node.x === 60 && node.y === 100)).toBe(true);
    }
    // Hai đối tượng độc lập: id khác nhau, id đỉnh không dùng chung.
    expect(first.id).not.toBe(second.id);
    const nodeIds = result.polygons.flatMap((piece) => piece.nodes.map((node) => node.id));
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  it('Rule 4: mảnh lớn nhất giữ ID gốc, mảnh còn lại nhận ID mới; nhãn giữ nguyên', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const result = split(applyLineCut([A], line(30, 0, 30, 100)));
    const kept = result.polygons.find((piece) => piece.id === 'A')!;
    const created = result.polygons.find((piece) => piece.id !== 'A')!;
    expect(area(kept)).toBeCloseTo(7000, 6);
    expect(area(created)).toBeCloseTo(3000, 6);
    expect(created.label).toBe('A');
    expect(result.resultIds.sort()).toEqual([kept.id, created.id].sort());
  });

  it('đầu mút lệch vào trong biên trong dung sai được đưa về đúng biên', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    expect(applyLineCut([A], line(50, 2, 50, 97)).kind).toBe('pending');
    const result = split(applyLineCut([A], line(50, 2, 50, 97), { tolerance: 5 }));
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons.every((piece) => piece.nodes.some((node) => node.y === 0) && piece.nodes.some((node) => node.y === 100))).toBe(true);
  });

  it('một đường qua mask lõm (cắt biên 4 lần) chia thành 3 mask, mỗi mask một ID', () => {
    // Hình chữ U: hai nhánh đứng nối bằng đáy; đường ngang cắt qua cả hai nhánh.
    const U = polygon('U', [[0, 0], [30, 0], [30, 70], [70, 70], [70, 0], [100, 0], [100, 100], [0, 100]]);
    const result = split(applyLineCut([U], line(-10, 40, 110, 40)));
    expect(result.polygons).toHaveLength(3);
    expect(new Set(result.polygons.map((piece) => piece.id)).size).toBe(3);
    expect(result.polygons.filter((piece) => piece.id === 'U')).toHaveLength(1);
    expect(result.polygons.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(area(U), 6);
  });

  it('mask khác không bị đụng: giữ nguyên tham chiếu và vị trí trong mảng', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const B = rectangle('B', 200, 0, 300, 100);
    const C = rectangle('C', 0, 200, 100, 300);
    const result = split(applyLineCut([B, A, C], line(50, -5, 50, 105)));
    expect(result.polygons[0]).toBe(B);
    expect(result.polygons.at(-1)).toBe(C);
    expect(result.polygons).toHaveLength(4);
  });

  it('đường qua nhiều mask: lấy mask đang chọn, không chọn thì mask mà đường nằm trong nhiều nhất', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const B = rectangle('B', 0, 120, 100, 320);
    const dominant = split(applyLineCut([A, B], line(50, -10, 50, 330)));
    expect(dominant.polygons[0]).toBe(A);
    expect(dominant.polygons.filter((piece) => piece.label === 'B')).toHaveLength(2);
    const chosen = split(applyLineCut([A, B], line(50, -10, 50, 330), { selectedIds: new Set(['A']) }));
    expect(chosen.polygons.at(-1)).toBe(B);
    expect(chosen.polygons.filter((piece) => piece.label === 'A')).toHaveLength(2);
  });

  it('mask khóa, đường không qua mask nào, đường chạm lỗ: báo lỗi, không đổi gì', () => {
    const locked: AnnotationPolygon = { ...rectangle('A', 0, 0, 100, 100), meta: { locked: true } };
    expect(applyLineCut([locked], line(50, -5, 50, 105)).kind).toBe('error');
    expect(applyLineCut([rectangle('A', 0, 0, 100, 100)], line(200, 0, 200, 100)).kind).toBe('error');
    const withHole: AnnotationPolygon = {
      ...rectangle('H', 0, 0, 200, 100),
      holes: [[[150, 40], [170, 40], [170, 60], [150, 60]].map(([x, y], index) => ({ id: `h-${index}`, x, y }))],
    };
    const through = applyLineCut([withHole], line(160, -10, 160, 110));
    expect(through.kind === 'error' && /lỗ/.test(through.error)).toBe(true);
  });
});

describe('applyLineCut — Rule 3 & 5: chỉ tách ID khi thực sự phân tách (đường chờ + nhiều đường cắt)', () => {
  const A = rectangle('A', 0, 0, 100, 100);

  it('một đường từ biên vào giữa mask chưa chia được: không ID mới, polygon không đổi, đường được giữ chờ', () => {
    const result = applyLineCut([A], line(50, 0, 50, 60));
    expect(result.kind).toBe('pending');
    if (result.kind !== 'pending') return;
    expect(result.polygonId).toBe('A');
    expect(result.pending.get('A')).toHaveLength(1);
  });

  it('đường thứ hai nối vào đầu đường chờ tạo ranh giới kín → tách thành hai mask, đường chờ được dùng hết', () => {
    const first = applyLineCut([A], line(50, 0, 50, 60));
    if (first.kind !== 'pending') throw new Error('expected pending');
    const second = split(applyLineCut([A], line(50, 60, 100, 60), { pending: first.pending }));
    expect(second.polygons).toHaveLength(2);
    expect(second.polygons.filter((piece) => piece.id === 'A')).toHaveLength(1);
    expect(second.polygons.reduce((sum, piece) => sum + area(piece), 0)).toBeCloseTo(10000, 6);
    // Mảnh nhỏ là ô góc trên phải 50×60 = 3000.
    expect(Math.min(...second.polygons.map(area))).toBeCloseTo(3000, 6);
    expect(second.pending.size).toBe(0);
  });

  it('đầu đường thứ hai chỉ cần gần đầu đường chờ (trong dung sai) là nối được', () => {
    const first = applyLineCut([A], line(50, 0, 50, 60));
    if (first.kind !== 'pending') throw new Error('expected pending');
    const second = split(applyLineCut([A], line(52, 58, 100, 60), { pending: first.pending, tolerance: 6 }));
    expect(second.polygons).toHaveLength(2);
  });

  it('hai đường chờ không nối nhau vẫn chưa tách; đường thứ ba nối cả hai mới tách', () => {
    const first = applyLineCut([A], line(0, 50, 30, 50));
    if (first.kind !== 'pending') throw new Error('expected pending');
    const second = applyLineCut([A], line(100, 50, 70, 50), { pending: first.pending });
    expect(second.kind).toBe('pending');
    if (second.kind !== 'pending') return;
    expect(second.pending.get('A')).toHaveLength(2);
    const third = split(applyLineCut([A], line(30, 50, 70, 50), { pending: second.pending }));
    expect(third.polygons).toHaveLength(2);
    expect(third.polygons.map(area).sort((a, b) => a - b)).toEqual([5000, 5000]);
  });

  it('đường cắt chéo qua đường chờ: đánh giá tổng thể, đỉnh giao thành đỉnh biên và phần thừa tiếp tục chờ', () => {
    const first = split(applyLineCut([A], line(50, 0, 50, 100)));
    // Đường ngang cắt qua CẢ HAI mảnh vừa tách: chỉ mask đích (chọn sẵn) bị chia, mảnh kia giữ nguyên.
    const left = first.polygons.find((piece) => piece.nodes.every((node) => node.x <= 50))!;
    const second = split(applyLineCut(first.polygons, line(0, 50, 100, 50), { selectedIds: new Set([left.id]) }));
    expect(second.polygons).toHaveLength(3);
    // Từ một mask nguyên với đường chờ chữ thập: đường dọc chờ (kết thúc giữa mask), đường ngang cắt ngang qua nó.
    const waiting = applyLineCut([A], line(50, 0, 50, 70));
    if (waiting.kind !== 'pending') throw new Error('expected pending');
    const crossed = split(applyLineCut([A], line(0, 50, 100, 50), { pending: waiting.pending }));
    // Đường ngang chia đôi; nửa trên lại được đường chờ dọc (nay chạm biên mới tại (50,50)) chia đôi tiếp.
    expect(crossed.polygons).toHaveLength(3);
    expect(new Set(crossed.polygons.map((piece) => piece.id)).size).toBe(3);
    // Đoạn dọc còn thừa bên dưới (50,50)→(50,70) tiếp tục chờ trên mảnh chứa nó.
    const leftover = [...crossed.pending.values()].flat();
    expect(leftover).toHaveLength(1);
  });
});
