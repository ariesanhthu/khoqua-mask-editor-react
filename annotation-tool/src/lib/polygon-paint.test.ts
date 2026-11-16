import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '@/types';
import { polygonArea } from './geometry-primitives';
import { applyPolygonPaint, type PaintResult } from './polygon-paint';

const polygon = (id: string, points: Array<[number, number]>, label = id): AnnotationPolygon => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});
const rectangle = (id: string, left: number, top: number, right: number, bottom: number, label = id) => polygon(id, [
  [left, top], [right, top], [right, bottom], [left, bottom],
], label);
const ring = (points: Array<[number, number]>) => points.map(([x, y]) => ({ x, y }));
const options = (selected: string[] = []) => ({
  selectedIds: new Set(selected),
  newRegion: { label: 'w9', meta: { semantic: 'wart_flesh', source: 'human' as const } },
  bounds: { width: 1000, height: 1000 },
});
const area = (item: AnnotationPolygon) => Math.abs(polygonArea(item.nodes))
  - (item.holes ?? []).reduce((sum, hole) => sum + Math.abs(polygonArea(hole)), 0);
const ok = (result: PaintResult) => {
  if ('error' in result) throw new Error(result.error);
  return result;
};

// Paint (+) nối / (−) trừ bằng polygon (người dùng xác nhận 2026-11-12): không tô pixel, không vector hóa lại,
// nên mask khác không bao giờ bị "dính" vào.
describe('applyPolygonPaint — nối (+)', () => {
  it('trùng cạnh: mở rộng đúng mask đó thành một vùng, giữ id/nhãn và đỉnh gốc', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[100, 0], [150, 0], [150, 100], [100, 100]]), 'add', options()));
    expect(result.polygons).toHaveLength(1);
    const merged = result.polygons[0];
    expect(merged.id).toBe('D');
    expect(merged.label).toBe('D');
    expect(area(merged)).toBeCloseTo(15000, 6);
    // Cạnh trái không đổi giữ nguyên id đỉnh.
    expect(merged.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(['D-0', 'D-3']));
    expect(result.resultIds).toEqual(['D']);
  });

  it('khe hở ≤ 2.5 px vẫn được nối thành một vùng (đỉnh kéo lên biên)', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[101.5, 0], [150, 0], [150, 100], [101.5, 100]]), 'add', options()));
    expect(result.polygons).toHaveLength(1);
    expect(area(result.polygons[0])).toBeCloseTo(15000, 6);
  });

  it('phần chồng lên mask khác bị cắt bỏ: mask đó giữ nguyên, không dính', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const N = rectangle('N', 140, 0, 240, 100);
    const result = ok(applyPolygonPaint([D, N], ring([[100, 0], [160, 0], [160, 100], [100, 100]]), 'add', options(['D'])));
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[1]).toBe(N);
    expect(result.polygons[0].id).toBe('D');
    expect(area(result.polygons[0])).toBeCloseTo(14000, 6);
  });

  it('không chọn mask nào thì nối vào mask bị chồng nhiều nhất', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const N = rectangle('N', 140, 0, 240, 100);
    const result = ok(applyPolygonPaint([D, N], ring([[100, 0], [160, 0], [160, 100], [100, 100]]), 'add', options()));
    expect(result.polygons[0]).toBe(D);
    expect(result.polygons[1].id).toBe('N');
    expect(area(result.polygons[1])).toBeCloseTo(14000, 6);
  });

  it('chỉ chạm tại một điểm: mảnh mới là polygon riêng cùng nhãn', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[100, 100], [150, 100], [150, 150]]), 'add', options()));
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[0].id).toBe('D');
    expect(area(result.polygons[0])).toBeCloseTo(10000, 6);
    expect(result.polygons[1].label).toBe('D');
    expect(area(result.polygons[1])).toBeCloseTo(1250, 6);
  });

  it('không chạm mask nào: tạo mask mới với nhãn kế tiếp', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[300, 300], [400, 300], [400, 400]]), 'add', options()));
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[0]).toBe(D);
    expect(result.polygons[1]).toMatchObject({ label: 'w9', meta: { semantic: 'wart_flesh', source: 'human' } });
  });

  it('mask khóa không bao giờ thành đích: tạo mask mới đã cắt theo mask khóa', () => {
    const L = { ...rectangle('L', 0, 0, 100, 100), meta: { locked: true } };
    const result = ok(applyPolygonPaint([L], ring([[50, 0], [150, 0], [150, 100], [50, 100]]), 'add', options()));
    expect(result.polygons[0]).toBe(L);
    expect(result.polygons[1].label).toBe('w9');
    expect(area(result.polygons[1])).toBeCloseTo(5000, 6);
  });

  it('vẽ lấp lỗ của mask thì lỗ biến mất; vẽ lọt hẳn trong mask thì báo, không đổi gì', () => {
    const withHole: AnnotationPolygon = {
      ...rectangle('H', 0, 0, 100, 100),
      holes: [[{ id: 'h0', x: 40, y: 40 }, { id: 'h1', x: 60, y: 40 }, { id: 'h2', x: 60, y: 60 }, { id: 'h3', x: 40, y: 60 }]],
    };
    const filled = ok(applyPolygonPaint([withHole], ring([[30, 30], [70, 30], [70, 70], [30, 70]]), 'add', options()));
    expect(filled.polygons[0].holes ?? []).toHaveLength(0);
    expect(area(filled.polygons[0])).toBeCloseTo(10000, 6);
    const inside = applyPolygonPaint([withHole], ring([[10, 10], [20, 10], [20, 20]]), 'add', options());
    expect('error' in inside).toBe(true);
  });

  it('polygon tự cắt bị từ chối', () => {
    const result = applyPolygonPaint([], ring([[0, 0], [100, 100], [100, 0], [0, 100]]), 'add', options());
    expect('error' in result).toBe(true);
  });
});

