import { describe, expect, it } from 'vitest';
import { GREEN_END, GREEN_START, labelColor } from './label-colors';
import { NEUTRAL_OVERLAY_COLOR, WARM_COOL_RANGE, overlayColor, overlayLabelInstance, reviewLabelSummary } from './review-colors';

/** Lớp phủ trang duyệt (người dùng yêu cầu 2026-11-24): Xanh – Đỏ và Nóng – Lạnh, chỉ tách r* / w*. */
const parse = (color: string) => {
  const match = /^hsl\(([\d.]+), (\d+)%, (\d+)%\)$/.exec(color);
  if (!match) throw Error(`not hsl: ${color}`);
  return { hue: Number(match[1]), saturation: Number(match[2]), lightness: Number(match[3]) };
};
/** Khoảng cách trên vòng màu. */
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
/** Hue nằm trong dải [start, start + span] (đi theo chiều tăng, có thể qua 0°). */
const inRange = (hue: number, range: { start: number; span: number }) => ((hue - range.start + 360) % 360) <= range.span + 1e-6;
const ridges = Array.from({ length: 60 }, (_, index) => `r${index + 1}`);
const warts = Array.from({ length: 60 }, (_, index) => `w${index + 1}`);

describe('overlayLabelInstance', () => {
  it('reads r*/w* instance labels and the legacy semantic labels, nothing else', () => {
    expect(overlayLabelInstance('r3')).toEqual({ kind: 'ridge', index: 3 });
    expect(overlayLabelInstance(' W12 ')).toEqual({ kind: 'wart', index: 12 });
    expect(overlayLabelInstance('main_flesh_band')).toEqual({ kind: 'ridge', index: 0 });
    expect(overlayLabelInstance('wart_flesh')).toEqual({ kind: 'wart', index: 0 });
    for (const other of ['', 'r0', 'r', 'damage', 'x1', 'v1', undefined, null]) expect(overlayLabelInstance(other)).toBeNull();
  });
});

describe('reviewLabelSummary', () => {
  it('counts masks per kind and lists each label once in numeric order', () => {
    const summary = reviewLabelSummary([
      { label: 'r10' }, { label: 'r2' }, { label: 'R2' }, { label: 'w1' }, { label: 'main_flesh_band' }, { label: '' }, { label: 'damage' },
    ]);
    expect(summary).toEqual({
      ridge: { masks: 4, labels: ['main_flesh_band', 'r2', 'r10'] },
      wart: { masks: 1, labels: ['w1'] },
      other: 2,
    });
    expect(reviewLabelSummary([])).toEqual({ ridge: { masks: 0, labels: [] }, wart: { masks: 0, labels: [] }, other: 0 });
  });
});

describe('overlayColor', () => {
  it('label mode is exactly the editor colouring (editor behaviour unchanged)', () => {
    for (const label of [...ridges.slice(0, 5), ...warts.slice(0, 5), 'damage', '']) {
      expect(overlayColor(label, 'label')).toBe(labelColor(label));
      expect(overlayColor(label)).toBe(labelColor(label));
    }
  });

  it('keeps one colour per label in every mode (two masks with the same label look the same)', () => {
    for (const mode of ['twoTone', 'warmCool'] as const) {
      expect(overlayColor('r1', mode)).toBe(overlayColor(' R1 ', mode));
      expect(overlayColor('w7', mode)).toBe(overlayColor('w7', mode));
    }
  });

  it('Xanh – Đỏ: every ridge is a close shade of red, every wart a close shade of blue', () => {
    for (const label of ridges) {
      const { hue, lightness } = parse(overlayColor(label, 'twoTone'));
      expect(hueGap(hue, 0)).toBeLessThanOrEqual(8);
      expect(lightness).toBeGreaterThanOrEqual(44);
      expect(lightness).toBeLessThanOrEqual(62);
    }
    for (const label of warts) {
      const { hue, lightness } = parse(overlayColor(label, 'twoTone'));
      expect(hueGap(hue, 218)).toBeLessThanOrEqual(8);
      expect(lightness).toBeGreaterThanOrEqual(44);
      expect(lightness).toBeLessThanOrEqual(62);
    }
  });

  it('Xanh – Đỏ: neighbouring labels are near but not identical shades; the two kinds are far apart', () => {
    for (let index = 1; index < 4; index += 1) {
      const current = parse(overlayColor(`r${index}`, 'twoTone'));
      const next = parse(overlayColor(`r${index + 1}`, 'twoTone'));
      expect(overlayColor(`r${index}`, 'twoTone')).not.toBe(overlayColor(`r${index + 1}`, 'twoTone'));
      expect(hueGap(current.hue, next.hue)).toBeLessThanOrEqual(5);
    }
    for (const ridge of ridges) for (const wart of warts.slice(0, 10)) {
      expect(hueGap(parse(overlayColor(ridge, 'twoTone')).hue, parse(overlayColor(wart, 'twoTone')).hue)).toBeGreaterThan(120);
    }
  });

  it('Nóng – Lạnh: ridges stay in the warm band, warts in the cool band', () => {
    for (const label of ridges) expect(inRange(parse(overlayColor(label, 'warmCool')).hue, WARM_COOL_RANGE.hot)).toBe(true);
    for (const label of warts) expect(inRange(parse(overlayColor(label, 'warmCool')).hue, WARM_COOL_RANGE.cold)).toBe(true);
  });

  it('Nóng – Lạnh: each label inside a group gets its own clearly different colour', () => {
    for (const labels of [ridges, warts]) {
      expect(new Set(labels.map((label) => overlayColor(label, 'warmCool'))).size).toBe(labels.length);
      for (let index = 0; index < labels.length - 1; index += 1) {
        const current = parse(overlayColor(labels[index], 'warmCool'));
        const next = parse(overlayColor(labels[index + 1], 'warmCool'));
        expect(hueGap(current.hue, next.hue)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('never paints review colours in the green hues of the bitter-melon photos', () => {
    for (const mode of ['twoTone', 'warmCool'] as const) {
      for (const label of [...ridges, ...warts, 'main_flesh_band', 'wart_flesh']) {
        const { hue } = parse(overlayColor(label, mode));
        expect(hue < GREEN_START || hue >= GREEN_END).toBe(true);
      }
    }
  });

  it('only splits ridges and warts: other labels are neutral grey in the review modes', () => {
    for (const mode of ['twoTone', 'warmCool'] as const) {
      for (const other of ['', 'damage', 'x1', undefined]) expect(overlayColor(other, mode)).toBe(NEUTRAL_OVERLAY_COLOR);
    }
  });
});
