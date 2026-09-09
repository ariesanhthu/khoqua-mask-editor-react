import type { BreakpointAnnotation } from '@/types';

export function validWartPoints(value: unknown, complete = false): value is BreakpointAnnotation {
  if (!value || typeof value !== 'object') return false;
  const data = value as BreakpointAnnotation;
  if (!['NOT_ANNOTATED', 'ANNOTATED', 'CONFIRMED_NONE'].includes(data.state) || !Array.isArray(data.points)) return false;
  if (complete && data.state === 'NOT_ANNOTATED') return false;
  if ((data.state === 'ANNOTATED') !== (data.points.length > 0)) return false;
  const ids = new Set<string>();
  return data.points.every((point) => {
    if (!point || typeof point.id !== 'string' || !point.id || ids.has(point.id)
      || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) return false;
    ids.add(point.id);
    return true;
  });
}
