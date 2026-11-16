import { describe, expect, it } from 'vitest';
import { restoreSourceVertices, ringSelfIntersects, segmentsIntersect, type GeometryRing } from './geometry-primitives';

/** Bản tham chiếu O(n²) đúng như vòng lặp cũ của ringSelfIntersects. */
function bruteForce(ring: GeometryRing): boolean {
  for (let first = 0; first < ring.length; first += 1) {
    const firstNext = (first + 1) % ring.length;
    for (let second = first + 1; second < ring.length; second += 1) {
      const secondNext = (second + 1) % ring.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(ring[first], ring[firstNext], ring[second], ring[secondNext])) return true;
    }
  }
  return false;
}

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

describe('ringSelfIntersects dùng lưới cho ring lớn (2026-11-12)', () => {
  it('cho cùng kết quả với vòng lặp O(n²) trên ring ngẫu nhiên đơn và tự cắt', () => {
    const next = random(7);
    for (let trial = 0; trial < 120; trial += 1) {
      const count = 65 + Math.floor(next() * 200);
      const ring: GeometryRing = [];
      for (let index = 0; index < count; index += 1) {
        const angle = (index / count) * Math.PI * 2;
        // Nửa số ring là hình sao (đơn); nửa còn lại có nhiễu lớn nên thường tự cắt.
        const radius = trial % 2 ? 100 + next() * 40 : 20 + next() * 200;
        ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      expect(ringSelfIntersects(ring)).toBe(bruteForce(ring));
    }
  });

  it('phát hiện cả chạm đỉnh (chạm tại một điểm) như bản cũ', () => {
    const ring: GeometryRing = [];
    for (let index = 0; index < 70; index += 1) ring.push([index, index % 2 ? 10 : 0]);
    ring.push([69, 50], [35, 0], [0, 50]);
    expect(ringSelfIntersects(ring)).toBe(bruteForce(ring));
    expect(ringSelfIntersects(ring)).toBe(true);
  });

  /**
   * Contour dày như mask vừa vector hóa KHÔNG được chạy O(n²). Đo theo TỈ LỆ giữa 2 000 và 20 000 đỉnh thay vì
   * mốc giây cố định: tuyến tính ≈ 10×, bậc hai ≈ 100×. Mốc giây cứng (2 s, bản 2026-11-12) phụ thuộc tải máy nên
   * thỉnh thoảng làm CI đỏ oan — đổi 2026-11-16 sau một lần đổ ngẫu nhiên ngay trước khi deploy.
   */
  it('contour dày 20 000 đỉnh như mask vừa vector hóa: không phải O(n²)', () => {
    const contour = (count: number): GeometryRing => {
      const next = random(11);
      const ring: GeometryRing = [];
      for (let index = 0; index < count; index += 1) {
        const angle = (index / count) * Math.PI * 2;
        const radius = 1000 + (next() - 0.5) * 0.2;
        ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      return ring;
    };
    const small = contour(2000);
    const large = contour(20000);
    const time = (ring: GeometryRing) => {
      const started = performance.now();
      expect(ringSelfIntersects(ring)).toBe(false);
      return Math.max(performance.now() - started, 0.5);
    };
    time(small); // làm nóng JIT, bỏ kết quả lần đầu
    const smallMs = time(small);
    const largeMs = time(large);
    // 10× số đỉnh: tuyến tính ~10×, bậc hai ~100×. Ngưỡng 30× rộng rãi nhưng vẫn bắt được hồi quy về O(n²).
    expect(largeMs / smallMs).toBeLessThan(30);
  });

  it('ring răng cưa dày (cạnh dài, xếp sát) vẫn đúng kết quả', () => {
    const ring: GeometryRing = [];
    for (let index = 0; index < 4000; index += 1) {
      const angle = (index / 4000) * Math.PI * 2;
      const radius = 1000 + (index % 2 ? 30 : 0);
      ring.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    expect(ringSelfIntersects(ring)).toBe(false);
    const crossed = [...ring];
    [crossed[10], crossed[2000]] = [crossed[2000], crossed[10]];
    expect(ringSelfIntersects(crossed)).toBe(true);
  });
});

describe('restoreSourceVertices', () => {
  it('giữ id của đỉnh gốc và chèn lại đỉnh gốc thẳng hàng trên cạnh kết quả', () => {
    const source = [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 50, y: 0 }, { id: 'c', x: 100, y: 0 },
      { id: 'd', x: 100, y: 100 }, { id: 'e', x: 0, y: 100 },
    ];
    // Kết quả clipping bỏ đỉnh thẳng hàng 'b' (50,0) và mang id mới.
    const ring = [{ id: 'n1', x: 0, y: 0 }, { id: 'n2', x: 100, y: 0 }, { id: 'n3', x: 100, y: 100 }, { id: 'n4', x: 0, y: 100 }];
    expect(restoreSourceVertices(ring, [source]).map((node) => node.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
