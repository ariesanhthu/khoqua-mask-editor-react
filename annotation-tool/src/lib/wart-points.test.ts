import { expect, it } from 'vitest';
import { validWartPoints } from './wart-points';

it('accepts saved draft, points and explicitly confirmed absence', () => {
  expect(validWartPoints({ state: 'NOT_ANNOTATED', points: [] })).toBe(true);
  expect(validWartPoints({ state: 'NOT_ANNOTATED', points: [] }, true)).toBe(false);
  expect(validWartPoints({ state: 'CONFIRMED_NONE', points: [] }, true)).toBe(true);
  expect(validWartPoints({ state: 'ANNOTATED', points: [{ id: 'a', x: 1.5, y: 2 }] }, true)).toBe(true);
});

it('rejects invalid coordinates, duplicate ids and inconsistent states', () => {
  const point = { id: 'a', x: 1, y: 2 };
  for (const points of [[{ ...point, x: NaN }], [{ ...point, y: -1 }], [point, point], [null], []]) {
    expect(validWartPoints({ state: 'ANNOTATED', points }, true)).toBe(false);
  }
  expect(validWartPoints({ state: 'CONFIRMED_NONE', points: [point] }, true)).toBe(false);
});
