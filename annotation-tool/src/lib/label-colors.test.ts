import { describe, expect, it } from 'vitest';
import { GREEN_END, GREEN_START, labelColor } from './label-colors';

const hueOf = (color: string) => Number(/^hsl\(([\d.]+),/.exec(color)?.[1]);

describe('labelColor (overlay theo label, người dùng xác nhận 2026-11-05)', () => {
  it('gives the same color to every mask with the same label', () => {
    expect(labelColor('r1')).toBe(labelColor('r1'));
    expect(labelColor('R1')).toBe(labelColor(' r1 '));
    expect(labelColor('wart_flesh')).toBe(labelColor('wart_flesh'));
  });

  it('gives different colors to different labels', () => {
    const labels = [...Array.from({ length: 40 }, (_, index) => `r${index + 1}`), ...Array.from({ length: 40 }, (_, index) => `w${index + 1}`), 'damage', 'wart_flesh', ''];
    expect(new Set(labels.map(labelColor)).size).toBe(labels.length);
  });

  it('keeps consecutive numbers of one kind far apart on the hue circle', () => {
    for (const prefix of ['r', 'w']) {
      for (let number = 1; number < 30; number += 1) {
        const difference = Math.abs(hueOf(labelColor(`${prefix}${number}`)) - hueOf(labelColor(`${prefix}${number + 1}`)));
        expect(Math.min(difference, 360 - difference)).toBeGreaterThan(90);
      }
    }
  });

  it('never uses the green hues of the bitter-melon photos', () => {
    const labels = [...Array.from({ length: 200 }, (_, index) => `r${index}`), ...Array.from({ length: 200 }, (_, index) => `w${index}`), 'damage', 'wart_flesh', 'main_flesh_band'];
    for (const label of labels) {
      const hue = hueOf(labelColor(label));
      expect(hue < GREEN_START || hue >= GREEN_END).toBe(true);
    }
  });

  it('returns a valid CSS color that does not depend on other labels', () => {
    expect(labelColor('r1')).toMatch(/^hsl\(\d+(\.\d)?, 78%, \d+%\)$/);
    expect(labelColor(undefined)).toBe(labelColor(''));
  });
});
