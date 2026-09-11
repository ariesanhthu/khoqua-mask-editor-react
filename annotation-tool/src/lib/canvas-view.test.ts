import { expect, it } from 'vitest';
import { zoomViewAt } from './canvas-view';

it('keeps the image coordinate under the cursor through repeated zoom and scale limits', () => {
  let view = { scale: 0.7, x: -123.25, y: 38.75 };
  const anchor = { x: 713.125, y: 92.375 };
  const image = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };
  for (const factor of [1.1, 0.8, 1000, 1.2, 0.00001, 0.5, 2]) {
    view = zoomViewAt(view, factor, anchor);
    expect(image.x * view.scale + view.x).toBeCloseTo(anchor.x, 9);
    expect(image.y * view.scale + view.y).toBeCloseTo(anchor.y, 9);
    expect(view.scale).toBeGreaterThanOrEqual(0.05);
    expect(view.scale).toBeLessThanOrEqual(20);
  }
});