describe('applyPolygonPaint — trừ (−)', () => {
  it('trừ ở giữa tạo lỗ, giữ id', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[40, 40], [60, 40], [60, 60], [40, 60]]), 'subtract', options()));
    expect(result.polygons).toHaveLength(1);
    expect(result.polygons[0].id).toBe('D');
    expect(result.polygons[0].holes).toHaveLength(1);
    expect(area(result.polygons[0])).toBeCloseTo(9600, 6);
  });

  it('cắt đôi: mảnh lớn giữ id, mảnh còn lại là mask riêng cùng nhãn', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const result = ok(applyPolygonPaint([D], ring([[30, -10], [40, -10], [40, 110], [30, 110]]), 'subtract', options()));
    expect(result.polygons).toHaveLength(2);
    expect(result.polygons[0].id).toBe('D');
    expect(area(result.polygons[0])).toBeCloseTo(6000, 6);
    expect(result.polygons[1].label).toBe('D');
    expect(area(result.polygons[1])).toBeCloseTo(3000, 6);
  });

  it('phủ kín thì xóa mask; mask khóa và mask không bị chồng giữ nguyên', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    const L = { ...rectangle('L', 100, 0, 200, 100), meta: { locked: true } };
    const far = rectangle('far', 500, 500, 600, 600);
    const result = ok(applyPolygonPaint([D, L, far], ring([[-10, -10], [190, -10], [190, 110], [-10, 110]]), 'subtract', options()));
    expect(result.polygons).toEqual([L, far]);
  });

  it('không chồng mask nào thì báo lỗi', () => {
    const D = rectangle('D', 0, 0, 100, 100);
    expect('error' in applyPolygonPaint([D], ring([[200, 200], [300, 200], [300, 300]]), 'subtract', options())).toBe(true);
  });
});

