import { describe, expect, it, vi } from 'vitest';
import polygonClipping from 'polygon-clipping';
import type { AnnotationPolygon } from '@/types';
import { findAutoAnchorPath } from './polygon-geometry';
import { applyAnchor, findAnchorTarget, findCompletionRoute } from './mask-anchor';

const polygon = (id: string, points: Array<[number, number]>, label = 'damage'): AnnotationPolygon => ({
  id,
  label,
  nodes: points.map(([x, y], index) => ({ id: `${id}-${index}`, x, y })),
});

const rectangle = (id: string, left: number, top: number, right: number, bottom: number, label = 'damage') => polygon(id, [
  [left, top], [right, top], [right, bottom], [left, bottom],
], label);

// Tự hoàn thiện (Shift) — 4 lỗi của lõi sau commit 4ec7a7b, người dùng xác nhận sửa 2026-11-12.
describe('tự hoàn thiện: các lỗi của lõi 2026-11-07 (người dùng xác nhận sửa 2026-11-12)', () => {
  it('lỗi 1+2: thu nhỏ không bắc cầu qua khe hở 20 px, kể cả khi dung sai màn hình lớn', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const B = rectangle('B', 120, 0, 220, 100);
    // Zoom 25%: 14 px màn hình = 56 px ảnh. Hai mask cách nhau 20 px không liền nhau (> 2.5 px).
    const result = findAutoAnchorPath([A, B], { x: 170, y: 50 }, [{ x: 50, y: -50 }, { x: 50, y: 0 }], 56);
    expect(result).toBeNull();
  });

  it('lỗi 2+3: mask dưới con trỏ bị bao kín không có biên tự do trên vòng của điểm vừa chấm', () => {
    // Lưới 3×3 ô 50 px; ô giữa w5 bị 8 ô kia bao kín nên không có cạnh tự do nào.
    const cells: AnnotationPolygon[] = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        cells.push(rectangle(`w${row * 3 + col + 1}`, col * 50, row * 50, col * 50 + 50, row * 50 + 50));
      }
    }
    const result = findAutoAnchorPath(cells, { x: 75, y: 75 }, [{ x: 20, y: -40 }, { x: 20, y: 0 }]);
    expect(result).toBeNull();
  });

  it('lỗi 3: không đi dọc seam với mask nằm ngoài chuỗi', () => {
    const A = rectangle('A', 0, 0, 100, 100);
    const E = rectangle('E', 100, 0, 200, 100);
    const draft = [{ x: 150, y: 150 }, { x: 50, y: 100 }];
    const result = findAutoAnchorPath([A, E], { x: 50, y: 5 }, draft);
    expect(result).not.toBeNull();
    const route = [draft[draft.length - 1], ...result!.nodes];
    const walksSeam = route.slice(1).some((node, index) => {
      const previous = route[index];
      return Math.abs(previous.x - 100) < 1e-6 && Math.abs(node.x - 100) < 1e-6
        && Math.abs(previous.y - node.y) > 1;
    });
    expect(walksSeam).toBe(false);
  });

  it('lỗi 4: rê chuột nhiều lần trên cùng mảng polygon chỉ hợp biên một lần (cache)', () => {
    const masks = [rectangle('A', 0, 0, 100, 100), rectangle('B', 100, 0, 200, 100), rectangle('C', 200, 0, 300, 100)];
    const union = vi.spyOn(polygonClipping, 'union');
    try {
      const draft = [{ x: 50, y: -40 }, { x: 50, y: 0 }];
      for (const x of [210, 230, 250, 270]) findAutoAnchorPath(masks, { x, y: 5 }, draft);
      expect(union.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      union.mockRestore();
    }
  });

  it('đi trên vòng của khoảng trống bị bao kín khi vẽ bên trong nó', () => {
    // Khung 4 mask bao lỗ trống x,y 30..70.
    const frame = [
      rectangle('top', 0, 0, 100, 30),
      rectangle('bottom', 0, 70, 100, 100),
      rectangle('left', 0, 30, 30, 70),
      rectangle('right', 70, 30, 100, 70),
    ];
    const result = findAutoAnchorPath(frame, { x: 50, y: 82 }, [{ x: 45, y: 50 }, { x: 50, y: 30 }]);
    expect(result).not.toBeNull();
    expect(result!.target).toEqual({ x: 50, y: 70, polygonId: 'bottom' });
    // Mọi điểm chèn nằm trên biên khoảng trống, không vòng ra ngoài khung.
    expect(result!.nodes.every((node) => node.x >= 30 - 1e-6 && node.x <= 70 + 1e-6 && node.y >= 30 - 1e-6 && node.y <= 70 + 1e-6)).toBe(true);
  });
});

