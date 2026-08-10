'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { BreakpointAnnotation, BreakpointPoint, HumanAction, MaskOperation } from '@/types';

export type EditorTool = 'add' | 'erase' | 'point' | 'pan';

export interface EditorCanvasSnapshot {
  humanAction: HumanAction;
  breakpoints: BreakpointAnnotation;
  maskOperations: MaskOperation[];
}

export interface EditorCanvasHandle {
  exportMask(): Promise<Blob>;
  resetToPrediction(): void;
  acceptPrediction(): void;
  undo(): void;
  redo(): void;
  deleteSelectedPoint(): void;
  confirmNoBreakpoint(): void;
  fit(): void;
  zoomBy(factor: number): void;
}

interface Props {
  width: number;
  height: number;
  imageUrl: string;
  predictionUrl: string;
  currentMaskUrl?: string;
  localMaskBlob?: Blob;
  initialHumanAction: HumanAction;
  initialBreakpoints: BreakpointAnnotation;
  initialOperations: MaskOperation[];
  tool: EditorTool;
  brushSize: number;
  maskOpacity: number;
  showMask: boolean;
  comparePrediction: boolean;
  onChange(snapshot: EditorCanvasSnapshot): void;
  onReady(): void;
}

type View = { scale: number; x: number; y: number };