// Paint (−) với ĐÚNG 2 điểm = đường cắt tách mask (người dùng xác nhận 2026-11-16): đường đi qua mask thì tách
// làm hai tại hai giao điểm trên biên, dùng chung lõi với công cụ cắt (resolvePolygonCut).
describe('applyPolygonPaint — đường cắt 2 điểm trong chế độ trừ (2026-11-16)', () => {
  it('đường xuyên qua mask tách nó làm hai mảnh, mỗi mảnh có điểm mới tại giao với biên', () => {
    const result = ok(applyPolygonPaint([rectangle('A', 0, 0, 100, 100)], ring([[50, -10], [50, 110]]), 'subtract', options()));
    expect(result.polygons).toHaveLength(2);
    expect(result.resultIds).toHaveLength(2);
    const [left, right] = result.polygons;
    expect(left.label).toBe('A');
    expect(right.label).toBe('A');
    expect(Math.abs(area(left) - 5000)).toBeLessThan(1);
    expect(Math.abs(area(right) - 5000)).toBeLessThan(1);
    for (const piece of result.polygons) {
      expect(piece.nodes.filter((node) => Math.abs(node.x - 50) < 0.01 && (Math.abs(node.y) < 0.01 || Math.abs(node.y - 100) < 0.01))).toHaveLength(2);
    }
  });

  it('hai điểm nằm đúng trên biên (đã neo) vẫn tách được', () => {
    const result = ok(applyPolygonPaint([rectangle('A', 0, 0, 100, 100)], ring([[40, 0], [60, 100]]), 'subtract', options()));
    expect(result.polygons).toHaveLength(2);
  });

  it('mask có lỗ: lỗ đi theo mảnh chứa nó; đường cắt chạm lỗ thì từ chối', () => {
    const withHole: AnnotationPolygon = {
      ...rectangle('A', 0, 0, 200, 100),
      holes: [[[150, 40], [170, 40], [170, 60], [150, 60]].map(([x, y], index) => ({ id: `h-${index}`, x, y }))],
    };
    const result = ok(applyPolygonPaint([withHole], ring([[50, -10], [50, 110]]), 'subtract', options()));
    const withHolePiece = result.polygons.find((piece) => piece.holes?.length);
    const plainPiece = result.polygons.find((piece) => !piece.holes?.length);
    expect(withHolePiece && plainPiece).toBeTruthy();
    expect(withHolePiece!.nodes.some((node) => node.x > 150)).toBe(true);
    const through = applyPolygonPaint([withHole], ring([[160, -10], [160, 110]]), 'subtract', options());
    expect('error' in through && /lỗ/.test(through.error)).toBe(true);
  });

  it('đường qua nhiều mask: lấy mask đang chọn, không chọn thì mask mà đường nằm trong nhiều nhất', () => {
    const scene = [rectangle('A', 0, 0, 100, 100), rectangle('B', 0, 120, 100, 320)];
    const dominant = ok(applyPolygonPaint(scene, ring([[50, -10], [50, 330]]), 'subtract', options()));
    expect(dominant.polygons[0]).toBe(scene[0]);
    expect(dominant.polygons.filter((piece) => piece.label === 'B')).toHaveLength(2);
    const picked = ok(applyPolygonPaint(scene, ring([[50, -10], [50, 330]]), 'subtract', options(['A'])));
    expect(picked.polygons.at(-1)).toBe(scene[1]);
    expect(picked.polygons.filter((piece) => piece.label === 'A')).toHaveLength(2);
  });

  it('đường chưa chia được mask: trả NGUYÊN mảng polygon (không ID mới) kèm đường chờ; đường nối tiếp mới tách', () => {
    const scene = [rectangle('A', 0, 0, 100, 100)];
    const waiting = ok(applyPolygonPaint(scene, ring([[50, 0], [50, 60]]), 'subtract', options()));
    expect(waiting.polygons).toBe(scene);
    expect(waiting.resultIds).toEqual([]);
    expect(waiting.pendingCuts?.get('A')).toHaveLength(1);
    const done = ok(applyPolygonPaint(scene, ring([[50, 60], [100, 60]]), 'subtract', { ...options(), pendingCuts: waiting.pendingCuts }));
    expect(done.polygons).toHaveLength(2);
    expect(done.polygons.filter((piece) => piece.id === 'A')).toHaveLength(1);
  });

  it('đường không xuyên qua mask nào thì báo lỗi và không đổi gì', () => {
    const result = applyPolygonPaint([rectangle('A', 0, 0, 100, 100)], ring([[200, 0], [200, 100]]), 'subtract', options());
    expect('error' in result).toBe(true);
  });

  it('mask khóa không bị tách', () => {
    const locked: AnnotationPolygon = { ...rectangle('A', 0, 0, 100, 100), meta: { locked: true } };
    const result = applyPolygonPaint([locked], ring([[50, -10], [50, 110]]), 'subtract', options());
    expect('error' in result).toBe(true);
  });

  it('chế độ nối (+) với 2 điểm vẫn là lỗi polygon quá nhỏ (không cắt)', () => {
    const result = applyPolygonPaint([rectangle('A', 0, 0, 100, 100)], ring([[50, -10], [50, 110]]), 'add', options());
    expect('error' in result).toBe(true);
  });
});

