import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '../types/index';
import {
  compactPolygon, forEachPolygonSpan, MaskVectorizer, normalizeMaskRgba, polygonPixelRect, rasterizePolygons, simplifyRing,
  smoothPolygon, vectorizeBinaryMask, vectorizeContourMask,
} from './mask-pixels';

function disc(width: number, height: number, cx: number, cy: number, radius: number, pixels: Uint8Array = new Uint8Array(width * height), value = 255) {
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2) pixels[y * width + x] = value;
  }
  return pixels;
}

describe('incremental mask vectorizer', () => {
  it('matches a full exact vectorization after local edits that join, split and punch holes', () => {
    const width = 120; const height = 80;
    const vectorizer = new MaskVectorizer(width, height, false);
    disc(width, height, 30, 40, 15, vectorizer.pixels);
    disc(width, height, 90, 40, 15, vectorizer.pixels);
    vectorizer.markAllDirty();
    expect(vectorizer.vectorize()).toHaveLength(2);
    const edit = (left: number, top: number, right: number, bottom: number, value: number) => {
      for (let y = top; y < bottom; y += 1) vectorizer.pixels.fill(value, y * width + left, y * width + right);
      vectorizer.markDirty({ left, top, right, bottom });
      const polygons = vectorizer.vectorize();
      expect(rasterizePolygons(polygons, width, height)).toEqual(vectorizer.pixels);
      expect(polygons.length).toBe(vectorizeBinaryMask(vectorizer.pixels, width, height).length);
      return polygons;
    };
    expect(edit(40, 38, 82, 42, 255)).toHaveLength(1); // bridge joins both discs
    expect(edit(58, 0, 62, height, 0)).toHaveLength(2); // cut splits them again
    const holed = edit(88, 38, 92, 42, 0); // hole inside the right disc
    expect(holed.flatMap((polygon) => polygon.holes ?? [])).toHaveLength(1);
    expect(edit(5, 5, 8, 8, 255)).toHaveLength(3); // far-away speck leaves others untouched
  });

  it('stays exact and loses no region across many random brush/erase strokes on a spiky mask', () => {
    let state = 12345;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const width = 140; const height = 100;
    const exact = new MaskVectorizer(width, height, false);
    const smooth = new MaskVectorizer(width, height);
    // One large connected body with many thin spikes, like a bitter-melon ridge mask.
    disc(width, height, 70, 50, 30, exact.pixels);
    for (let spike = 0; spike < 40; spike += 1) {
      const angle = random() * Math.PI * 2;
      for (let step = 25; step < 48; step += 0.5) {
        const x = Math.floor(70 + Math.cos(angle) * step); const y = Math.floor(50 + Math.sin(angle) * step);
        if (x >= 0 && y >= 0 && x < width && y < height) exact.pixels[y * width + x] = 255;
      }
    }
    smooth.pixels.set(exact.pixels);
    for (const vectorizer of [exact, smooth]) { vectorizer.markAllDirty(); vectorizer.vectorize('init'); }
    for (let stroke = 0; stroke < 50; stroke += 1) {
      const cx = random() * width; const cy = random() * height; const radius = 1 + random() * 7;
      const value = random() < 0.5 ? 255 : 0;
      for (const vectorizer of [exact, smooth]) {
        disc(width, height, cx, cy, radius, vectorizer.pixels, value);
        vectorizer.markDirty({ left: cx - radius - 1, top: cy - radius - 1, right: cx + radius + 1, bottom: cy + radius + 1 });
      }
      // Background passes happen at arbitrary points between strokes.
      if (random() < 0.6) {
        const polygons = exact.vectorize(`s${stroke}`);
        expect(rasterizePolygons(polygons, width, height)).toEqual(exact.pixels);
        expect(new Set(polygons.map((polygon) => polygon.id)).size).toBe(polygons.length);
        const smoothed = smooth.vectorize(`s${stroke}`);
        const raster = rasterizePolygons(smoothed, width, height);
        let covered = 0; let foreground = 0;
        for (let index = 0; index < raster.length; index += 1) {
          if (smooth.pixels[index]) { foreground += 1; if (raster[index]) covered += 1; }
        }
        expect(covered / Math.max(1, foreground)).toBeGreaterThan(0.9);
      }
    }
  }, 30000);
});

