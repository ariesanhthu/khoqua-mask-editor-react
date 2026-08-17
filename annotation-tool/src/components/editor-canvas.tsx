'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type {
  AnnotationPolygon,
  BreakpointAnnotation,
  BreakpointPoint,
  HumanAction,
  MaskOperation,
  PolygonNode,
} from '@/types';
import { clonePolygons, pointInPolygon, splitPolygonWithCut } from '@/lib/polygon-geometry';

export type EditorTool = 'polygon' | 'select' | 'cut' | 'point' | 'pan';

export interface EditorCanvasSnapshot {
  humanAction: HumanAction;
  breakpoints: BreakpointAnnotation;
  maskOperations: MaskOperation[];
  polygons: AnnotationPolygon[];
}

export interface EditorCanvasHandle {
  exportMask(): Promise<Blob>;
  resetToPrediction(): void;
  acceptPrediction(): void;
  undo(): void;
  redo(): void;
  deleteSelectedPoint(): void;
  deleteSelection(): void;
  confirmNoBreakpoint(): void;
  completePolygon(): boolean;
  cancelCurrentPath(): void;
  applyCut(): boolean;
  beginPolygonEdit(): number;
  selectPolygon(polygonId: string): void;
  updateSelectedPolygonLabel(label: string): boolean;
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
  maskOpacity: number;
  showMask: boolean;
  onChange(snapshot: EditorCanvasSnapshot): void;
  onSelectionChange(polygonIds: string[]): void;
  onReady(): void;
  onMessage(message: string): void;
  onZoomChange?(scale: number): void;
}

type View = { scale: number; x: number; y: number };
type ImagePoint = { x: number; y: number };
type Marquee = { start: ImagePoint; end: ImagePoint; additive: boolean };
type PointerActivity =
  | { id: number; mode: 'pan'; lastClient: ImagePoint }
  | { id: number; mode: 'cut'; last: ImagePoint }
  | { id: number; mode: 'nodes'; start: ImagePoint; original: AnnotationPolygon[]; nodeIds: Set<string>; moved: boolean }
  | { id: number; mode: 'polygons'; start: ImagePoint; original: AnnotationPolygon[]; polygonIds: Set<string>; moved: boolean }
  | { id: number; mode: 'marquee'; start: ImagePoint; additive: boolean }
  | { id: number; mode: 'point'; pointBefore: BreakpointPoint[]; draggedPointId: string; moved: boolean };

const POLYGON_FILL = '#7c5cfa';
const POLYGON_STROKE = '#7c5cfa';
const BREAKPOINT_COLOR = '#6d4ef2';
const CUT_COLOR = '#f04438';

function polygonsFromOperations(operations: MaskOperation[]): AnnotationPolygon[] {
  const polygonOperation = [...operations].reverse().find((operation) => operation.type === 'POLYGON_SET');
  return polygonOperation?.type === 'POLYGON_SET' ? clonePolygons(polygonOperation.polygons) : [];
}

function polygonOperation(polygons: AnnotationPolygon[]): MaskOperation[] {
  return [{ type: 'POLYGON_SET', polygons: clonePolygons(polygons) }];
}

const copyBreakpoints = (annotation: BreakpointAnnotation): BreakpointAnnotation => ({
  state: annotation.state,
  points: annotation.points.map((point) => ({ ...point })),
});

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Không thể xuất mask.')), 'image/png');
});

function closestPointOnSegment(point: ImagePoint, start: ImagePoint, end: ImagePoint) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (!lengthSquared) return { point: { ...start }, distance: Math.hypot(point.x - start.x, point.y - start.y) };
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared));
  const projectedPoint = { x: start.x + projection * segmentX, y: start.y + projection * segmentY };
  return { point: projectedPoint, distance: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y) };
}

function distanceToSegment(point: ImagePoint, start: ImagePoint, end: ImagePoint) {
  return closestPointOnSegment(point, start, end).distance;
}

function closestPolygonEdge(polygon: AnnotationPolygon, point: ImagePoint) {
  return polygon.nodes.reduce<{ edgeIndex: number; point: ImagePoint; distance: number } | null>((closest, start, edgeIndex) => {
    const end = polygon.nodes[(edgeIndex + 1) % polygon.nodes.length];
    const candidate = closestPointOnSegment(point, start, end);
    return !closest || candidate.distance < closest.distance ? { edgeIndex, ...candidate } : closest;
  }, null);
}

function simplifyOpenPath<T extends ImagePoint>(points: T[], tolerance: number): T[] {
  if (points.length <= 2) return [...points];
  let farthestIndex = -1;
  let farthestDistance = 0;
  const start = points[0];
  const end = points[points.length - 1];
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = distanceToSegment(points[index], start, end);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = index;
    }
  }
  if (farthestIndex < 0 || farthestDistance <= tolerance) return [start, end];
  const left = simplifyOpenPath(points.slice(0, farthestIndex + 1), tolerance);
  const right = simplifyOpenPath(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function simplifyRing<T extends ImagePoint>(points: T[], tolerance: number): T[] {
  if (points.length <= 3) return [...points];
  let oppositeIndex = 1;
  let oppositeDistance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.hypot(points[index].x - points[0].x, points[index].y - points[0].y);
    if (distance > oppositeDistance) {
      oppositeDistance = distance;
      oppositeIndex = index;
    }
  }
  for (let attempt = 0, currentTolerance = tolerance; attempt < 5; attempt += 1, currentTolerance /= 2) {
    const firstArc = simplifyOpenPath(points.slice(0, oppositeIndex + 1), currentTolerance);
    const secondArc = simplifyOpenPath([...points.slice(oppositeIndex), points[0]], currentTolerance);
    const simplified = [...firstArc.slice(0, -1), ...secondArc.slice(0, -1)];
    if (simplified.length >= 3) return simplified;
  }
  return [...points];
}

