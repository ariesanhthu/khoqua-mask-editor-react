/**
 * Màu lớp phủ theo label (người dùng xác nhận 2026-11-05): cùng label → cùng màu, kể cả hai mask tách rời
 * (ví dụ hai vùng cùng là r1); label khác → màu khác. Màu chỉ phụ thuộc chuỗi label nên ổn định giữa các ảnh
 * và không đổi khi thêm/xóa mask khác. Chỉ dùng để hiển thị, không lưu vào annotation hay export.
 *
 * Label dạng `<tiền tố><số>` (r1, w12…): hue = hue gốc của tiền tố + số × góc vàng (≈137.5°), nên các số
 * liên tiếp cách nhau xa trên vòng màu. Vết gợn (r*) và u vấu (w*) có hue gốc đối nhau và độ sáng khác nhau
 * để r_k và w_j khó trùng màu. Label khác dùng hash của chuỗi. Ảnh khổ qua chủ yếu màu xanh lá nên bỏ dải
 * hue xanh lá (GREEN_START..GREEN_END): hue thô được nén vào 250° còn lại, mask không lẫn vào nền.
 */

const GOLDEN_ANGLE = 137.508;
export const GREEN_START = 65;
export const GREEN_END = 175;
const allowedHue = (rawHue: number) => (GREEN_END + (rawHue * (360 - (GREEN_END - GREEN_START))) / 360) % 360;
const PREFIX_STYLE: Record<string, { hue: number; lightness: number }> = {
  r: { hue: 12, lightness: 52 },
  w: { hue: 192, lightness: 60 },
};
const cache = new Map<string, string>();

function hashString(value: string): number {
  // FNV-1a 32-bit: ổn định, không phụ thuộc môi trường.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function labelColor(label: string | undefined | null): string {
  const key = (label ?? '').trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const match = /^([a-z_]*?)(\d+)$/.exec(key);
  let hue: number;
  let lightness = 56;
  if (match) {
    const style = PREFIX_STYLE[match[1]];
    const base = style ? style.hue : hashString(match[1]) % 360;
    if (style) lightness = style.lightness;
    hue = (base + Number(match[2]) * GOLDEN_ANGLE) % 360;
  } else {
    hue = hashString(key) % 360;
  }
  const color = `hsl(${allowedHue(hue).toFixed(1)}, 78%, ${lightness}%)`;
  if (cache.size > 2000) cache.clear();
  cache.set(key, color);
  return color;
}
