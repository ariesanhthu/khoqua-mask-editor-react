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

/**
 * Backing-store scale of the screen-sized canvas layers. Capped at 1.5 (sharp enough, ~2× fewer
 * pixels than 2×); devices reporting < 4 GB (`navigator.deviceMemory`, Chromium only) render at 1×,
 * because every full-screen layer is cleared and composited each frame.
 */
export function renderPixelRatio(devicePixelRatio: number | undefined, deviceMemory?: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio! > 0 ? devicePixelRatio! : 1;
  return Math.min(ratio, deviceMemory !== undefined && deviceMemory < 4 ? 1 : 1.5);
}

/**
 * Downscaled copies of the photo (image pyramid / mipmaps): each level halves the previous one while
 * its longest side is at least 1024 px. Zoomed out, the photo is drawn from the smallest level that
 * still has at least one texel per device pixel, instead of resampling the full image every frame.
 */
export function photoPyramidSizes(width: number, height: number): Array<{ width: number; height: number }> {
  const levels: Array<{ width: number; height: number }> = [];
  let current = { width, height };
  while (Math.max(current.width, current.height) >= 1024 && levels.length < 6) {
    current = { width: Math.max(1, Math.ceil(current.width / 2)), height: Math.max(1, Math.ceil(current.height / 2)) };
    levels.push(current);
  }
  return levels;
}

/** Index into [full image, ...pyramid]: coarsest level whose resolution is still ≥ the screen's. */
export function photoLevelFor(scale: number, ratio: number, levelCount: number) {
  const deviceScale = scale * ratio;
  if (!(deviceScale > 0) || deviceScale >= 0.5 || levelCount <= 1) return 0;
  return Math.max(0, Math.min(levelCount - 1, Math.floor(Math.log2(1 / deviceScale))));
}
