import { labelColor } from './label-colors';

/**
 * Màu lớp phủ ở trang duyệt (người dùng yêu cầu 2026-11-24). Chỉ hiển thị: không lưu vào annotation, không
 * ảnh hưởng export/ZIP/Drive. Editor không dùng các chế độ này (Theo label vẫn là chế độ duy nhất ở editor).
 *
 * - `label`: như editor (`labelColor`), mỗi label một màu.
 * - `twoTone` (Xanh – Đỏ): tách nhanh hai loại. Mọi vết gợn là các sắc ĐỎ gần nhau, mọi u vấu là các sắc XANH
 *   gần nhau ("gradient gần nhau"): nhìn là biết loại, các label liền nhau vẫn hơi khác sắc.
 * - `warmCool` (Nóng – Lạnh): mỗi loại một nhóm nhiệt độ màu nhưng TỪNG label một màu khác hẳn trong nhóm.
 *
 * Chỉ tách vết gợn (`r*`) và u vấu (`w*`); label khác tô xám trung tính ở hai chế độ duyệt.
 * Cùng label → cùng màu ở mọi chế độ (quyết định 2026-11-05): màu chỉ phụ thuộc chuỗi label và chế độ.
 *
 * GIẢ ĐỊNH CỦA AGENT, CHƯA ĐƯỢC NGƯỜI DÙNG XÁC NHẬN (docs/REVIEW_AND_ASSIGNMENT.md §1): vết gợn = đỏ/nóng,
 * u vấu = xanh/lạnh; "xanh" = xanh dương vì ảnh khổ qua chủ yếu xanh lá (label-colors.ts cũng bỏ dải xanh lá).
 * Đổi loại nào màu nào ở KIND_TONE, đổi sắc ở các hằng số bên dưới.
 */

export type OverlayColorMode = 'label' | 'twoTone' | 'warmCool';
export type OverlayLabelKind = 'ridge' | 'wart';
type Tone = 'hot' | 'cold';

export const OVERLAY_COLOR_MODES: readonly OverlayColorMode[] = ['label', 'twoTone', 'warmCool'];

/** Vết gợn (r*) → đỏ / nóng, u vấu (w*) → xanh / lạnh. */
export const KIND_TONE: Record<OverlayLabelKind, Tone> = { ridge: 'hot', wart: 'cold' };

/** Xanh – Đỏ: hue gốc, lệch tối đa ±TWO_TONE_HUE_SPREAD và độ sáng 44 → 62 % theo 5 bậc. */
const TWO_TONE_HUE: Record<Tone, number> = { hot: 0, cold: 218 };
const TWO_TONE_HUE_SPREAD = 8;
const TWO_TONE_STEPS = 5;
const TWO_TONE_LIGHTNESS = { min: 44, max: 62 };

/** Nóng – Lạnh: dải hue của mỗi nhóm (đi theo chiều tăng, qua 0° với nhóm nóng). Cả hai tránh dải xanh lá 65°–175°. */
export const WARM_COOL_RANGE: Record<Tone, { start: number; span: number }> = {
  hot: { start: 320, span: 95 }, // hồng → đỏ → cam → hổ phách (320° → 55°)
  cold: { start: 180, span: 110 }, // cyan → xanh dương → tím (180° → 290°)
};
const WARM_COOL_LIGHTNESS = [50, 62, 42];
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

/** Màu của label không phải vết gợn hay u vấu ở hai chế độ duyệt. */
export const NEUTRAL_OVERLAY_COLOR = 'hsl(220, 9%, 62%)';

const INSTANCE_LABEL = /^(r|w)([1-9]\d*)$/;

/** Loại và số thứ tự của label; nhãn ngữ nghĩa cũ `main_flesh_band`/`wart_flesh` cũng là vết gợn/u vấu. */
export function overlayLabelInstance(label: string | undefined | null): { kind: OverlayLabelKind; index: number } | null {
  const key = (label ?? '').trim().toLowerCase();
  const match = INSTANCE_LABEL.exec(key);
  if (match) return { kind: match[1] === 'r' ? 'ridge' : 'wart', index: Number(match[2]) };
  if (key === 'main_flesh_band') return { kind: 'ridge', index: 0 };
  if (key === 'wart_flesh') return { kind: 'wart', index: 0 };
  return null;
}

const hsl = (hue: number, saturation: number, lightness: number) =>
  `hsl(${(((hue % 360) + 360) % 360).toFixed(1)}, ${saturation}%, ${lightness}%)`;

function twoToneColor(tone: Tone, index: number): string {
  const step = ((index % TWO_TONE_STEPS) + TWO_TONE_STEPS) % TWO_TONE_STEPS;
  const t = step / (TWO_TONE_STEPS - 1);
  const hue = TWO_TONE_HUE[tone] + (t - 0.5) * 2 * TWO_TONE_HUE_SPREAD;
  const lightness = Math.round(TWO_TONE_LIGHTNESS.min + t * (TWO_TONE_LIGHTNESS.max - TWO_TONE_LIGHTNESS.min));
  return hsl(hue, 82, lightness);
}

function warmCoolColor(tone: Tone, index: number): string {
  // Dãy tỉ lệ vàng rải các số liên tiếp xa nhau trong dải (≥ 0.38 × span), không bao giờ trùng nhau.
  const fraction = (index * GOLDEN_RATIO_CONJUGATE) % 1;
  const range = WARM_COOL_RANGE[tone];
  return hsl(range.start + fraction * range.span, 80, WARM_COOL_LIGHTNESS[index % WARM_COOL_LIGHTNESS.length]);
}

export interface ReviewLabelSummary {
  /** Số mask (polygon) và các label khác nhau, sắp theo số thứ tự. */
  ridge: { masks: number; labels: string[] };
  wart: { masks: number; labels: string[] };
  /** Mask có label không phải vết gợn/u vấu (tô xám ở hai chế độ duyệt). */
  other: number;
}

/** Đếm mask theo loại để panel duyệt hiện chú giải đúng các label có trong ảnh. */
export function reviewLabelSummary(polygons: ReadonlyArray<{ label: string }>): ReviewLabelSummary {
  const found = { ridge: new Map<string, number>(), wart: new Map<string, number>() };
  const masks = { ridge: 0, wart: 0 };
  let other = 0;
  for (const polygon of polygons) {
    const instance = overlayLabelInstance(polygon.label);
    if (!instance) { other += 1; continue; }
    masks[instance.kind] += 1;
    found[instance.kind].set(polygon.label.trim().toLowerCase(), instance.index);
  }
  const sorted = (labels: Map<string, number>) => [...labels].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([label]) => label);
  return {
    ridge: { masks: masks.ridge, labels: sorted(found.ridge) },
    wart: { masks: masks.wart, labels: sorted(found.wart) },
    other,
  };
}

const cache = new Map<string, string>();

export function overlayColor(label: string | undefined | null, mode: OverlayColorMode = 'label'): string {
  if (mode === 'label') return labelColor(label);
  const key = `${mode}\u0000${(label ?? '').trim().toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const instance = overlayLabelInstance(label);
  const color = !instance
    ? NEUTRAL_OVERLAY_COLOR
    : mode === 'twoTone'
      ? twoToneColor(KIND_TONE[instance.kind], instance.index)
      : warmCoolColor(KIND_TONE[instance.kind], instance.index);
  if (cache.size > 4000) cache.clear();
  cache.set(key, color);
  return color;
}