/**
 * Lỗi "không hoàn tất được polygon ở chế độ trừ" trên dữ liệu thật (2026-11-16): ≈26 % polygon prelabel vector hóa
 * tự chạm tại một đỉnh; trước đây chỉ cần MỘT mask như vậy nằm gần vùng vẽ là cả thao tác bị từ chối ("Biên mask …
 * không hợp lệ") — đo 52 % lần trừ trên drive/prelabel-production. Nay dùng hình học đã sửa (maskClipGeometry).
 */
describe('applyPolygonPaint — mask tự chạm không còn chặn thao tác (2026-11-16)', () => {
  // Nơ bướm thắt tại (50,50): một vòng tự chạm, polygonGeometry trả null.
  const pinched = polygon('P', [[0, 0], [50, 50], [100, 0], [100, 100], [50, 50], [0, 100]]);

  it('trừ một mask hợp lệ nằm cạnh mask tự chạm vẫn áp dụng được, mask tự chạm giữ nguyên', () => {
    const neighbour = rectangle('N', 100, 0, 200, 100);
    const result = ok(applyPolygonPaint([pinched, neighbour], ring([[150, -10], [210, -10], [210, 50], [150, 50]]), 'subtract', options()));
    expect(result.polygons[0]).toBe(pinched);
    expect(area(result.polygons[1])).toBeCloseTo(10000 - 2500, 6);
  });

  it('trừ chính mask tự chạm: chỉ phần chồng bị xóa, phần còn lại được bảo toàn', () => {
    const result = ok(applyPolygonPaint([pinched], ring([[60, 60], [110, 60], [110, 110], [60, 110]]), 'subtract', options()));
    const remaining = result.polygons.reduce((sum, item) => sum + area(item), 0);
    // Nơ bướm = hai tam giác 2500; ô trừ chồng lên tam giác phải 40×40 − góc ngoài tam giác.
    expect(remaining).toBeLessThan(5000);
    expect(remaining).toBeGreaterThan(5000 - 1600 - 1);
    expect(new Set(result.polygons.map((item) => item.id)).size).toBe(result.polygons.length);
  });

  it('nối (+) cạnh mask tự chạm cũng không còn bị chặn', () => {
    const neighbour = rectangle('N', 100, 0, 200, 100);
    const result = ok(applyPolygonPaint([pinched, neighbour], ring([[200, 20], [240, 20], [240, 80], [200, 80]]), 'add', options()));
    expect(result.polygons[0]).toBe(pinched);
    expect(area(result.polygons[1])).toBeCloseTo(10000 + 2400, 6);
  });
});
