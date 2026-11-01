import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '../types/index';
import { MaskVectorizer, rasterizePolygons } from './mask-pixels';
import { packedTransfer, packGeometry, packPolygons, unpackGeometry, unpackPolygons } from './polygon-pack';

function tracedPolygons() {
  const width = 90; const height = 60;
  const vectorizer = new MaskVectorizer(width, height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const inBody = (x - 30) ** 2 + (y - 30) ** 2 < 400;
    const inHole = (x - 30) ** 2 + (y - 30) ** 2 < 36;
    const speck = x >= 70 && x < 73 && y >= 10 && y < 12;
    vectorizer.pixels[y * width + x] = (inBody && !inHole) || speck ? 255 : 0;
  }
  vectorizer.markAllDirty();
  return { polygons: vectorizer.vectorize('mask-g1-r3'), width, height };
}

describe('polygon packing for worker messages', () => {
  it('round-trips vectorizer output exactly, including holes and JSON key order', () => {
    const { polygons } = tracedPolygons();
    expect(polygons.some((polygon) => polygon.holes?.length)).toBe(true);
    const packed = packPolygons(polygons);
    expect(packed.nodeIds).toBeUndefined();
    expect(packed.metas).toBeUndefined();
    const restored = unpackPolygons(structuredClone(packed));
    expect(restored).toEqual(polygons);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(polygons));
  });

  it('falls back to explicit node ids and keeps meta, missing holes and empty holes', () => {
    const custom: AnnotationPolygon[] = [
      { id: 'r1', label: 'r1', nodes: [{ id: 'a', x: 1, y: 1 }, { id: 'b', x: 5.125, y: 1 }, { id: 'c', x: 5, y: 4.5 }], meta: { semantic: 'main_flesh_band', locked: true } },
      { id: 'w2', label: 'w2', nodes: [{ id: 'w2-outer-0', x: 0, y: 0 }, { id: 'w2-outer-1', x: 2, y: 0 }, { id: 'w2-outer-2', x: 2, y: 2 }], holes: [] },
    ];
    const packed = packPolygons(custom);
    expect(packed.nodeIds).toEqual(['a', 'b', 'c', 'w2-outer-0', 'w2-outer-1', 'w2-outer-2']);
    const restored = unpackPolygons(packed);
    expect(restored).toEqual(custom);
    expect('holes' in restored[0]).toBe(false);
    expect(restored[1].holes).toEqual([]);
  });

  it('transfers geometry that rasterizes to the same pixels', () => {
    const { polygons, width, height } = tracedPolygons();
    const geometry = packGeometry(polygons);
    expect(packedTransfer(geometry)).toHaveLength(3);
    expect(rasterizePolygons(unpackGeometry(geometry), width, height)).toEqual(rasterizePolygons(polygons, width, height));
    expect(unpackGeometry(packGeometry([]))).toEqual([]);
  });
});
