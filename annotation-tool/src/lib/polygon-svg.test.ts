import { describe, expect, it } from 'vitest';
import { polygonSvgPath, summarizePolygons } from './polygon-svg';

const square = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 10, y: 10 }, { id: 'd', x: 0, y: 10 }];
const hole = [{ id: 'e', x: 2.125, y: 2.5 }, { id: 'f', x: 4, y: 2.5 }, { id: 'g', x: 4, y: 4.333 }];

describe('polygonSvgPath', () => {
  it('draws the outer ring and every hole as closed sub-paths for evenodd filling', () => {
    expect(polygonSvgPath({ nodes: square, holes: [hole] }))
      .toBe('M0 0L10 0L10 10L0 10Z M2.13 2.5L4 2.5L4 4.33Z');
  });

  it('skips degenerate rings instead of emitting invalid path data', () => {
    expect(polygonSvgPath({ nodes: square.slice(0, 2) })).toBe('');
    expect(polygonSvgPath({ nodes: square, holes: [hole.slice(0, 1)] })).toBe('M0 0L10 0L10 10L0 10Z');
  });
});

describe('summarizePolygons', () => {
  it('counts polygons and lists distinct labels in natural order', () => {
    const polygons = ['w10', 'r1', 'w2', 'w2'].map((label, index) => ({ id: String(index), label, nodes: square }));
    expect(summarizePolygons(polygons)).toEqual({ polygons: 4, labels: ['r1', 'w2', 'w10'] });
  });
});
