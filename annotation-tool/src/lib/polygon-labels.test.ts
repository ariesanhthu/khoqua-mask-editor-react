import { describe, expect, it } from 'vitest';
import type { AnnotationPolygon } from '@/types';
import { labelsForKind, nextLabel, normalizePolygonInstanceLabels, polygonLabelKind } from './polygon-labels';

const polygon = (label: string, semantic?: string): AnnotationPolygon => ({
  id: label,
  label,
  nodes: [],
  meta: semantic ? { semantic } : undefined,
});

describe('polygon labels', () => {
  it('separates and naturally sorts ridge and wart instance labels', () => {
    const polygons = [polygon('r10'), polygon('w2'), polygon('r2'), polygon('r2'), polygon('w1')];
    expect(labelsForKind(polygons, 'ridge')).toEqual(['r2', 'r10']);
    expect(labelsForKind(polygons, 'wart')).toEqual(['w1', 'w2']);
  });

  it('creates the next available ID after the highest existing label', () => {
    const polygons = [polygon('r1'), polygon('r3'), polygon('w7')];
    expect(nextLabel(polygons, 'ridge')).toBe('r4');
    expect(nextLabel(polygons, 'wart')).toBe('w8');
  });

  it('recognizes legacy prelabel semantics while data is being migrated', () => {
    expect(polygonLabelKind(polygon('main_flesh_band'))).toBe('ridge');
    expect(polygonLabelKind(polygon('legacy', 'wart_flesh'))).toBe('wart');
  });

  it('normalizes every legacy label to the r/w instance format', () => {
    const polygons = [
      polygon('main_flesh_band', 'main_flesh_band'),
      { ...polygon('wart_flesh', 'wart_flesh'), meta: { semantic: 'wart_flesh', wartId: 3 } },
      polygon('v2'),
      polygon('Vùng hư hại'),
    ];
    polygons[0].meta = { semantic: 'main_flesh_band', mainGroupId: 4 };
    expect(normalizePolygonInstanceLabels(polygons).map((item) => item.label)).toEqual(['r4', 'w3', 'r2', 'r1']);
  });
});
