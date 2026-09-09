import type { AnnotationPolygon } from '@/types';

export type PolygonLabelKind = 'ridge' | 'wart';

const LABEL_PATTERN = /^(r|w)([1-9]\d*)$/i;

export function polygonLabelKind(polygon: Pick<AnnotationPolygon, 'label' | 'meta'>): PolygonLabelKind | null {
  const match = LABEL_PATTERN.exec(polygon.label.trim());
  if (match) return match[1].toLowerCase() === 'r' ? 'ridge' : 'wart';
  if (polygon.meta?.semantic === 'main_flesh_band' || polygon.label === 'main_flesh_band') return 'ridge';
  if (polygon.meta?.semantic === 'wart_flesh' || polygon.label === 'wart_flesh') return 'wart';
  return null;
}

export function labelsForKind(polygons: AnnotationPolygon[], kind: PolygonLabelKind): string[] {
  const prefix = kind === 'ridge' ? 'r' : 'w';
  const labels = new Set<number>();
  for (const polygon of polygons) {
    const match = LABEL_PATTERN.exec(polygon.label.trim());
    if (match?.[1].toLowerCase() === prefix) labels.add(Number(match[2]));
  }
  return [...labels].sort((left, right) => left - right).map((id) => `${prefix}${id}`);
}

export function nextLabel(polygons: AnnotationPolygon[], kind: PolygonLabelKind): string {
  const labels = labelsForKind(polygons, kind);
  const last = labels.at(-1);
  const nextId = last ? Number(last.slice(1)) + 1 : 1;
  return `${kind === 'ridge' ? 'r' : 'w'}${nextId}`;
}

export function semanticForLabelKind(kind: PolygonLabelKind): 'main_flesh_band' | 'wart_flesh' {
  return kind === 'ridge' ? 'main_flesh_band' : 'wart_flesh';
}

function explicitInstanceLabel(polygon: AnnotationPolygon): { kind: PolygonLabelKind; id: number } | null {
  const direct = LABEL_PATTERN.exec(polygon.label.trim());
  if (direct) return { kind: direct[1].toLowerCase() === 'r' ? 'ridge' : 'wart', id: Number(direct[2]) };
  const oldRidge = /^v([1-9]\d*)$/i.exec(polygon.label.trim());
  if (oldRidge) return { kind: 'ridge', id: Number(oldRidge[1]) };
  const kind = polygonLabelKind(polygon);
  const metaId = kind === 'ridge' ? polygon.meta?.mainGroupId : kind === 'wart' ? polygon.meta?.wartId : undefined;
  const id = Number(metaId);
  return kind && Number.isInteger(id) && id > 0 ? { kind, id } : null;
}

export function normalizePolygonInstanceLabels(polygons: AnnotationPolygon[]): AnnotationPolygon[] {
  const used = { ridge: new Set<number>(), wart: new Set<number>() };
  for (const polygon of polygons) {
    const explicit = explicitInstanceLabel(polygon);
    if (explicit) used[explicit.kind].add(explicit.id);
  }

  const nextId = (kind: PolygonLabelKind) => {
    let id = 1;
    while (used[kind].has(id)) id += 1;
    used[kind].add(id);
    return id;
  };

  return polygons.map((polygon) => {
    const explicit = explicitInstanceLabel(polygon);
    const kind = explicit?.kind ?? polygonLabelKind(polygon) ?? 'ridge';
    const id = explicit?.id ?? nextId(kind);
    const label = `${kind === 'ridge' ? 'r' : 'w'}${id}`;
    const semantic = semanticForLabelKind(kind);
    if (polygon.label === label && polygon.meta?.semantic === semantic) return polygon;
    return { ...polygon, label, meta: { ...polygon.meta, semantic } };
  });
}

export function normalizeMaskOperationLabels(operations: unknown[]): unknown[] {
  return operations.map((operation) => {
    if (!operation || typeof operation !== 'object') return operation;
    const candidate = operation as { type?: unknown; polygons?: unknown };
    if (candidate.type !== 'POLYGON_SET' || !Array.isArray(candidate.polygons)) return operation;
    return { ...candidate, polygons: normalizePolygonInstanceLabels(candidate.polygons as AnnotationPolygon[]) };
  });
}