// Neo (người dùng xác nhận 2026-11-12): nối vào đúng điểm trên biên, chèn đỉnh vào mask kia khi rơi giữa cạnh.
describe('neo: findAnchorTarget + applyAnchor', () => {
  const A = rectangle('A', 0, 0, 100, 100);
  const B = rectangle('B', 100, 0, 200, 100);

  it('trúng đỉnh khi cách ≤ 3 px: dùng đúng đỉnh đó, không chèn gì', () => {
    const target = findAnchorTarget([A], { x: 2, y: 1 }, 10);
    expect(target).toMatchObject({ polygonId: 'A', vertexId: 'A-0', point: { x: 0, y: 0 } });
    const applied = applyAnchor([A], target!);
    expect(applied.polygons[0]).toBe(A);
    expect(applied.nodeId).toBe('A-0');
  });

  it('giữa cạnh: chèn đúng một đỉnh vào cạnh đó, mask khác giữ nguyên', () => {
    const polygons = [A, B];
    const target = findAnchorTarget(polygons, { x: 40, y: 103 }, 10);
    expect(target).toMatchObject({ polygonId: 'A', ring: 0, edgeIndex: 2, point: { x: 40, y: 100 } });
    expect(target!.vertexId).toBeUndefined();
    const applied = applyAnchor(polygons, target!);
    expect(applied.polygons).not.toBe(polygons);
    expect(applied.polygons[0].nodes.map(({ x, y }) => [x, y])).toEqual([[0, 0], [100, 0], [100, 100], [40, 100], [0, 100]]);
    expect(applied.polygons[1]).toBe(B);
    expect(applied.point).toEqual({ x: 40, y: 100 });
  });

  it('neo cả vào biên lỗ', () => {
    const withHole: AnnotationPolygon = {
      ...rectangle('H', 0, 0, 200, 200),
      holes: [[{ id: 'h0', x: 50, y: 50 }, { id: 'h1', x: 150, y: 50 }, { id: 'h2', x: 150, y: 150 }, { id: 'h3', x: 50, y: 150 }]],
    };
    const target = findAnchorTarget([withHole], { x: 100, y: 55 }, 10);
    expect(target).toMatchObject({ polygonId: 'H', ring: 1, edgeIndex: 0, point: { x: 100, y: 50 } });
    const applied = applyAnchor([withHole], target!);
    expect(applied.polygons[0].holes![0].map(({ x, y }) => [x, y])).toEqual([[50, 50], [100, 50], [150, 50], [150, 150], [50, 150]]);
    expect(applied.polygons[0].nodes).toBe(withHole.nodes);
  });

  it('mask khóa: vẫn trả tọa độ neo nhưng không chèn đỉnh', () => {
    const locked = { ...A, meta: { locked: true } };
    const target = findAnchorTarget([locked], { x: 40, y: 103 }, 10)!;
    const applied = applyAnchor([locked], target);
    expect(applied.polygons[0]).toBe(locked);
    expect(applied.point).toEqual({ x: 40, y: 100 });
  });

  it('bỏ qua polygon trong excludeIds; trong mask chỉ neo khi bật inside', () => {
    expect(findAnchorTarget([A], { x: 40, y: 103 }, 10, { excludeIds: new Set(['A']) })).toBeNull();
    expect(findAnchorTarget([A], { x: 50, y: 70 }, 10)).toBeNull();
    expect(findAnchorTarget([A], { x: 50, y: 70 }, 10, { inside: true })).toMatchObject({ polygonId: 'A', point: { x: 50, y: 100 } });
  });

  it('chân vuông góc rơi đúng đầu mút thì coi là trúng đỉnh (không chèn đỉnh trùng)', () => {
    const target = findAnchorTarget([A], { x: 105, y: -5 }, 10)!;
    expect(target.vertexId).toBe('A-1');
    expect(applyAnchor([A], target).polygons[0]).toBe(A);
  });
});

