import { expect, it } from 'vitest';
import { photoLevelFor, photoPyramidSizes, renderPixelRatio, zoomViewAt } from './canvas-view';

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

it('caps the layer pixel ratio at 1.5 and renders low-memory devices at 1×', () => {
  expect(renderPixelRatio(1)).toBe(1);
  expect(renderPixelRatio(3)).toBe(1.5);
  expect(renderPixelRatio(1.25, 8)).toBe(1.25);
  expect(renderPixelRatio(2, 4)).toBe(1.5);
  expect(renderPixelRatio(2, 2)).toBe(1);
  expect(renderPixelRatio(0.5, 1)).toBe(0.5);
  expect(renderPixelRatio(undefined)).toBe(1);
  expect(renderPixelRatio(Number.NaN, 8)).toBe(1);
});

it('builds halving pyramid levels for large photos only', () => {
  expect(photoPyramidSizes(800, 500)).toEqual([]);
  expect(photoPyramidSizes(4000, 3000)).toEqual([{ width: 2000, height: 1500 }, { width: 1000, height: 750 }]);
  expect(photoPyramidSizes(2401, 1601)).toEqual([{ width: 1201, height: 801 }, { width: 601, height: 401 }]);
});

it('picks the coarsest pyramid level that keeps at least one texel per device pixel', () => {
  expect(photoLevelFor(1, 1, 3)).toBe(0);
  expect(photoLevelFor(0.6, 1, 3)).toBe(0);
  expect(photoLevelFor(0.5, 1, 3)).toBe(0);
  expect(photoLevelFor(0.49, 1, 3)).toBe(1);
  expect(photoLevelFor(0.3, 1, 3)).toBe(1);
  expect(photoLevelFor(0.24, 1, 3)).toBe(2);
  expect(photoLevelFor(0.05, 1, 3)).toBe(2);
  expect(photoLevelFor(0.3, 1.5, 3)).toBe(1);
  expect(photoLevelFor(0.3, 1, 1)).toBe(0);
  for (const scale of [0.06, 0.13, 0.27, 0.41]) {
    const level = photoLevelFor(scale, 1, 6);
    expect(2 ** -level).toBeGreaterThanOrEqual(scale);
    expect(2 ** -(level + 1)).toBeLessThan(scale);
  }
});