describe('smooth contours', () => {
  it('follows a round shape with more vertices than stair corners and near-identical coverage', () => {
    const width = 100; const height = 100;
    const pixels = disc(width, height, 50, 50, 30);
    const exact = vectorizeBinaryMask(pixels, width, height);
    const vectorizer = new MaskVectorizer(width, height);
    vectorizer.pixels.set(pixels);
    vectorizer.markAllDirty();
    const [smooth] = vectorizer.vectorize();
    const covered = rasterizePolygons([smooth], width, height);
    let mismatch = 0; let area = 0;
    for (let i = 0; i < pixels.length; i += 1) { if (pixels[i]) area += 1; if (Boolean(covered[i]) !== Boolean(pixels[i])) mismatch += 1; }
    expect(mismatch / area).toBeLessThan(0.02);
    // No axis-aligned stair steps: consecutive edges never turn by a right angle.
    const nodes = smooth.nodes;
    const turns = nodes.map((p, i) => {
      const a = nodes[(i + nodes.length - 1) % nodes.length]; const b = nodes[(i + 1) % nodes.length];
      const u = { x: p.x - a.x, y: p.y - a.y }; const v = { x: b.x - p.x, y: b.y - p.y };
      return Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y));
    });
    expect(Math.max(...turns)).toBeLessThan(Math.PI / 6);
    expect(nodes.length).toBeGreaterThan(40);
    expect(exact[0].nodes.length).toBeGreaterThan(0);
  });

  it('keeps tiny or one-pixel-thin shapes unchanged and smooths saved stair polygons on demand', () => {
    const line = new Uint8Array(40 * 3); line.fill(255, 40, 80);
    const [thin] = vectorizeBinaryMask(line, 40, 3);
    expect(smoothPolygon(thin)).toBe(thin);
    const [round] = vectorizeBinaryMask(disc(60, 60, 30, 30, 20), 60, 60);
    const smoothed = smoothPolygon(round, { width: 60, height: 60 });
    expect(smoothed).not.toBe(round);
    expect(smoothed.id).toBe(round.id);
    expect(new Set(smoothed.nodes.map((node) => node.id)).size).toBe(smoothed.nodes.length);
  });
});