describe('tự hoàn thiện: findCompletionRoute', () => {
  const tA = rectangle('tA', 0, 0, 100, 50);
  const tB = rectangle('tB', 100, 0, 160, 50);
  const far = rectangle('far', 300, 0, 400, 50);

  it('báo lý do khi không có đường', () => {
    const base = { tolerance: 14, context: [{ x: 50, y: 120 }] };
    expect(findCompletionRoute({ ...base, polygons: [tA, tB, far], from: { x: 50, y: 50 }, cursor: { x: 230, y: 120 } })).toEqual({ failure: 'NO_TARGET' });
    expect(findCompletionRoute({ ...base, polygons: [tA, tB, far], from: { x: 50, y: 50 }, cursor: { x: 350, y: 25 } })).toEqual({ failure: 'DISCONNECTED' });
    // Điểm xuất phát giữa đường nối tA|tB (seam), cách biên tự do > dung sai.
    expect(findCompletionRoute({ ...base, polygons: [tA, tB], from: { x: 100, y: 25 }, cursor: { x: 130, y: 25 }, tolerance: 10 })).toEqual({ failure: 'FROM_NOT_ON_FREE_BOUNDARY' });
  });

  it('đi qua chỗ nối, trả các mask thực sự đi dọc theo thứ tự trong mảng', () => {
    const outcome = findCompletionRoute({ polygons: [tB, tA, far], from: { x: 20, y: 50 }, cursor: { x: 140, y: 40 }, tolerance: 14, context: [{ x: 20, y: 120 }, { x: 20, y: 50 }] });
    expect('route' in outcome).toBe(true);
    if (!('route' in outcome)) return;
    expect(outcome.route.nodes.map(({ x, y }) => [x, y])).toEqual([[100, 50], [140, 50]]);
    expect(outcome.route.target).toMatchObject({ polygonId: 'tB', point: { x: 140, y: 50 } });
    expect(outcome.route.ownerIds).toEqual(['tB', 'tA']);
  });
});

/**
 * Hiệu năng trên dữ liệu thật (2026-11-13): cả quả khổ qua trong prelabel là MỘT nhóm ~130 mảnh chạm nhau, nên hợp
 * cả nhóm mỗi lần mảng polygon đổi là quá chậm. Lõi chỉ hợp các mask giao một cửa sổ quanh điểm xuất phát, con trỏ
 * và hình đang dựng, rồi nới ra khi kết quả chưa chắc chắn. Các test sau khóa điều kiện: kết quả PHẢI y như khi hợp
 * cả nhóm, kể cả khi mask đích nằm trong một dãy dài.
 */
describe('tự hoàn thiện: cửa sổ cục bộ cho kết quả như cả nhóm (2026-11-13)', () => {
  /** Dãy `count` ô vuông 100 px chạm nhau thành một nhóm dài (như một quả khổ qua đã vector hóa). */
  const chain = (count: number) => Array.from({ length: count }, (_, index) => rectangle(`c${index}`, index * 100, 0, (index + 1) * 100, 100));

  it('đường dọc biên của dãy 40 mask giống hệt khi chỉ có 3 mask quanh đó', () => {
    const long = chain(40);
    const short = long.slice(10, 13);
    const request = { from: { x: 1050, y: 100 }, cursor: { x: 1180, y: 60 }, tolerance: 14, context: [{ x: 1050, y: 200 }, { x: 1050, y: 100 }] };
    const fromLong = findCompletionRoute({ ...request, polygons: long });
    const fromShort = findCompletionRoute({ ...request, polygons: short });
    expect('route' in fromLong).toBe(true);
    if (!('route' in fromLong) || !('route' in fromShort)) return;
    expect(fromLong.route.nodes.map(({ x, y }) => [x, y])).toEqual(fromShort.route.nodes.map(({ x, y }) => [x, y]));
    expect(fromLong.route.target.point).toEqual(fromShort.route.target.point);
  });

  it('không đi qua seam của mask cùng nhóm nằm ngoài cửa sổ', () => {
    // Đường ngắn nhất từ (1000,0) tới (1000,100) là cạnh dọc x = 1000, nhưng đó là seam c9|c10 nên bị loại.
    const outcome = findCompletionRoute({
      polygons: chain(40), from: { x: 1000, y: 0 }, cursor: { x: 1000, y: 100 }, tolerance: 14,
      context: [{ x: 900, y: -100 }, { x: 1000, y: 0 }],
    });
    expect('route' in outcome).toBe(true);
    if (!('route' in outcome)) return;
    const xs = outcome.route.nodes.map((node) => node.x);
    expect(xs.some((x) => x !== 1000)).toBe(true);
  });

  it('mask xa trong cùng nhóm vẫn nối được (cửa sổ nới theo điểm xuất phát và con trỏ)', () => {
    const long = chain(40);
    const outcome = findCompletionRoute({
      polygons: long, from: { x: 100, y: 100 }, cursor: { x: 3900, y: 60 }, tolerance: 14,
      context: [{ x: 100, y: 300 }, { x: 100, y: 100 }],
    });
    expect('route' in outcome).toBe(true);
    if (!('route' in outcome)) return;
    // Đi dọc biên dưới qua hết dãy tới mask cuối, không cắt ngang qua các mask ở giữa.
    expect(outcome.route.target.polygonId).toBe('c39');
    expect(outcome.route.nodes.every((node) => node.y === 100 || node.x === 4000)).toBe(true);
  });

  it('mask ngoài nhóm vẫn bị từ chối dù nằm trong cửa sổ', () => {
    const near = [rectangle('A', 0, 0, 100, 100), rectangle('B', 120, 0, 220, 100)];
    expect(findCompletionRoute({
      polygons: near, from: { x: 50, y: 100 }, cursor: { x: 170, y: 50 }, tolerance: 14,
      context: [{ x: 50, y: 200 }, { x: 50, y: 100 }],
    })).toEqual({ failure: 'DISCONNECTED' });
  });
});