const EditorCanvas = forwardRef<EditorCanvasHandle, Props>(function EditorCanvas(props, ref) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const predictionRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  const predictionTintRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fittedRef = useRef(false);
  const readyRef = useRef(false);
  const pointerRef = useRef<{
    id: number;
    mode: 'brush' | 'pan' | 'point';
    points: Array<{ x: number; y: number }>;
    lastClient: { x: number; y: number };
    pointBefore?: BreakpointPoint[];
    draggedPointId?: string;
  } | null>(null);
  // Undo history intentionally starts fresh after reload. The latest materialized
  // mask is recovered, while spec V1 allows historical undo to reset on refresh.
  const maskUndoRef = useRef<MaskOperation[]>([]);
  const maskRedoRef = useRef<MaskOperation[]>([]);
  const pointUndoRef = useRef<BreakpointPoint[][]>([]);
  const pointRedoRef = useRef<BreakpointPoint[][]>([]);
  const [humanAction, setHumanAction] = useState<HumanAction>(props.initialHumanAction);
  const humanActionRef = useRef(humanAction);
  const [breakpoints, setBreakpoints] = useState<BreakpointAnnotation>(props.initialBreakpoints);
  const breakpointsRef = useRef(breakpoints);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const displayRef = useRef({
    showMask: props.showMask,
    comparePrediction: props.comparePrediction,
    maskOpacity: props.maskOpacity,
    selectedPointId: null as string | null,
  });
  const onReady = props.onReady;

  const setBreakpointState = useCallback((next: BreakpointAnnotation) => {
    breakpointsRef.current = next;
    setBreakpoints(next);
  }, []);

  const notifyChange = useCallback((nextHumanAction = humanActionRef.current) => {
    props.onChange({
      humanAction: nextHumanAction,
      breakpoints: breakpointsRef.current,
      maskOperations: [...maskUndoRef.current],
    });
  }, [props]);

  const render = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || !readyRef.current) return;
    const context = stage.getContext('2d');
    if (!context) return;
    const rect = stage.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
    const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    if (stage.width !== pixelWidth || stage.height !== pixelHeight) {
      stage.width = pixelWidth;
      stage.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = '#071018';
    context.fillRect(0, 0, rect.width, rect.height);
    const view = viewRef.current;
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    context.drawImage(image, 0, 0, props.width, props.height);
    const display = displayRef.current;
    if (display.showMask) {
      const overlay = display.comparePrediction ? predictionTintRef.current : tintRef.current;
      if (overlay) {
        context.globalAlpha = display.maskOpacity;
        context.drawImage(overlay, 0, 0);
        context.globalAlpha = 1;
      }
    }
    for (const point of breakpointsRef.current.points) {
      context.beginPath();
      context.arc(point.x, point.y, 8 / view.scale, 0, Math.PI * 2);
      context.fillStyle = point.id === display.selectedPointId ? '#ffffff' : '#fb7185';
      context.fill();
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = '#881337';
      context.stroke();
    }
    context.restore();
  }, [props.height, props.width]);

  useEffect(() => {
    displayRef.current = {
      showMask: props.showMask,
      comparePrediction: props.comparePrediction,
      maskOpacity: props.maskOpacity,
      selectedPointId,
    };
    render();
  }, [props.comparePrediction, props.maskOpacity, props.showMask, render, selectedPointId]);

  const rebuildTint = useCallback((source: HTMLCanvasElement, target: HTMLCanvasElement, color: string) => {
    const context = target.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = color;
    context.fillRect(0, 0, target.width, target.height);
    context.globalCompositeOperation = 'source-over';
  }, []);

  const normalizeMask = useCallback((image: CanvasImageSource, target: HTMLCanvasElement) => {
    const context = target.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D không khả dụng.');
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(image, 0, 0, props.width, props.height);
    const data = context.getImageData(0, 0, props.width, props.height);
    for (let offset = 0; offset < data.data.length; offset += 4) {
      const visible = data.data[offset + 3] > 0 &&
        Math.max(data.data[offset], data.data[offset + 1], data.data[offset + 2]) > 96;
      data.data[offset] = 255;
      data.data[offset + 1] = 255;
      data.data[offset + 2] = 255;
      data.data[offset + 3] = visible ? 255 : 0;
    }
    context.putImageData(data, 0, 0);
  }, [props.height, props.width]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.max(0.05, Math.min((rect.width - 32) / props.width, (rect.height - 32) / props.height));
    viewRef.current = {
      scale,
      x: (rect.width - props.width * scale) / 2,
      y: (rect.height - props.height * scale) / 2,
    };
    render();
  }, [props.height, props.width, render]);

  useEffect(() => {
    let cancelled = false;
    const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Không tải được ảnh ${url}`));
      image.src = url;
    });
    const makeCanvas = () => {
      const canvas = document.createElement('canvas');
      canvas.width = props.width; canvas.height = props.height;
      return canvas;
    };
    void (async () => {
      const localUrl = props.localMaskBlob ? URL.createObjectURL(props.localMaskBlob) : undefined;
      try {
        const [image, prediction, current] = await Promise.all([
          loadImage(props.imageUrl),
          loadImage(props.predictionUrl),
          loadImage(localUrl || props.currentMaskUrl || props.predictionUrl),
        ]);
        if (cancelled) return;
        const predictionCanvas = makeCanvas();
        const maskCanvas = makeCanvas();
        const tintCanvas = makeCanvas();
        const predictionTintCanvas = makeCanvas();
        normalizeMask(prediction, predictionCanvas);
        normalizeMask(current, maskCanvas);
        rebuildTint(predictionCanvas, predictionTintCanvas, '#f59e0b');
        rebuildTint(maskCanvas, tintCanvas, '#22d3a6');
        imageRef.current = image;
        predictionRef.current = predictionCanvas;
        maskRef.current = maskCanvas;
        tintRef.current = tintCanvas;
        predictionTintRef.current = predictionTintCanvas;
        readyRef.current = true;
        fittedRef.current = true;
        fit();
        onReady();
      } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [fit, normalizeMask, onReady, props.currentMaskUrl, props.height, props.imageUrl, props.localMaskBlob, props.predictionUrl, props.width, rebuildTint]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => fittedRef.current ? render() : fit());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, render]);

  useEffect(() => { render(); }, [breakpoints, render]);

  const imagePoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: Math.max(0, Math.min(props.width, (event.clientX - rect.left - view.x) / view.scale)),
      y: Math.max(0, Math.min(props.height, (event.clientY - rect.top - view.y) / view.scale)),
    };
  };

  const applyStrokeSegment = (points: Array<{ x: number; y: number }>, mode: 'add' | 'erase') => {
    const mask = maskRef.current;
    const tint = tintRef.current;
    if (!mask || !tint || points.length === 0) return;
    const context = mask.getContext('2d');
    if (!context) return;
    context.save();
    context.globalCompositeOperation = mode === 'add' ? 'source-over' : 'destination-out';
    context.strokeStyle = '#ffffff';
    context.fillStyle = '#ffffff';
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = props.brushSize;
    context.beginPath();
    if (points.length === 1) context.arc(points[0].x, points[0].y, props.brushSize / 2, 0, Math.PI * 2);
    else { context.moveTo(points[points.length - 2].x, points[points.length - 2].y); context.lineTo(points[points.length - 1].x, points[points.length - 1].y); }
    if (points.length === 1) context.fill();
    else context.stroke();
    context.restore();
    rebuildTint(mask, tint, '#22d3a6');
    render();
  };

  const pushPointHistory = (before: BreakpointPoint[]) => {
    pointUndoRef.current.push(before.map((point) => ({ ...point })));
    pointRedoRef.current = [];
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = imagePoint(event);
    if (props.tool === 'pan') {
      pointerRef.current = { id: event.pointerId, mode: 'pan', points: [], lastClient: { x: event.clientX, y: event.clientY } };
      return;
    }
    if (props.tool === 'point') {
      const hitRadius = 14 / viewRef.current.scale;
      const hit = breakpointsRef.current.points.find((item) => Math.hypot(item.x - point.x, item.y - point.y) <= hitRadius);
      const before = breakpointsRef.current.points.map((item) => ({ ...item }));
      if (hit) {
        setSelectedPointId(hit.id);
        pointerRef.current = { id: event.pointerId, mode: 'point', points: [], lastClient: { x: event.clientX, y: event.clientY }, pointBefore: before, draggedPointId: hit.id };
      } else {
        const created = { id: crypto.randomUUID(), x: point.x, y: point.y };
        pushPointHistory(before);
        setSelectedPointId(created.id);
        setBreakpointState({ state: 'ANNOTATED', points: [...before, created] });
        notifyChange();
      }
      return;
    }
    pointerRef.current = { id: event.pointerId, mode: 'brush', points: [point], lastClient: { x: event.clientX, y: event.clientY } };
    applyStrokeSegment([point], props.tool);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.mode === 'pan') {
      viewRef.current.x += event.clientX - active.lastClient.x;
      viewRef.current.y += event.clientY - active.lastClient.y;
      active.lastClient = { x: event.clientX, y: event.clientY };
      fittedRef.current = true;
      render();
      return;
    }
    const point = imagePoint(event);
    if (active.mode === 'brush') {
      active.points.push(point);
      applyStrokeSegment(active.points, props.tool === 'erase' ? 'erase' : 'add');
    } else if (active.draggedPointId) {
      const next = breakpointsRef.current.points.map((item) => item.id === active.draggedPointId ? { ...item, ...point } : item);
      setBreakpointState({ state: 'ANNOTATED', points: next });
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    pointerRef.current = null;
    if (active.mode === 'brush') {
      const operation: MaskOperation = {
        type: props.tool === 'erase' ? 'BRUSH_ERASE' : 'BRUSH_ADD',
        brushSize: props.brushSize,
        points: active.points,
      };
      maskUndoRef.current.push(operation); maskRedoRef.current = [];
      humanActionRef.current = 'MODIFIED'; setHumanAction('MODIFIED'); notifyChange('MODIFIED');
    } else if (active.mode === 'point' && active.pointBefore && active.draggedPointId) {
      const moved = breakpointsRef.current.points.find((item) => item.id === active.draggedPointId);
      const before = active.pointBefore.find((item) => item.id === active.draggedPointId);
      if (moved && before && (moved.x !== before.x || moved.y !== before.y)) {
        pushPointHistory(active.pointBefore); notifyChange();
      }
    }
  };

  const replayMask = useCallback(() => {
    const mask = maskRef.current;
    const prediction = predictionRef.current;
    const tint = tintRef.current;
    if (!mask || !prediction || !tint) return;
    const context = mask.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, props.width, props.height);
    context.drawImage(prediction, 0, 0);
    for (const operation of maskUndoRef.current) {
      if (operation.type === 'RESET_TO_PREDICTION') {
        context.clearRect(0, 0, props.width, props.height); context.drawImage(prediction, 0, 0); continue;
      }
      context.save();
      context.globalCompositeOperation = operation.type === 'BRUSH_ADD' ? 'source-over' : 'destination-out';
      context.strokeStyle = '#fff'; context.fillStyle = '#fff'; context.lineWidth = operation.brushSize; context.lineCap = 'round'; context.lineJoin = 'round';
      context.beginPath();
      operation.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
      if (operation.points.length === 1) { context.arc(operation.points[0].x, operation.points[0].y, operation.brushSize / 2, 0, Math.PI * 2); context.fill(); }
      else context.stroke();
      context.restore();
    }
    rebuildTint(mask, tint, '#22d3a6'); render();
  }, [props.height, props.width, rebuildTint, render]);

  const deleteSelectedPoint = useCallback(() => {
    if (!selectedPointId) return;
    const before = breakpointsRef.current.points;
    const next = before.filter((point) => point.id !== selectedPointId);
    if (next.length === before.length) return;
    pushPointHistory(before);
    setSelectedPointId(null);
    setBreakpointState({ state: next.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points: next });
    notifyChange();
  }, [notifyChange, selectedPointId, setBreakpointState]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && props.tool === 'point') {
        event.preventDefault(); deleteSelectedPoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelectedPoint, props.tool]);

  useImperativeHandle(ref, () => ({
    exportMask: () => new Promise<Blob>((resolve, reject) => {
      const mask = maskRef.current;
      if (!mask) { reject(new Error('Mask chưa sẵn sàng.')); return; }
      mask.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Không thể xuất mask.')), 'image/png');
    }),
    resetToPrediction: () => {
      maskUndoRef.current.push({ type: 'RESET_TO_PREDICTION' }); maskRedoRef.current = [];
      replayMask(); humanActionRef.current = 'MODIFIED'; setHumanAction('MODIFIED'); notifyChange('MODIFIED');
    },
    acceptPrediction: () => {
      maskUndoRef.current = []; maskRedoRef.current = [];
      replayMask(); humanActionRef.current = 'ACCEPTED'; setHumanAction('ACCEPTED'); notifyChange('ACCEPTED');
    },
    undo: () => {
      if (props.tool === 'point') {
        const previous = pointUndoRef.current.pop(); if (!previous) return;
        pointRedoRef.current.push(breakpointsRef.current.points.map((point) => ({ ...point })));
        setBreakpointState({ state: previous.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points: previous }); notifyChange();
      } else {
        const operation = maskUndoRef.current.pop(); if (!operation) return;
        maskRedoRef.current.push(operation); replayMask(); humanActionRef.current = 'MODIFIED'; setHumanAction('MODIFIED'); notifyChange('MODIFIED');
      }
    },
    redo: () => {
      if (props.tool === 'point') {
        const next = pointRedoRef.current.pop(); if (!next) return;
        pointUndoRef.current.push(breakpointsRef.current.points.map((point) => ({ ...point })));
        setBreakpointState({ state: next.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points: next }); notifyChange();
      } else {
        const operation = maskRedoRef.current.pop(); if (!operation) return;
        maskUndoRef.current.push(operation); replayMask(); humanActionRef.current = 'MODIFIED'; setHumanAction('MODIFIED'); notifyChange('MODIFIED');
      }
    },
    deleteSelectedPoint,
    confirmNoBreakpoint: () => {
      pushPointHistory(breakpointsRef.current.points);
      setSelectedPointId(null);
      setBreakpointState({ state: 'CONFIRMED_NONE', points: [] });
      notifyChange();
    },
    fit,
    zoomBy: (factor) => {
      const viewport = viewportRef.current; if (!viewport) return;
      const rect = viewport.getBoundingClientRect(); const view = viewRef.current;
      const next = Math.max(0.05, Math.min(20, view.scale * factor));
      const imageX = (rect.width / 2 - view.x) / view.scale; const imageY = (rect.height / 2 - view.y) / view.scale;
      viewRef.current = { scale: next, x: rect.width / 2 - imageX * next, y: rect.height / 2 - imageY * next };
      fittedRef.current = true; render();
    },
  }), [deleteSelectedPoint, fit, notifyChange, props.tool, replayMask, render, setBreakpointState]);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect(); const view = viewRef.current;
    const mouseX = event.clientX - rect.left; const mouseY = event.clientY - rect.top;
    const imageX = (mouseX - view.x) / view.scale; const imageY = (mouseY - view.y) / view.scale;
    const next = Math.max(0.05, Math.min(20, view.scale * Math.exp(-event.deltaY * 0.001)));
    viewRef.current = { scale: next, x: mouseX - imageX * next, y: mouseY - imageY * next };
    fittedRef.current = true; render();
  };

  return (
    <div className={`canvas-viewport tool-${props.tool}`} ref={viewportRef}>
      <canvas ref={stageRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} />
      <div className="canvas-hint">{humanAction === 'ACCEPTED' ? 'Đã chấp nhận mặt nạ gợi ý' : humanAction === 'MODIFIED' ? 'Mặt nạ đã chỉnh sửa' : 'Chưa xác nhận mặt nạ'}</div>
    </div>
  );
});

export default EditorCanvas;
