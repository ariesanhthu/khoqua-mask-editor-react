'use client';

import { useEffect, useState } from 'react';
import type { AnnotationPolygon } from '@/types';
import { labelColor } from '@/lib/label-colors';
import { polygonSvgPath, summarizePolygons } from '@/lib/polygon-svg';

/**
 * Ảnh gốc + mask của một bản annotation, dùng trong hộp chọn bản khi lưu bị xung đột (người dùng yêu cầu
 * 2026-11-07: "show 2 version đó cho họ chọn (show hình và mask)"). Chỉ hiển thị, không đụng canvas editor.
 */
export function VersionPreview({ imageUrl, width, height, polygons, maskUrl, maskBlob }: {
  imageUrl: string;
  width: number;
  height: number;
  polygons: AnnotationPolygon[];
  /** Ảnh mask (PNG) khi bản đó không có polygon, ví dụ annotation cũ chỉ có mask raster. */
  maskUrl?: string;
  /** Ảnh mask của nét brush chưa chuyển thành polygon trong bản nháp trên thiết bị. */
  maskBlob?: Blob;
}) {
  const blobUrl = useObjectUrl(maskBlob);
  const rasterMask = polygons.length ? undefined : blobUrl ?? maskUrl;
  // Nét viền theo đơn vị ảnh: giữ khoảng 1.5 px trên khung xem trước rộng ~360 px.
  const stroke = Math.max(width, height) / 240;
  return (
    <svg className="version-preview-image" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img"
      aria-label={`Ảnh và mask: ${polygons.length} polygon`}>
      <image href={imageUrl} width={width} height={height} />
      {rasterMask ? <image href={rasterMask} width={width} height={height} opacity={0.55} /> : null}
      {polygons.map((polygon) => {
        const color = labelColor(polygon.label);
        return <path key={polygon.id} d={polygonSvgPath(polygon)} fill={color} fillOpacity={0.42} fillRule="evenodd"
          stroke={color} strokeWidth={stroke} strokeLinejoin="round" />;
      })}
    </svg>
  );
}

export function VersionFacts({ polygons, lines }: { polygons: AnnotationPolygon[]; lines: string[] }) {
  const summary = summarizePolygons(polygons);
  const labels = summary.labels.length > 8
    ? `${summary.labels.slice(0, 8).join(', ')}… (+${summary.labels.length - 8})`
    : summary.labels.join(', ');
  return (
    <ul className="version-facts">
      {lines.map((line) => <li key={line}>{line}</li>)}
      <li>{summary.polygons} polygon{labels ? ` · ${labels}` : ''}</li>
    </ul>
  );
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    let active = true;
    queueMicrotask(() => { if (active) setUrl(next); });
    return () => { active = false; URL.revokeObjectURL(next); };
  }, [blob]);
  return blob ? url : undefined;
}

export function formatTime(value: string | number | undefined) {
  if (value === undefined || value === '') return 'không rõ thời điểm';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'không rõ thời điểm' : date.toLocaleString('vi-VN', { hour12: false });
}
