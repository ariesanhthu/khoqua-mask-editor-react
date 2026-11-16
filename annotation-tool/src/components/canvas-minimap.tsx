'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasViewInfo } from './editor-canvas';

/**
 * Minimap ở sidebar trái (người dùng xác nhận 2026-11-16): ảnh thu nhỏ + khung đỏ là vùng canvas chính đang nhìn.
 * - Kéo/bấm trên minimap đưa tâm khung nhìn chính tới điểm đó (`onPan` → `EditorCanvasHandle.panTo`).
 * - Thanh trượt chỉnh mức thu-phóng của RIÊNG minimap: 1× = thấy toàn ảnh, phóng dần thì minimap bám quanh vùng
 *   đang nhìn. Không đụng zoom của canvas chính.
 * Hiển thị bằng chính <img> ảnh gốc (trình duyệt đã cache, scale trên GPU) — không canvas, không chi phí vẽ lại.
 */
export interface CanvasMinimapProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  view: CanvasViewInfo | null;
  onPan(x: number, y: number): void;
}

const FRAME_HEIGHT = 128;

export default function CanvasMinimap({ imageUrl, imageWidth, imageHeight, view, onPan }: CanvasMinimapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [frameWidth, setFrameWidth] = useState(196);
  const draggingRef = useRef(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => setFrameWidth(frame.clientWidth || 196));
    observer.observe(frame);
    setFrameWidth(frame.clientWidth || 196);
    return () => observer.disconnect();
  }, []);
  const fitScale = Math.min(frameWidth / imageWidth, FRAME_HEIGHT / imageHeight);
  const scale = fitScale * zoom;

  // Vùng canvas chính đang nhìn, theo tọa độ ảnh.
  const visible = view ? {
    left: -view.x / view.scale,
    top: -view.y / view.scale,
    width: view.viewportWidth / view.scale,
    height: view.viewportHeight / view.scale,
  } : { left: 0, top: 0, width: imageWidth, height: imageHeight };
  const centerX = visible.left + visible.width / 2;
  const centerY = visible.top + visible.height / 2;

  // Minimap bám quanh tâm vùng đang nhìn, kẹp trong biên ảnh (ảnh nhỏ hơn khung thì căn giữa).
  const clampOffset = (center: number, span: number, frame: number) => {
    const sized = span * scale;
    if (sized <= frame) return (sized - frame) / 2;
    return Math.min(Math.max(center * scale - frame / 2, 0), sized - frame);
  };
  const offsetX = clampOffset(centerX, imageWidth, frameWidth);
  const offsetY = clampOffset(centerY, imageHeight, FRAME_HEIGHT);

  const panToEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const fit = Math.min(rect.width / imageWidth, FRAME_HEIGHT / imageHeight);
    const current = fit * zoom;
    const visibleNow = view ? { width: view.viewportWidth / view.scale, height: view.viewportHeight / view.scale } : { width: imageWidth, height: imageHeight };
    const sizedWidth = imageWidth * current;
    const sizedHeight = imageHeight * current;
    const center = view ? {
      x: (-view.x / view.scale) + visibleNow.width / 2,
      y: (-view.y / view.scale) + visibleNow.height / 2,
    } : { x: imageWidth / 2, y: imageHeight / 2 };
    const clamp = (value: number, span: number, frameSpan: number) => (span <= frameSpan ? (span - frameSpan) / 2 : Math.min(Math.max(value * current - frameSpan / 2, 0), span - frameSpan));
    const x = (event.clientX - rect.left + clamp(center.x, sizedWidth, rect.width)) / current;
    const y = (event.clientY - rect.top + clamp(center.y, sizedHeight, FRAME_HEIGHT)) / current;
    onPan(Math.min(Math.max(x, 0), imageWidth), Math.min(Math.max(y, 0), imageHeight));
  }, [imageHeight, imageWidth, onPan, view, zoom]);

  return (
    <div className="canvas-minimap" data-minimap>
      <div
        ref={frameRef}
        className="minimap-frame"
        style={{ height: FRAME_HEIGHT }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          panToEvent(event);
        }}
        onPointerMove={(event) => { if (draggingRef.current) panToEvent(event); }}
        onPointerUp={() => { draggingRef.current = false; }}
        onPointerCancel={() => { draggingRef.current = false; }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- ảnh editor gốc, đã do canvas chính tải và cache */}
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          style={{ width: imageWidth * scale, height: imageHeight * scale, transform: `translate(${-offsetX}px, ${-offsetY}px)` }}
        />
        {view ? <span
          className="minimap-viewport"
          data-minimap-viewport
          style={{
            left: visible.left * scale - offsetX,
            top: visible.top * scale - offsetY,
            width: Math.max(6, visible.width * scale),
            height: Math.max(6, visible.height * scale),
          }}
        /> : null}
      </div>
      <label className="minimap-zoom" title="Thu/phóng riêng minimap (không đổi zoom canvas)">
        <span>Thu nhỏ</span>
        <input type="range" min={1} max={6} step={0.5} value={zoom} aria-label="Mức thu phóng của minimap" onChange={(event) => setZoom(Number(event.target.value))} />
        <strong>{zoom.toFixed(1)}×</strong>
      </label>
    </div>
  );
}
