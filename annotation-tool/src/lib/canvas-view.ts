export function zoomViewAt(
  view: { scale: number; x: number; y: number },
  factor: number,
  anchor: { x: number; y: number },
) {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const scale = Math.max(0.05, Math.min(20, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio };
}