describe('lossless mask conversion', () => {
  it('converts contours with half-pixel diagonals while preserving all 3x3 patterns', () => {
    for (let pattern = 0; pattern < 512; pattern += 1) {
      const pixels = Uint8Array.from({ length: 9 }, (_, i) => pattern & (1 << i) ? 255 : 0);
      expect(rasterizePolygons(vectorizeContourMask(pixels, 3, 3), 3, 3), `pattern ${pattern}`).toEqual(pixels);
    }
    expect(vectorizeContourMask(Uint8Array.of(255), 1, 1)[0].nodes.some(p => p.x === 0.5)).toBe(true);
  });
  it('round-trips every 3x3 binary pattern including diagonal contacts, isolated pixels and holes', () => {
    for (let pattern = 0; pattern < 512; pattern += 1) {
      const pixels = Uint8Array.from({ length: 9 }, (_, i) => pattern & (1 << i) ? 255 : 0);
      const polygons = vectorizeBinaryMask(pixels, 3, 3);
      expect(rasterizePolygons(polygons, 3, 3), `pattern ${pattern}`).toEqual(pixels);
      for (const polygon of polygons) for (const ring of [polygon.nodes, ...(polygon.holes ?? [])]) {
        expect(new Set(ring.map((p) => `${p.x},${p.y}`)).size).toBe(ring.length);
      }
    }
  });

  it('preserves a 1px groove on a 1200px image, a 1px island and interior holes', () => {
    const width = 1200; const height = 20;
    const pixels = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < height; y += 1) pixels[y * width + 600] = 0;
    for (let y = 5; y < 15; y += 1) pixels.fill(0, y * width + 10, y * width + 20);
    pixels[10 * width + 15] = 255;
    const polygons = vectorizeBinaryMask(pixels, width, height);
    expect(new Set(polygons.map((p) => p.label)).size).toBe(3);
    expect(polygons.flatMap((p) => p.holes ?? []).length).toBe(1);
    expect(rasterizePolygons(polygons, width, height)).toEqual(pixels);
  });

  it('does not merge foreground regions that only touch diagonally', () => {
    const polygons = vectorizeBinaryMask(Uint8Array.from([255, 0, 0, 255]), 2, 2);
    expect(polygons.map((p) => p.label)).toEqual(['w1', 'w2']);
  });

  it('uses pixel-center membership for subpixel diagonal edges without antialias accumulation', () => {
    const polygon = { id: 'p', label: 'w1', nodes: [{ id: 'a', x: 0.49, y: 0 }, { id: 'b', x: 1.49, y: 0 }, { id: 'c', x: 1.49, y: 4 }, { id: 'd', x: 0.49, y: 4 }] };
    expect([...rasterizePolygons([polygon], 3, 4)]).toEqual([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]);
  });
});

