import type { ReactNode } from 'react';
import type { PaintMode } from '@/lib/polygon-paint';

/**
 * Icon chế độ Paint (người dùng yêu cầu 2026-11-12, để biết đang nối hay trừ): đa giác thu nhỏ ở góc trên trái và
 * dấu ＋ / − ở góc dưới phải, cùng nét 24×24 với các icon khác của editor. Dùng chung cho thanh công cụ, thanh chế
 * độ Paint trong workspace và trang kiểm tra trình duyệt.
 */
export const PAINT_ICON_PATHS: Record<PaintMode, ReactNode> = {
  add: <><path d="m5 2.5 7.5 1.5 2 7.5-6 3.7-6.7-5.2L5 2.5Z" /><path d="M18 14v8M14 18h8" /></>,
  subtract: <><path d="m5 2.5 7.5 1.5 2 7.5-6 3.7-6.7-5.2L5 2.5Z" /><path d="M14 18h8" /></>,
};

export function PaintModeIcon({ mode }: { mode: PaintMode }) {
  return (
    <svg aria-hidden="true" data-paint-icon={mode} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {PAINT_ICON_PATHS[mode]}
    </svg>
  );
}
