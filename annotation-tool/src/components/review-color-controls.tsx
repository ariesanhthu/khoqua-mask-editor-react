'use client';

import type { AnnotationState } from '@/types';
import { overlayColor, type OverlayColorMode, type ReviewLabelSummary } from '@/lib/review-colors';

/**
 * Phần lớp phủ duyệt dùng chung giữa trang `/review/[fileId]` và tab Review trong editor (người dùng xác nhận
 * 2026-11-25: giữ cả hai nơi, dùng chung panel duyệt). Chỉ đổi màu hiển thị, không đụng dữ liệu annotation.
 */

export const REVIEW_COLOR_MODES: ReadonlyArray<{ value: OverlayColorMode; label: string; title: string }> = [
  { value: 'label', label: 'Theo label', title: 'Mỗi label một màu, như trong editor' },
  { value: 'twoTone', label: 'Xanh – Đỏ', title: 'Tách nhanh hai loại: vết gợn (r*) các sắc đỏ gần nhau, u vấu (w*) các sắc xanh gần nhau; label khác màu xám' },
  { value: 'warmCool', label: 'Nóng – Lạnh', title: 'Vết gợn nhóm màu nóng, u vấu nhóm màu lạnh; mỗi label một màu riêng trong nhóm' },
];
const COLOR_MODE_KEY = 'review-color-mode';
export const ANNOTATION_STATE_LABELS: Record<AnnotationState, string> = { UNSTARTED: 'Chưa làm', DRAFT: 'Bản nháp', REVIEW: 'Cần review', DONE: 'Hoàn thành' };
/** Số ô màu tối đa của mỗi loại trong chú giải; phần còn lại ghi "+N". */
const LEGEND_LIMIT = 14;

/** Chế độ màu đã chọn được nhớ theo trình duyệt; mặc định Xanh – Đỏ (mục đích chính khi duyệt). */
export function readStoredColorMode(): OverlayColorMode {
  if (typeof window === 'undefined') return 'twoTone';
  const stored = localStorage.getItem(COLOR_MODE_KEY);
  return stored === 'label' || stored === 'twoTone' || stored === 'warmCool' ? stored : 'twoTone';
}

export function storeColorMode(mode: OverlayColorMode) {
  localStorage.setItem(COLOR_MODE_KEY, mode);
}

export function ReviewColorModes({ mode, onChange }: { mode: OverlayColorMode; onChange: (mode: OverlayColorMode) => void }) {
  return (
    <div className="review-color-modes" role="group" aria-label="Màu lớp phủ">
      {REVIEW_COLOR_MODES.map((item) => (
        <button key={item.value} type="button" title={item.title} aria-pressed={mode === item.value}
          className={mode === item.value ? 'active' : ''} onClick={() => onChange(item.value)}>{item.label}</button>
      ))}
    </div>
  );
}

/** Chú giải màu theo loại; ảnh chỉ có raster (không polygon) thì ghi rõ là không tách màu được. */
export function ReviewLegend({ summary, mode }: { summary: ReviewLabelSummary; mode: OverlayColorMode }) {
  const hasPolygons = summary.ridge.masks + summary.wart.masks + summary.other > 0;
  if (!hasPolygons) {
    return <p className="review-note">Ảnh này chỉ có mask raster (chưa có polygon theo label) nên lớp phủ một màu, không tách theo vết gợn/u vấu được.</p>;
  }
  return (
    <div className="review-legend">
      <LegendRow title="Vết gợn (r*)" labels={summary.ridge.labels} mode={mode} />
      <LegendRow title="U vấu (w*)" labels={summary.wart.labels} mode={mode} />
      {summary.other && mode !== 'label' ? <p className="review-note"><span className="review-swatch" style={{ background: overlayColor('', mode) }} /> Label khác: xám (không thuộc hai loại trên)</p> : null}
    </div>
  );
}

function LegendRow({ title, labels, mode }: { title: string; labels: string[]; mode: OverlayColorMode }) {
  if (!labels.length) return <p className="review-legend-row"><strong>{title}</strong><span className="review-note">không có</span></p>;
  const shown = labels.slice(0, LEGEND_LIMIT);
  return (
    <p className="review-legend-row">
      <strong>{title}</strong>
      <span className="review-swatches">
        {shown.map((label) => <span key={label} className="review-swatch" title={label} style={{ background: overlayColor(label, mode) }} />)}
        {labels.length > shown.length ? <small>+{labels.length - shown.length}</small> : null}
      </span>
    </p>
  );
}