describe('compact contours for prelabel import', () => {
  const vertexCount = (polygons: AnnotationPolygon[]) => polygons.reduce((sum, p) => sum + p.nodes.length + (p.holes ?? []).reduce((s, r) => s + r.length, 0), 0);
  const mismatch = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, value, i) => sum + (Boolean(value) !== Boolean(b[i]) ? 1 : 0), 0);
  /** Every pair of edges (except consecutive ones of a ring) is disjoint, and holes lie inside the outer ring. */
  function expectValid(polygon: AnnotationPolygon) {
    const rings = [polygon.nodes, ...(polygon.holes ?? [])];
    const edges = rings.flatMap((ring, r) => ring.map((a, i) => ({ r, i, n: ring.length, a, b: ring[(i + 1) % ring.length] })));
    const side = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    for (let i = 0; i < edges.length; i += 1) for (let j = i + 1; j < edges.length; j += 1) {
      const e = edges[i]; const f = edges[j];
      if (e.r === f.r && (j - i === 1 || j - i === e.n - 1)) continue;
      const touching = side(e.a, e.b, f.a) * side(e.a, e.b, f.b) <= 0 && side(f.a, f.b, e.a) * side(f.a, f.b, e.b) <= 0
        && Math.max(Math.min(e.a.x, e.b.x), Math.min(f.a.x, f.b.x)) <= Math.min(Math.max(e.a.x, e.b.x), Math.max(f.a.x, f.b.x))
        && Math.max(Math.min(e.a.y, e.b.y), Math.min(f.a.y, f.b.y)) <= Math.min(Math.max(e.a.y, e.b.y), Math.max(f.a.y, f.b.y));
      expect(touching, `${polygon.id} edges ${i}/${j}`).toBe(false);
    }
    const ids = rings.flat().map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(polygon.nodes.every((node, i) => node.id === `${polygon.id}-outer-${i}`)).toBe(true);
  }

  it('cuts a round region to a fraction of the exact vertices with near-identical pixels', () => {
    const width = 200; const height = 160;
    const pixels = disc(width, height, 100, 80, 60);
    disc(width, height, 90, 70, 12, pixels, 0); // a hole
    const [exact] = vectorizeBinaryMask(pixels, width, height, 'img');
    const compact = compactPolygon(exact, 1);
    expect(compact.id).toBe(exact.id);
    expect(compact.label).toBe(exact.label);
    expect(compact.holes).toHaveLength(1);
    expect(vertexCount([compact])).toBeLessThan(vertexCount([exact]) / 4);
    let area = 0; pixels.forEach((value) => { if (value) area += 1; });
    // Only boundary pixels may flip (deviation ≤ 1 px from the half-pixel contour).
    expect(mismatch(rasterizePolygons([compact], width, height), pixels) / area).toBeLessThan(0.02);
    expectValid(compact);
  });

  it('keeps tiny and one-pixel-thin regions on their pixels', () => {
    const width = 30; const height = 12;
    const pixels = new Uint8Array(width * height);
    pixels[2 * width + 2] = 255; // one pixel
    pixels.fill(255, 5 * width + 3, 5 * width + 27); // 1px line
    pixels.fill(255, 9 * width + 4, 9 * width + 6); // two pixels
    const exact = vectorizeBinaryMask(pixels, width, height);
    const compact = exact.map((polygon) => compactPolygon(polygon, 1));
    expect(compact).toHaveLength(3);
    expect(rasterizePolygons(compact, width, height)).toEqual(pixels);
    compact.forEach(expectValid);
  });

  it('never lets a hole cross or leave the outer ring across a one-pixel wall', () => {
    const width = 60; const height = 40;
    const pixels = new Uint8Array(width * height);
    for (let y = 5; y < 35; y += 1) pixels.fill(255, y * width + 5, y * width + 55);
    // Jagged hole one pixel away from the top and left edges.
    for (let y = 7; y < 30; y += 1) pixels.fill(0, y * width + 7, y * width + 20 + (y % 3) * 4);
    const [exact] = vectorizeBinaryMask(pixels, width, height);
    for (const tolerance of [1, 1.5, 3]) {
      const compact = compactPolygon(exact, tolerance);
      expect(compact.holes).toHaveLength(1);
      expectValid(compact);
    }
    // A round body keeps its compact outline even when a groove beside a 1px wall must stay exact.
    const round = disc(120, 120, 60, 60, 50);
    const left = (y: number) => round.indexOf(255, y * 120) - y * 120;
    for (let y = 45; y < 75; y += 1) {
      // Thin wall at the left edge that stays 4-connected between rows (1–3px wide).
      const wall = Math.max(left(y - 1), left(y), left(y + 1));
      round.fill(0, y * 120 + wall + 1 + (y % 2), y * 120 + 45);
    }
    const [body] = vectorizeBinaryMask(round, 120, 120);
    const compactBody = compactPolygon(body, 1);
    expect(compactBody.holes).toHaveLength(1);
    expect(compactBody.nodes.length).toBeLessThan(body.nodes.length / 3);
    expectValid(compactBody);
  });

  it('keeps separate regions apart and every region present on random blob masks', () => {
    let state = 77;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const width = 160; const height = 120;
    for (let scene = 0; scene < 6; scene += 1) {
      const pixels = new Uint8Array(width * height);
      for (let blob = 0; blob < 25; blob += 1) disc(width, height, random() * width, random() * height, 1 + random() * 14, pixels, random() < 0.75 ? 255 : 0);
      const exact = vectorizeBinaryMask(pixels, width, height, `s${scene}`);
      const compact = exact.map((polygon) => compactPolygon(polygon, 1));
      expect(vertexCount(compact)).toBeLessThan(vertexCount(exact));
      const owners = new Uint8Array(width * height);
      compact.forEach((polygon, index) => {
        expectValid(polygon);
        const own = rasterizePolygons([polygon], width, height);
        const truth = rasterizePolygons([exact[index]], width, height);
        let truthArea = 0; let wrong = 0;
        for (let i = 0; i < own.length; i += 1) {
          if (own[i]) owners[i] += 1;
          if (truth[i]) truthArea += 1;
          if (Boolean(own[i]) !== Boolean(truth[i])) wrong += 1;
        }
        expect(wrong / truthArea, `${polygon.id}`).toBeLessThan(0.35);
      });
      expect(owners.some((count) => count > 1), `scene ${scene}`).toBe(false);
    }
  });
});