describe('tự hoàn thiện: mask tự chạm từ prelabel (2026-11-13)', () => {
  // 26% polygon trong drive/prelabel-production tự chạm tại một đỉnh (đo 2026-11-13), nên polygonGeometry trả null.
  const pinched: AnnotationPolygon = polygon('P', [[0, 0], [100, 0], [100, 50], [50, 25], [0, 50]]);
  const neighbour = rectangle('N', 100, 0, 200, 50);

  it('vẫn neo và đi dọc biên mask tự chạm thay vì bỏ qua nó', () => {
    const outcome = findCompletionRoute({
      polygons: [pinched, neighbour], from: { x: 50, y: 0 }, cursor: { x: 100, y: 40 }, tolerance: 14,
      context: [{ x: 50, y: -100 }, { x: 50, y: 0 }],
    });
    expect('route' in outcome).toBe(true);
  });
});

/**
 * Khóa điều kiện quan trọng nhất của cửa sổ cục bộ: nó chỉ được dùng khi cho ĐÚNG kết quả như hợp cả nhóm.
 * So sánh trên cảnh mosaic các mask nhỏ chồng nhau dày (giống prelabel vector hóa từ raster, nơi cả quả là một
 * nhóm hàng trăm mảnh): mỗi truy vấn phải trùng nhau từng điểm, kể cả khi kết quả là một lý do thất bại.
 */
describe('tự hoàn thiện: cửa sổ cục bộ trùng kết quả hợp cả nhóm trên mosaic chồng nhau (2026-11-13)', () => {
  const random = (seed: number) => { let state = seed; return () => (state = (state * 16807) % 2147483647) / 2147483647; };
  /**
   * Dải 2×20 ô 100 px chồng nhau ~10 px, lệch ngẫu nhiên: một nhóm 40 mask trải 1900×190 px — đủ dài để cửa sổ chỉ
   * chứa vài mask, và biên trên/dưới vẫn là biên tự do nên phần lớn truy vấn có đường đi thật.
   */
  const mosaic = () => {
    const next = random(5);
    const polygons: AnnotationPolygon[] = [];
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 20; column += 1) {
        const left = column * 90 + next() * 8;
        const top = row * 90 + next() * 8;
        polygons.push(rectangle(`m${row}-${column}`, left, top, left + 100, top + 100, row % 2 ? 'wart' : 'damage'));
      }
    }
    return polygons;
  };

  it('100 truy vấn ngẫu nhiên: cửa sổ và hợp cả nhóm cho cùng kết quả', () => {
    const polygons = mosaic();
    const next = random(13);
    const simplify = (outcome: ReturnType<typeof findCompletionRoute>) => ('route' in outcome
      ? {
        nodes: outcome.route.nodes.map(({ x, y }) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
        target: outcome.route.target.polygonId,
        point: outcome.route.target.point,
        closes: outcome.route.closesToStart,
        owners: outcome.route.ownerIds,
      }
      : outcome.failure);
    let routes = 0;
    for (let trial = 0; trial < 100; trial += 1) {
      const source = polygons[Math.floor(next() * polygons.length)];
      const from = source.nodes[Math.floor(next() * source.nodes.length)];
      const cursor = { x: from.x + (next() - 0.5) * 320, y: from.y + (next() - 0.5) * 320 };
      const request = {
        from, cursor, tolerance: 14,
        context: [{ x: from.x + (next() - 0.5) * 60, y: from.y + (next() - 0.5) * 60 }, { x: from.x, y: from.y }],
      };
      // Mảng mới mỗi lần để hai bên không dùng chung cache theo danh tính mảng.
      const windowed = simplify(findCompletionRoute({ ...request, polygons: [...polygons] }));
      const whole = simplify(findCompletionRoute({ ...request, polygons: [...polygons], exhaustive: true }));
      expect({ trial, ...(typeof windowed === 'string' ? { windowed } : windowed) })
        .toEqual({ trial, ...(typeof whole === 'string' ? { windowed: whole } : whole) });
      if (typeof windowed !== 'string') routes += 1;
    }
    // Cảnh phải thực sự sinh ra đường đi, không phải toàn thất bại.
    expect(routes).toBeGreaterThan(20);
    // 200 lần dựng mô hình biên (mỗi truy vấn hai mảng mới): ~1 s bình thường, nhưng máy/CI đang tải có thể chậm
    // gấp nhiều lần — timeout rộng để test đúng/sai theo KẾT QUẢ chứ không theo tốc độ máy.
  }, 60_000);
});
