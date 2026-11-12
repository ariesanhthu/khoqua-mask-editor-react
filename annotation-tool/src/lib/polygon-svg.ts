import type { AnnotationPolygon, PolygonNode } from '@/types';

/**
 * Path SVG của một polygon (viền ngoài + lỗ) để xem trước hai bản khi xung đột lưu. Chỉ dùng để hiển thị:
 * tô bằng fill-rule evenodd nên lỗ hiện đúng; không đổi, không làm mịn tọa độ đã lưu.
 */
export function polygonSvgPath(polygon: Pick<AnnotationPolygon, 'nodes' | 'holes'>): string {
  return [polygon.nodes, ...(polygon.holes ?? [])].map(ringPath).filter(Boolean).join(' ');
}

function ringPath(ring: PolygonNode[]): string {
  if (ring.length < 3) return '';
  return `M${ring.map((node) => `${round(node.x)} ${round(node.y)}`).join('L')}Z`;
}

// 2 chữ số thập phân là đủ cho ảnh xem trước vài trăm pixel và giữ chuỗi path ngắn với polygon nhiều node.
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export interface VersionSummary {
  polygons: number;
  labels: string[];
}

export function summarizePolygons(polygons: AnnotationPolygon[]): VersionSummary {
  return {
    polygons: polygons.length,
    labels: [...new Set(polygons.map((polygon) => polygon.label).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
  };
}