/** Verbatim copy of rasterizePolygons before the span refactor (2026-10-25): the pixel reference. */
function referenceRasterize(polygons: AnnotationPolygon[], width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  for (const polygon of polygons) {
    const rings = [polygon.nodes, ...(polygon.holes ?? [])];
    const crossings = new Map<number, number[]>();
    for (const ring of rings) {
      if (ring.length < 3) throw new Error('Polygon ring needs at least three nodes');
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i]; const b = ring[(i + 1) % ring.length];
        if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) throw new Error('Invalid polygon coordinates');
        if (a.y === b.y) continue;
        const from = Math.max(0, Math.ceil(Math.min(a.y, b.y) - 0.5));
        const to = Math.min(height, Math.ceil(Math.max(a.y, b.y) - 0.5));
        for (let y = from; y < to; y += 1) {
          const x = a.x + (y + 0.5 - a.y) * (b.x - a.x) / (b.y - a.y);
          const row = crossings.get(y);
          if (row) row.push(x); else crossings.set(y, [x]);
        }
      }
    }
    for (const [y, row] of crossings) {
      row.sort((a, b) => a - b);
      for (let i = 0; i + 1 < row.length; i += 2) {
        const start = Math.max(0, Math.ceil(row[i] - 0.5));
        const end = Math.min(width, Math.ceil(row[i + 1] - 0.5));
        if (start < end) pixels.fill(255, y * width + start, y * width + end);
      }
    }
  }
  return pixels;
}

function randomPolygons(seed: number, count: number, width: number, height: number): AnnotationPolygon[] {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, (_, index) => {
    const cx = random() * width * 1.2 - width * 0.1; const cy = random() * height * 1.2 - height * 0.1;
    const ring = (radius: number, prefix: string, count = 3 + Math.floor(random() * 14)) => Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      const r = radius * (0.4 + random() * 0.8);
      // Fractional, half-pixel and out-of-image coordinates on purpose.
      return { id: `${prefix}-${i}`, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
    });
    const radius = 2 + random() * 25;
    return { id: `p${index}`, label: `w${index + 1}`, nodes: ring(radius, `p${index}`), holes: random() < 0.4 ? [ring(radius * 0.3, `h${index}`)] : undefined };
  });
}