function simplifyDensePolygons(polygons: AnnotationPolygon[], width: number, height: number) {
  const tolerance = Math.max(2.5, Math.max(width, height) / 320);
  let changed = false;
  const simplified = polygons.map((polygon) => {
    if (polygon.nodes.length < 80) return polygon;
    const nodes = simplifyRing(polygon.nodes, tolerance);
    changed = changed || nodes.length < polygon.nodes.length;
    return { ...polygon, nodes };
  });
  return { polygons: simplified, changed };
}

function vectorizeMask(source: HTMLCanvasElement): AnnotationPolygon[] {
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  const { width, height } = source;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 512));
  const gridWidth = Math.ceil(width / step);
  const gridHeight = Math.ceil(height / step);
  const pixels = context.getImageData(0, 0, width, height).data;
  const visible = new Uint8Array(gridWidth * gridHeight);
  for (let gridY = 0; gridY < gridHeight; gridY += 1) {
    for (let gridX = 0; gridX < gridWidth; gridX += 1) {
      const sourceX = Math.min(width - 1, gridX * step + Math.floor(step / 2));
      const sourceY = Math.min(height - 1, gridY * step + Math.floor(step / 2));
      visible[gridY * gridWidth + gridX] = pixels[(sourceY * width + sourceX) * 4 + 3] > 0 ? 1 : 0;
    }
  }

  const visited = new Uint8Array(visible.length);
  const components: Array<Array<[number, number]>> = [];
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let startIndex = 0; startIndex < visible.length; startIndex += 1) {
    if (!visible[startIndex] || visited[startIndex]) continue;
    const queue: number[] = [startIndex];
    const component: Array<[number, number]> = [];
    visited[startIndex] = 1;
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const index = queue[queueIndex];
      const x = index % gridWidth;
      const y = Math.floor(index / gridWidth);
      component.push([x, y]);
      for (const [dx, dy] of directions) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextY < 0 || nextX >= gridWidth || nextY >= gridHeight) continue;
        const nextIndex = nextY * gridWidth + nextX;
        if (visible[nextIndex] && !visited[nextIndex]) {
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
    }
    if (component.length >= 6) components.push(component);
  }

  return components.flatMap((component, componentIndex) => {
    const cellSet = new Set(component.map(([x, y]) => `${x},${y}`));
    const edges = new Map<string, ImagePoint[]>();
    const addEdge = (start: ImagePoint, end: ImagePoint) => {
      const key = `${start.x},${start.y}`;
      edges.set(key, [...(edges.get(key) || []), end]);
    };
    for (const [x, y] of component) {
      if (!cellSet.has(`${x},${y - 1}`)) addEdge({ x, y }, { x: x + 1, y });
      if (!cellSet.has(`${x + 1},${y}`)) addEdge({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!cellSet.has(`${x},${y + 1}`)) addEdge({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!cellSet.has(`${x - 1},${y}`)) addEdge({ x, y: y + 1 }, { x, y });
    }
    const firstKey = edges.keys().next().value as string | undefined;
    if (!firstKey) return [];
    const [startX, startY] = firstKey.split(',').map(Number);
    const ring: ImagePoint[] = [{ x: startX, y: startY }];
    let currentKey = firstKey;
    const edgeCount = [...edges.values()].reduce((count, values) => count + values.length, 0);
    for (let guard = 0; guard < edgeCount + 2; guard += 1) {
      const candidates = edges.get(currentKey);
      const next = candidates?.shift();
      if (!next) break;
      ring.push(next);
      currentKey = `${next.x},${next.y}`;
      if (currentKey === firstKey) break;
    }
    const sourceRing = ring.slice(0, -1).map((point) => ({
      x: Math.min(width, point.x * step),
      y: Math.min(height, point.y * step),
    }));
    const simplified = simplifyRing(sourceRing, Math.max(2.5, step * 1.75));
    if (simplified.length < 3) return [];
    return [{
      id: crypto.randomUUID(),
      label: componentIndex === 0 ? 'Vùng hư hại' : `Vùng hư hại ${componentIndex + 1}`,
      nodes: simplified.map((point) => ({ id: crypto.randomUUID(), ...point })),
    }];
  });
}

const EditorCanvas = forwardRef<EditorCanvasHandle, Props>(function EditorCanvas(props, ref) {
  const {
    height,
    imageUrl,
    initialBreakpoints,
    initialHumanAction,
    initialOperations,
    localMaskBlob,
    maskOpacity,
    onChange,
    onMessage,
    onReady,
    onSelectionChange,
    onZoomChange,
    predictionUrl,
    currentMaskUrl,
    showMask,
    tool,
    width,
  } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const predictionRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fittedRef = useRef(false);
  const readyRef = useRef(false);
  const pointerRef = useRef<PointerActivity | null>(null);
  const [initialPolygonData] = useState(() => simplifyDensePolygons(
    polygonsFromOperations(initialOperations), width, height,
  ));
  const polygonModeRef = useRef(initialOperations.some((operation) => operation.type === 'POLYGON_SET'));
  const operationsRef = useRef<MaskOperation[]>(polygonModeRef.current
    ? polygonOperation(initialPolygonData.polygons)
    : initialOperations);
  const polygonsRef = useRef<AnnotationPolygon[]>(initialPolygonData.polygons);
  const initialPolygonsSimplifiedRef = useRef(initialPolygonData.changed);
  const polygonUndoRef = useRef<AnnotationPolygon[][]>([]);
  const polygonRedoRef = useRef<AnnotationPolygon[][]>([]);
  const selectedNodeIdsRef = useRef(new Set<string>());
  const selectedPolygonIdsRef = useRef(new Set<string>());
  const draftPolygonRef = useRef<PolygonNode[]>([]);
  const polygonHoverRef = useRef<ImagePoint | null>(null);
  const cutPathRef = useRef<PolygonNode[]>([]);
  const marqueeRef = useRef<Marquee | null>(null);
  const breakpointsRef = useRef(copyBreakpoints(initialBreakpoints));
  const pointUndoRef = useRef<BreakpointPoint[][]>([]);
  const pointRedoRef = useRef<BreakpointPoint[][]>([]);
  const selectedPointIdRef = useRef<string | null>(null);
  const [humanAction, setHumanAction] = useState<HumanAction>(initialHumanAction);
  const humanActionRef = useRef(initialHumanAction);
  const displayRef = useRef({ showMask, maskOpacity });

  const currentOperations = useCallback((polygons = polygonsRef.current): MaskOperation[] => (
    polygonModeRef.current ? polygonOperation(polygons) : [...operationsRef.current]
  ), []);

  const notifyChange = useCallback((
    nextHumanAction = humanActionRef.current,
    polygons = polygonsRef.current,
  ) => {
    onChange({
      humanAction: nextHumanAction,
      breakpoints: copyBreakpoints(breakpointsRef.current),
      maskOperations: currentOperations(polygons),
      polygons: clonePolygons(polygons),
    });
  }, [currentOperations, onChange]);

  const notifySelection = useCallback(() => {
    onSelectionChange([...selectedPolygonIdsRef.current]);
  }, [onSelectionChange]);

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
    context.fillStyle = '#f1f3f7';
    context.fillRect(0, 0, rect.width, rect.height);

    const view = viewRef.current;
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    context.drawImage(image, 0, 0, width, height);

    const display = displayRef.current;
    if (display.showMask) {
      if (polygonModeRef.current) {
        context.globalAlpha = display.maskOpacity;
        context.fillStyle = POLYGON_FILL;
        for (const polygon of polygonsRef.current) {
          if (polygon.nodes.length < 3) continue;
          context.beginPath();
          polygon.nodes.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
          context.closePath();
          context.fill();
        }
        context.globalAlpha = 1;
      } else if (tintRef.current) {
        context.globalAlpha = display.maskOpacity;
        context.drawImage(tintRef.current, 0, 0);
        context.globalAlpha = 1;
      }
    }

    if (polygonModeRef.current) {
      for (const polygon of polygonsRef.current) {
        if (polygon.nodes.length < 2) continue;
        const selected = selectedPolygonIdsRef.current.has(polygon.id);
        context.beginPath();
        polygon.nodes.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
        context.closePath();
        context.lineWidth = (selected ? 3 : 1.5) / view.scale;
        context.strokeStyle = selected ? '#6d4ef2' : POLYGON_STROKE;
        context.stroke();
        if (selected && polygon.label) {
          const anchorX = Math.min(...polygon.nodes.map((node) => node.x));
          const anchorY = Math.min(...polygon.nodes.map((node) => node.y));
          const fontSize = 12 / view.scale;
          const paddingX = 7 / view.scale;
          const tagHeight = 23 / view.scale;
          const text = polygon.label.length > 28 ? `${polygon.label.slice(0, 27)}…` : polygon.label;
          context.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
          const tagWidth = context.measureText(text).width + paddingX * 2;
          const tagY = Math.max(0, anchorY - tagHeight - 6 / view.scale);
          context.fillStyle = '#ffffff';
          context.fillRect(anchorX, tagY, tagWidth, tagHeight);
          context.fillStyle = '#344054';
          context.textBaseline = 'middle';
          context.fillText(text, anchorX + paddingX, tagY + tagHeight / 2);
        }
        if (tool === 'select' || tool === 'polygon' || tool === 'cut') {
          for (const node of polygon.nodes) {
            const nodeSelected = selectedNodeIdsRef.current.has(node.id);
            context.beginPath();
            context.arc(node.x, node.y, (nodeSelected ? 4.25 : 2.75) / view.scale, 0, Math.PI * 2);
            context.fillStyle = nodeSelected ? '#ffffff' : '#cfc4ff';
            context.fill();
            context.lineWidth = 1.5 / view.scale;
            context.strokeStyle = nodeSelected ? '#6d4ef2' : '#7c5cfa';
            context.stroke();
          }
        }
      }
    }

    const draft = draftPolygonRef.current;
    if (draft.length) {
      const hover = polygonHoverRef.current;
      const preview = hover ? [...draft, { id: 'preview', ...hover }] : draft;
      context.beginPath();
      preview.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
      if (preview.length >= 3) {
        context.closePath();
        context.globalAlpha = Math.min(0.72, Math.max(0.2, display.maskOpacity * 0.85));
        context.fillStyle = POLYGON_FILL;
        context.fill();
        context.globalAlpha = 1;
      }
      context.setLineDash([8 / view.scale, 5 / view.scale]);
      context.lineWidth = 2 / view.scale;
      context.strokeStyle = '#6d4ef2';
      context.stroke();
      context.setLineDash([]);
      for (const node of draft) {
        context.beginPath();
        context.arc(node.x, node.y, 3.5 / view.scale, 0, Math.PI * 2);
        context.fillStyle = '#7c5cfa';
        context.fill();
      }
    }

    const cutPath = cutPathRef.current;
    if (cutPath.length) {
      context.beginPath();
      cutPath.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
      context.setLineDash([10 / view.scale, 6 / view.scale]);
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = CUT_COLOR;
      context.stroke();
      context.setLineDash([]);
      for (const node of cutPath) {
        context.beginPath();
        context.arc(node.x, node.y, 4 / view.scale, 0, Math.PI * 2);
        context.fillStyle = CUT_COLOR;
        context.fill();
      }
    }

    const marquee = marqueeRef.current;
    if (marquee) {
      context.fillStyle = 'rgba(124, 92, 250, .12)';
      context.strokeStyle = '#7c5cfa';
      context.lineWidth = 1 / view.scale;
      context.fillRect(marquee.start.x, marquee.start.y, marquee.end.x - marquee.start.x, marquee.end.y - marquee.start.y);
      context.strokeRect(marquee.start.x, marquee.start.y, marquee.end.x - marquee.start.x, marquee.end.y - marquee.start.y);
    }

    for (const point of breakpointsRef.current.points) {
      context.beginPath();
      context.arc(point.x, point.y, 8 / view.scale, 0, Math.PI * 2);
      context.fillStyle = point.id === selectedPointIdRef.current ? '#ffffff' : BREAKPOINT_COLOR;
      context.fill();
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
    context.restore();
  }, [height, tool, width]);

  useEffect(() => {
    displayRef.current = { showMask, maskOpacity };
    render();
  }, [maskOpacity, render, showMask]);

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
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    for (let offset = 0; offset < data.data.length; offset += 4) {
      const visible = data.data[offset + 3] > 0
        && Math.max(data.data[offset], data.data[offset + 1], data.data[offset + 2]) > 96;
      data.data[offset] = 255;
      data.data[offset + 1] = 255;
      data.data[offset + 2] = 255;
      data.data[offset + 3] = visible ? 255 : 0;
    }
    context.putImageData(data, 0, 0);
  }, [height, width]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const scale = Math.max(0.05, Math.min((rect.width - 36) / width, (rect.height - 36) / height));
    viewRef.current = { scale, x: (rect.width - width * scale) / 2, y: (rect.height - height * scale) / 2 };
    onZoomChange?.(scale);
    render();
  }, [height, onZoomChange, render, width]);

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
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };
    void (async () => {
      const localUrl = localMaskBlob ? URL.createObjectURL(localMaskBlob) : undefined;
      try {
        const [image, prediction, current] = await Promise.all([
          loadImage(imageUrl),
          loadImage(predictionUrl),
          loadImage(localUrl || currentMaskUrl || predictionUrl),
        ]);
        if (cancelled) return;
        const predictionCanvas = makeCanvas();
        const maskCanvas = makeCanvas();
        const tintCanvas = makeCanvas();
        normalizeMask(prediction, predictionCanvas);
        normalizeMask(current, maskCanvas);
        rebuildTint(maskCanvas, tintCanvas, POLYGON_FILL);
        imageRef.current = image;
        predictionRef.current = predictionCanvas;
        maskRef.current = maskCanvas;
        tintRef.current = tintCanvas;
        readyRef.current = true;
        fittedRef.current = true;
        fit();
        if (initialPolygonsSimplifiedRef.current) {
          initialPolygonsSimplifiedRef.current = false;
          notifyChange(initialHumanAction, polygonsRef.current);
          onMessage('Đã tự rút gọn đường biên polygon để dễ chỉnh sửa.');
        }
        onReady();
      } catch (error) {
        onMessage((error as Error).message);
      } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [currentMaskUrl, fit, height, imageUrl, initialHumanAction, localMaskBlob, normalizeMask, notifyChange, onMessage, onReady, predictionUrl, rebuildTint, width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => fittedRef.current ? render() : fit());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, render]);

  const imagePoint = useCallback((event: React.MouseEvent<HTMLCanvasElement>): ImagePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left - view.x) / view.scale)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top - view.y) / view.scale)),
    };
  }, [height, width]);

  const pushPolygonHistory = useCallback((before = polygonsRef.current) => {
    polygonUndoRef.current.push(clonePolygons(before));
    if (polygonUndoRef.current.length > 80) polygonUndoRef.current.shift();
    polygonRedoRef.current = [];
  }, []);

  const commitPolygons = useCallback((next: AnnotationPolygon[], before = polygonsRef.current) => {
    pushPolygonHistory(before);
    polygonsRef.current = clonePolygons(next);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(next);
    humanActionRef.current = 'MODIFIED';
    setHumanAction('MODIFIED');
    render();
    notifyChange('MODIFIED', next);
    notifySelection();
  }, [notifyChange, notifySelection, pushPolygonHistory, render]);

  const completePolygon = useCallback(() => {
    const draft = draftPolygonRef.current;
    if (draft.length < 3) {
      onMessage('Đa giác cần ít nhất 3 node.');
      return false;
    }
    const created: AnnotationPolygon = {
      id: crypto.randomUUID(),
      label: 'Vùng hư hại',
      nodes: draft.map((node) => ({ ...node })),
    };
    draftPolygonRef.current = [];
    polygonHoverRef.current = null;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([created.id]);
    commitPolygons([...polygonsRef.current, created]);
    return true;
  }, [commitPolygons, onMessage]);

  const cancelCurrentPath = useCallback(() => {
    draftPolygonRef.current = [];
    polygonHoverRef.current = null;
    cutPathRef.current = [];
    marqueeRef.current = null;
    render();
  }, [render]);

  const applyCut = useCallback(() => {
    const selectedPolygonId = [...selectedPolygonIdsRef.current][0];
    const target = polygonsRef.current.find((polygon) => polygon.id === selectedPolygonId);
    if (!target) {
      onMessage('Hãy chọn một đa giác trước khi cắt.');
      return false;
    }
    const result = splitPolygonWithCut(target, cutPathRef.current);
    if (!result.polygons) {
      onMessage(result.error || 'Không thể cắt đa giác.');
      return false;
    }
    const next = polygonsRef.current.flatMap((polygon) => polygon.id === target.id ? result.polygons! : [polygon]);
    cutPathRef.current = [];
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set(result.polygons.map((polygon) => polygon.id));
    commitPolygons(next);
    onMessage('Đã tách đa giác thành 2 vùng con. Có thể lặp lại Cut để chia tiếp.');
    return true;
  }, [commitPolygons, onMessage]);

  const deleteSelection = useCallback(() => {
    const selectedNodes = selectedNodeIdsRef.current;
    const selectedPolygons = selectedPolygonIdsRef.current;
    if (!selectedNodes.size && !selectedPolygons.size) return;
    const next = polygonsRef.current.flatMap((polygon) => {
      if (!selectedNodes.size && selectedPolygons.has(polygon.id)) return [];
      const nodes = polygon.nodes.filter((node) => !selectedNodes.has(node.id));
      return nodes.length >= 3 ? [{ ...polygon, nodes }] : [];
    });
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    commitPolygons(next);
  }, [commitPolygons]);

  const deleteSelectedPoint = useCallback(() => {
    const selectedPointId = selectedPointIdRef.current;
    if (!selectedPointId) return;
    const before = breakpointsRef.current.points.map((point) => ({ ...point }));
    const points = before.filter((point) => point.id !== selectedPointId);
    if (points.length === before.length) return;
    pointUndoRef.current.push(before);
    pointRedoRef.current = [];
    selectedPointIdRef.current = null;
    breakpointsRef.current = { state: points.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points };
    render();
    notifyChange();
  }, [notifyChange, render]);

  const hitNode = useCallback((point: ImagePoint) => {
    const radius = 12 / viewRef.current.scale;
    for (let polygonIndex = polygonsRef.current.length - 1; polygonIndex >= 0; polygonIndex -= 1) {
      const polygon = polygonsRef.current[polygonIndex];
      for (let nodeIndex = polygon.nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
        const node = polygon.nodes[nodeIndex];
        if (Math.hypot(node.x - point.x, node.y - point.y) <= radius) return { polygon, node };
      }
    }
    return null;
  }, []);

  const hitPolygon = useCallback((point: ImagePoint) => {
    for (let index = polygonsRef.current.length - 1; index >= 0; index -= 1) {
      if (pointInPolygon(point, polygonsRef.current[index].nodes)) return polygonsRef.current[index];
    }
    return null;
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyRef.current || event.button !== 0) return;
    const point = imagePoint(event);
    if (tool === 'pan') {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = { id: event.pointerId, mode: 'pan', lastClient: { x: event.clientX, y: event.clientY } };
      return;
    }
    if (tool === 'point') {
      const hitRadius = 14 / viewRef.current.scale;
      const hit = breakpointsRef.current.points.find((item) => Math.hypot(item.x - point.x, item.y - point.y) <= hitRadius);
      const before = breakpointsRef.current.points.map((item) => ({ ...item }));
      if (hit) {
        event.currentTarget.setPointerCapture(event.pointerId);
        selectedPointIdRef.current = hit.id;
        pointerRef.current = { id: event.pointerId, mode: 'point', pointBefore: before, draggedPointId: hit.id, moved: false };
        render();
      } else {
        const created = { id: crypto.randomUUID(), x: point.x, y: point.y };
        pointUndoRef.current.push(before);
        pointRedoRef.current = [];
        selectedPointIdRef.current = created.id;
        breakpointsRef.current = { state: 'ANNOTATED', points: [...before, created] };
        render();
        notifyChange();
      }
      return;
    }
    if (tool === 'polygon') {
      const first = draftPolygonRef.current[0];
      if (first && draftPolygonRef.current.length >= 3 && Math.hypot(first.x - point.x, first.y - point.y) <= 14 / viewRef.current.scale) {
        completePolygon();
      } else {
        draftPolygonRef.current = [...draftPolygonRef.current, { id: crypto.randomUUID(), ...point }];
        render();
      }
      return;
    }
    if (tool === 'cut') {
      if (!selectedPolygonIdsRef.current.size) {
        const polygon = hitPolygon(point);
        if (polygon) {
          selectedPolygonIdsRef.current = new Set([polygon.id]);
          notifySelection();
        }
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      cutPathRef.current = [{ id: crypto.randomUUID(), ...point }];
      pointerRef.current = { id: event.pointerId, mode: 'cut', last: point };
      render();
      return;
    }

    const nodeHit = hitNode(point);
    if (nodeHit) {
      if (!event.shiftKey && !selectedNodeIdsRef.current.has(nodeHit.node.id)) selectedNodeIdsRef.current.clear();
      selectedNodeIdsRef.current.add(nodeHit.node.id);
      if (!event.shiftKey) selectedPolygonIdsRef.current = new Set([nodeHit.polygon.id]);
      else selectedPolygonIdsRef.current.add(nodeHit.polygon.id);
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = {
        id: event.pointerId,
        mode: 'nodes',
        start: point,
        original: clonePolygons(polygonsRef.current),
        nodeIds: new Set(selectedNodeIdsRef.current),
        moved: false,
      };
      notifySelection();
      render();
      return;
    }
    const polygonHit = hitPolygon(point);
    if (polygonHit) {
      selectedNodeIdsRef.current.clear();
      if (!event.shiftKey && !selectedPolygonIdsRef.current.has(polygonHit.id)) selectedPolygonIdsRef.current.clear();
      selectedPolygonIdsRef.current.add(polygonHit.id);
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = {
        id: event.pointerId,
        mode: 'polygons',
        start: point,
        original: clonePolygons(polygonsRef.current),
        polygonIds: new Set(selectedPolygonIdsRef.current),
        moved: false,
      };
      notifySelection();
      render();
      return;
    }

    if (!event.shiftKey) {
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeRef.current = { start: point, end: point, additive: event.shiftKey };
    pointerRef.current = { id: event.pointerId, mode: 'marquee', start: point, additive: event.shiftKey };
    notifySelection();
    render();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== 'polygon' && tool !== 'select') return;
    event.preventDefault();
    if (tool === 'polygon') {
      // Hai lần pointer-down của double click đã thêm cùng một đỉnh hai lần.
      // Giữ lần nhấp đầu làm đỉnh cuối và bỏ bản sao trước khi hoàn tất.
      if (draftPolygonRef.current.length > 1) {
        draftPolygonRef.current = draftPolygonRef.current.slice(0, -1);
      }
      if (draftPolygonRef.current.length >= 3) completePolygon();
      else render();
      return;
    }

    const point = imagePoint(event);
    let polygon = hitPolygon(point);
    let edge = polygon ? closestPolygonEdge(polygon, point) : null;
    if (!polygon) {
      const hitTolerance = 14 / viewRef.current.scale;
      for (let index = polygonsRef.current.length - 1; index >= 0; index -= 1) {
        const candidatePolygon = polygonsRef.current[index];
        const candidateEdge = closestPolygonEdge(candidatePolygon, point);
        if (candidateEdge && candidateEdge.distance <= hitTolerance) {
          polygon = candidatePolygon;
          edge = candidateEdge;
          break;
        }
      }
    }
    if (!polygon || !edge) {
      onMessage('Nhấp đúp lên polygon hoặc cạnh của polygon để thêm điểm.');
      return;
    }
    const edgeStart = polygon.nodes[edge.edgeIndex];
    const edgeEnd = polygon.nodes[(edge.edgeIndex + 1) % polygon.nodes.length];
    const endpointTolerance = 6 / viewRef.current.scale;
    if (Math.hypot(edge.point.x - edgeStart.x, edge.point.y - edgeStart.y) <= endpointTolerance
        || Math.hypot(edge.point.x - edgeEnd.x, edge.point.y - edgeEnd.y) <= endpointTolerance) {
      onMessage('Hãy nhấp đúp vào khoảng giữa hai điểm để thêm một điểm mới.');
      return;
    }
    const insertedNode = { id: crypto.randomUUID(), ...edge.point };
    selectedPolygonIdsRef.current = new Set([polygon.id]);
    selectedNodeIdsRef.current = new Set([insertedNode.id]);
    const next = polygonsRef.current.map((item) => item.id === polygon!.id
      ? { ...item, nodes: [...item.nodes.slice(0, edge!.edgeIndex + 1), insertedNode, ...item.nodes.slice(edge!.edgeIndex + 1)] }
      : item);
    commitPolygons(next);
    onMessage('Đã thêm một điểm mới vào polygon.');
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (!active) {
      if (tool === 'polygon' && draftPolygonRef.current.length) {
        polygonHoverRef.current = imagePoint(event);
        render();
      }
      return;
    }
    if (active.id !== event.pointerId) return;
    if (active.mode === 'pan') {
      viewRef.current.x += event.clientX - active.lastClient.x;
      viewRef.current.y += event.clientY - active.lastClient.y;
      active.lastClient = { x: event.clientX, y: event.clientY };
      fittedRef.current = true;
      render();
      return;
    }
    const point = imagePoint(event);
    if (active.mode === 'cut') {
      if (Math.hypot(point.x - active.last.x, point.y - active.last.y) >= 2 / viewRef.current.scale) {
        cutPathRef.current = [...cutPathRef.current, { id: crypto.randomUUID(), ...point }];
        active.last = point;
        render();
      }
      return;
    }
    if (active.mode === 'nodes' || active.mode === 'polygons') {
      const deltaX = point.x - active.start.x;
      const deltaY = point.y - active.start.y;
      active.moved = active.moved || Math.hypot(deltaX, deltaY) > 0.5;
      polygonsRef.current = active.original.map((polygon) => ({
        ...polygon,
        nodes: polygon.nodes.map((node) => {
          const shouldMove = active.mode === 'nodes' ? active.nodeIds.has(node.id) : active.polygonIds.has(polygon.id);
          return shouldMove
            ? { ...node, x: Math.max(0, Math.min(width, node.x + deltaX)), y: Math.max(0, Math.min(height, node.y + deltaY)) }
            : { ...node };
        }),
      }));
      polygonModeRef.current = true;
      render();
      return;
    }
    if (active.mode === 'marquee') {
      marqueeRef.current = { start: active.start, end: point, additive: active.additive };
      render();
      return;
    }
    const next = breakpointsRef.current.points.map((item) => item.id === active.draggedPointId ? { ...item, ...point } : item);
    const original = active.pointBefore.find((item) => item.id === active.draggedPointId);
    active.moved = active.moved || Boolean(original && Math.hypot(original.x - point.x, original.y - point.y) > 0.5);
    breakpointsRef.current = { state: 'ANNOTATED', points: next };
    render();
  };

  const onPointerLeave = () => {
    if (!pointerRef.current && polygonHoverRef.current) {
      polygonHoverRef.current = null;
      render();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const active = pointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    pointerRef.current = null;
    if (active.mode === 'nodes' || active.mode === 'polygons') {
      if (active.moved) {
        pushPolygonHistory(active.original);
        operationsRef.current = polygonOperation(polygonsRef.current);
        polygonModeRef.current = true;
        humanActionRef.current = 'MODIFIED';
        setHumanAction('MODIFIED');
        notifyChange('MODIFIED');
      }
      return;
    }
    if (active.mode === 'cut') {
      render();
      return;
    }
    if (active.mode === 'marquee') {
      const marquee = marqueeRef.current;
      marqueeRef.current = null;
      if (marquee) {
        const left = Math.min(marquee.start.x, marquee.end.x);
        const right = Math.max(marquee.start.x, marquee.end.x);
        const top = Math.min(marquee.start.y, marquee.end.y);
        const bottom = Math.max(marquee.start.y, marquee.end.y);
        const selected = marquee.additive ? new Set(selectedNodeIdsRef.current) : new Set<string>();
        const polygonIds = marquee.additive ? new Set(selectedPolygonIdsRef.current) : new Set<string>();
        for (const polygon of polygonsRef.current) {
          for (const node of polygon.nodes) {
            if (node.x >= left && node.x <= right && node.y >= top && node.y <= bottom) {
              selected.add(node.id);
              polygonIds.add(polygon.id);
            }
          }
        }
        selectedNodeIdsRef.current = selected;
        selectedPolygonIdsRef.current = polygonIds;
        notifySelection();
      }
      render();
      return;
    }
    if (active.mode === 'point' && active.moved) {
      pointUndoRef.current.push(active.pointBefore);
      pointRedoRef.current = [];
      notifyChange();
    }
  };

  const undo = useCallback(() => {
    if (tool === 'point') {
      const previous = pointUndoRef.current.pop();
      if (!previous) return;
      pointRedoRef.current.push(breakpointsRef.current.points.map((point) => ({ ...point })));
      breakpointsRef.current = { state: previous.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points: previous };
      selectedPointIdRef.current = null;
      render();
      notifyChange();
      return;
    }
    const previous = polygonUndoRef.current.pop();
    if (!previous) return;
    polygonRedoRef.current.push(clonePolygons(polygonsRef.current));
    polygonsRef.current = clonePolygons(previous);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(previous);
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    humanActionRef.current = 'MODIFIED';
    setHumanAction('MODIFIED');
    render();
    notifyChange('MODIFIED', previous);
    notifySelection();
  }, [notifyChange, notifySelection, render, tool]);

  const redo = useCallback(() => {
    if (tool === 'point') {
      const next = pointRedoRef.current.pop();
      if (!next) return;
      pointUndoRef.current.push(breakpointsRef.current.points.map((point) => ({ ...point })));
      breakpointsRef.current = { state: next.length ? 'ANNOTATED' : 'NOT_ANNOTATED', points: next };
      selectedPointIdRef.current = null;
      render();
      notifyChange();
      return;
    }
    const next = polygonRedoRef.current.pop();
    if (!next) return;
    polygonUndoRef.current.push(clonePolygons(polygonsRef.current));
    polygonsRef.current = clonePolygons(next);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(next);
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    humanActionRef.current = 'MODIFIED';
    setHumanAction('MODIFIED');
    render();
    notifyChange('MODIFIED', next);
    notifySelection();
  }, [notifyChange, notifySelection, render, tool]);

  const beginPolygonEdit = useCallback(() => {
    if (polygonModeRef.current && polygonsRef.current.length) return polygonsRef.current.length;
    const source = humanActionRef.current === 'UNTOUCHED'
      ? predictionRef.current
      : maskRef.current;
    if (!source) return 0;
    const vectorized = vectorizeMask(source);
    if (!vectorized.length) {
      onMessage('Không tìm thấy vùng mask để chuyển thành đa giác. Bạn có thể dùng Vẽ đa giác để tạo vùng mới.');
      return 0;
    }
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set(vectorized.map((polygon) => polygon.id));
    commitPolygons(vectorized);
    onMessage(`Đã chuyển mask thành ${vectorized.length} đa giác có thể chỉnh sửa.`);
    return vectorized.length;
  }, [commitPolygons, onMessage]);

  const selectPolygon = useCallback((polygonId: string) => {
    if (!polygonsRef.current.some((polygon) => polygon.id === polygonId)) return;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([polygonId]);
    notifySelection();
    render();
  }, [notifySelection, render]);

  const updateSelectedPolygonLabel = useCallback((label: string) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel || !selectedPolygonIdsRef.current.size) {
      onMessage('Hãy chọn polygon và nhập label hợp lệ.');
      return false;
    }
    const next = polygonsRef.current.map((polygon) => (
      selectedPolygonIdsRef.current.has(polygon.id)
        ? { ...polygon, label: normalizedLabel }
        : polygon
    ));
    if (next.every((polygon, index) => polygon.label === polygonsRef.current[index].label)) return true;
    commitPolygons(next);
    onMessage(`Đã gán label “${normalizedLabel}” cho ${selectedPolygonIdsRef.current.size} polygon.`);
    return true;
  }, [commitPolygons, onMessage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement
          && target.matches('input, select, textarea, [contenteditable="true"]')) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'select') {
        event.preventDefault();
        deleteSelection();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'point') {
        event.preventDefault();
        deleteSelectedPoint();
      } else if (event.key === 'Enter' && tool === 'polygon') {
        event.preventDefault();
        completePolygon();
      } else if (event.key === 'Enter' && tool === 'cut') {
        event.preventDefault();
        applyCut();
      } else if (event.key === 'Escape') {
        cancelCurrentPath();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyCut, cancelCurrentPath, completePolygon, deleteSelectedPoint, deleteSelection, redo, tool, undo]);

  useImperativeHandle(ref, () => ({
    exportMask: async () => {
      if (polygonModeRef.current) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Mask chưa sẵn sàng.');
        context.fillStyle = '#ffffff';
        for (const polygon of polygonsRef.current) {
          if (polygon.nodes.length < 3) continue;
          context.beginPath();
          polygon.nodes.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
          context.closePath();
          context.fill();
        }
        return toBlob(canvas);
      }
      if (!maskRef.current) throw new Error('Mask chưa sẵn sàng.');
      return toBlob(maskRef.current);
    },
    resetToPrediction: () => {
      const mask = maskRef.current;
      const prediction = predictionRef.current;
      if (mask && prediction) {
        const context = mask.getContext('2d');
        context?.clearRect(0, 0, width, height);
        context?.drawImage(prediction, 0, 0);
        if (tintRef.current) rebuildTint(mask, tintRef.current, POLYGON_FILL);
      }
      polygonsRef.current = [];
      polygonModeRef.current = false;
      operationsRef.current = [{ type: 'RESET_TO_PREDICTION' }];
      polygonUndoRef.current = [];
      polygonRedoRef.current = [];
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      humanActionRef.current = 'MODIFIED';
      setHumanAction('MODIFIED');
      render();
      notifyChange('MODIFIED', []);
      notifySelection();
    },
    acceptPrediction: () => {
      const mask = maskRef.current;
      const prediction = predictionRef.current;
      if (mask && prediction) {
        const context = mask.getContext('2d');
        context?.clearRect(0, 0, width, height);
        context?.drawImage(prediction, 0, 0);
        if (tintRef.current) rebuildTint(mask, tintRef.current, POLYGON_FILL);
      }
      polygonsRef.current = [];
      polygonModeRef.current = false;
      operationsRef.current = [];
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      humanActionRef.current = 'ACCEPTED';
      setHumanAction('ACCEPTED');
      render();
      notifyChange('ACCEPTED', []);
      notifySelection();
    },
    undo,
    redo,
    deleteSelectedPoint,
    deleteSelection,
    completePolygon,
    cancelCurrentPath,
    applyCut,
    beginPolygonEdit,
    selectPolygon,
    updateSelectedPolygonLabel,
    confirmNoBreakpoint: () => {
      pointUndoRef.current.push(breakpointsRef.current.points.map((point) => ({ ...point })));
      pointRedoRef.current = [];
      selectedPointIdRef.current = null;
      breakpointsRef.current = { state: 'CONFIRMED_NONE', points: [] };
      render();
      notifyChange();
    },
    fit,
    zoomBy: (factor) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const view = viewRef.current;
      const next = Math.max(0.05, Math.min(20, view.scale * factor));
      const imageX = (rect.width / 2 - view.x) / view.scale;
      const imageY = (rect.height / 2 - view.y) / view.scale;
      viewRef.current = { scale: next, x: rect.width / 2 - imageX * next, y: rect.height / 2 - imageY * next };
      fittedRef.current = true;
      onZoomChange?.(next);
      render();
    },
  }), [applyCut, beginPolygonEdit, cancelCurrentPath, completePolygon, deleteSelectedPoint, deleteSelection, fit, height, notifyChange, notifySelection, onZoomChange, rebuildTint, redo, render, selectPolygon, undo, updateSelectedPolygonLabel, width]);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const imageX = (mouseX - view.x) / view.scale;
    const imageY = (mouseY - view.y) / view.scale;
    const next = Math.max(0.05, Math.min(20, view.scale * Math.exp(-event.deltaY * 0.001)));
    viewRef.current = { scale: next, x: mouseX - imageX * next, y: mouseY - imageY * next };
    fittedRef.current = true;
    onZoomChange?.(next);
    render();
  };

  return (
    <div className={`canvas-viewport tool-${tool}`} ref={viewportRef}>
      <canvas
        ref={stageRef}
        aria-label="Khung chỉnh sửa vùng chọn đa giác"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      />
      <div className="canvas-hint">
        {tool === 'polygon'
          ? 'Nhấp để thêm điểm · Nhấp đúp hoặc nhấn Enter để hoàn tất'
          : tool === 'select'
            ? 'Kéo điểm để chỉnh sửa · Nhấp đúp lên polygon để thêm điểm · Delete để xóa'
            : tool === 'cut'
              ? 'Kéo một đường cắt qua đa giác · Enter để tách vùng'
              : humanAction === 'ACCEPTED'
                ? 'Đã chấp nhận mặt nạ gợi ý'
                : humanAction === 'MODIFIED'
                  ? 'Vùng chọn đã chỉnh sửa'
                  : 'Chưa xác nhận vùng chọn'}
      </div>
    </div>
  );
});

export default EditorCanvas;