describe('span rasterizer, pixel rect and display helpers', () => {
  it('rasterizes exactly like the previous implementation (holes, overlaps, fractional and out-of-bounds nodes)', () => {
    let covered = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const polygons = randomPolygons(seed, 1 + (seed % 9), 97, 61);
      const actual = rasterizePolygons(polygons, 97, 61);
      const expected = referenceRasterize(polygons, 97, 61);
      let mismatches = 0;
      for (let index = 0; index < expected.length; index += 1) {
        if (actual[index] !== expected[index]) mismatches += 1;
        if (expected[index]) covered += 1;
      }
      expect(mismatches, `seed ${seed}`).toBe(0);
    }
    expect(covered).toBeGreaterThan(10_000); // the random scenes really cover pixels
    expect(() => rasterizePolygons([{ id: 'x', label: 'w1', nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 1 }] }], 4, 4)).toThrow(/three nodes/);
    expect(() => rasterizePolygons([{ id: 'x', label: 'w1', nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: NaN, y: 1 }, { id: 'c', x: 2, y: 2 }] }], 4, 4)).toThrow(/Invalid polygon/);
  });

  it('emits the same runs as the full raster when clipped to a rectangle', () => {
    const width = 80; const height = 50;
    for (let seed = 3; seed <= 30; seed += 1) {
      const polygons = randomPolygons(seed, 5, width, height);
      const full = rasterizePolygons(polygons, width, height);
      const rect = { left: seed % 17, top: seed % 11, right: width - (seed % 13), bottom: height - (seed % 7) };
      const clipped = new Uint8Array(width * height);
      let outOfRect = 0;
      forEachPolygonSpan(polygons, rect, (y, start, end) => {
        if (y < rect.top || y >= rect.bottom || start < rect.left || end > rect.right) outOfRect += 1;
        clipped.fill(255, y * width + start, y * width + end);
      });
      const mismatches: string[] = [];
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const inside = x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
        if (clipped[y * width + x] !== (inside ? full[y * width + x] : 0)) mismatches.push(`${x},${y}`);
      }
      expect({ outOfRect, mismatches }, `seed ${seed}`).toEqual({ outOfRect: 0, mismatches: [] });
    }
  });

  it('bounds every covered pixel with polygonPixelRect and returns null when nothing is covered', () => {
    const width = 90; const height = 70;
    for (let seed = 50; seed <= 80; seed += 1) {
      const polygons = randomPolygons(seed, 3, width, height);
      const pixels = rasterizePolygons(polygons, width, height);
      const rect = polygonPixelRect(polygons, width, height);
      let outside = 0;
      pixels.forEach((value, index) => {
        if (!value) return;
        const x = index % width; const y = Math.floor(index / width);
        if (!rect || x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) outside += 1;
      });
      expect(outside, `seed ${seed}`).toBe(0);
    }
    expect(polygonPixelRect([], 10, 10)).toBeNull();
    const subpixel = { id: 's', label: 'w1', nodes: [{ id: 'a', x: 2.1, y: 2.1 }, { id: 'b', x: 2.4, y: 2.1 }, { id: 'c', x: 2.4, y: 2.4 }] };
    expect(polygonPixelRect([subpixel], 10, 10)).toBeNull();
    const outside = { id: 'o', label: 'w1', nodes: [{ id: 'a', x: -9, y: -9 }, { id: 'b', x: -2, y: -9 }, { id: 'c', x: -2, y: -2 }] };
    expect(polygonPixelRect([outside], 10, 10)).toBeNull();
  });

  it('normalizes decoded mask RGBA exactly like the per-byte threshold', () => {
    let state = 9;
    const random = () => (state = (state * 16807) % 2147483647) % 256;
    const data = new Uint8ClampedArray(4 * 2000).map(() => random());
    // Edge cases around the thresholds: alpha 0/1, brightest channel 96/97.
    data.set([97, 0, 0, 1, 96, 96, 96, 255, 255, 255, 255, 0, 0, 0, 97, 2], 0);
    const expected = new Uint8ClampedArray(data);
    for (let offset = 0; offset < expected.length; offset += 4) {
      const visible = expected[offset + 3] > 0 && Math.max(expected[offset], expected[offset + 1], expected[offset + 2]) > 96;
      expected.set([255, 255, 255, visible ? 255 : 0], offset);
    }
    normalizeMaskRgba(data);
    expect(data).toEqual(expected);
    expect([...data.slice(0, 16)]).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 255]);
  });

  it('keeps level-of-detail outlines within 1.5 × tolerance of a dense smooth contour', () => {
    const ring = Array.from({ length: 2000 }, (_, i) => {
      const angle = (i / 2000) * Math.PI * 2;
      const radius = 300 + 20 * Math.sin(angle * 7);
      return { x: 500 + Math.cos(angle) * radius, y: 400 + Math.sin(angle) * radius };
    });
    for (const tolerance of [0.35, 1.4, 5.6]) {
      const simplified = simplifyRing(ring, tolerance);
      expect(simplified.length).toBeLessThan(ring.length / 4);
      expect(simplified.length).toBeGreaterThanOrEqual(3);
      for (const point of ring) {
        let best = Infinity;
        for (let i = 0; i < simplified.length; i += 1) {
          const a = simplified[i]; const b = simplified[(i + 1) % simplified.length];
          const dx = b.x - a.x; const dy = b.y - a.y; const length = dx * dx + dy * dy;
          const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
          best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
        }
        expect(best).toBeLessThanOrEqual(tolerance * 1.5 + 1e-9);
      }
    }
  });
});
