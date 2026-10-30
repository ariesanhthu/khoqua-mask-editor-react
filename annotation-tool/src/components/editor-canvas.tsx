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
import {
  clipPolygonDifference,
  clonePolygons,
  computeSmoothNodeDisplacements,
  createCirclePolygon,
  createRectanglePolygon,
  drawSmoothClosedPath,
  ensurePolygonHasNodeAt,
  findMultiPolygonAutofillPath,
  findSnapTargetToPolygons,
  getSmoothSegmentControlPoints,
  insertNodeAtEdge,
  mergePolygonsIntoSingle,
  pointInPolygon,
  splitPolygonWithCut,
  type SnapTarget,
} from '@/lib/polygon-geometry';

export type EditorTool = 'polygon' | 'rectangle' | 'circle' | 'anchor' | 'select' | 'cut' | 'point' | 'pan';

export interface EditorCanvasSnapshot {
  humanAction: HumanAction;
  breakpoints: BreakpointAnnotation;
  maskOperations: MaskOperation[];
  polygons: AnnotationPolygon[];
}

export interface EditorHistoryState {
  local: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface EditorCanvasHandle {
  exportMask(): Promise<Blob>;
  resetToPrediction(): void;
  acceptPrediction(): void;
  undo(): void;
  redo(): void;
  deleteSelectedPoint(): void;
  deleteSelection(): void;
  selectAllPolygons(): void;
  clearAllPolygons(): void;
  confirmNoBreakpoint(): void;
  completePolygon(): boolean;
  cancelCurrentPath(): void;
  applyCut(): boolean;
  beginPolygonEdit(): number;
  selectPolygon(polygonId: string): void;
  updateSelectedPolygonLabel(label: string): boolean;
  groupSelectedPolygons(): boolean;
  fit(): void;
  zoomBy(factor: number): void;
}

interface Props {
  readOnly?: boolean;
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
  onHistoryChange?(state: EditorHistoryState): void;
  onPolygonComplete?(): void;
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
  | { id: number; mode: 'nodes'; start: ImagePoint; original: AnnotationPolygon[]; historyBefore?: AnnotationPolygon[]; nodeIds: Set<string>; moved: boolean }
  | { id: number; mode: 'polygons'; start: ImagePoint; original: AnnotationPolygon[]; polygonIds: Set<string>; moved: boolean }
  | { id: number; mode: 'marquee'; start: ImagePoint; additive: boolean }
  | { id: number; mode: 'point'; pointBefore: BreakpointPoint[]; draggedPointId: string; moved: boolean }
  | { id: number; mode: 'rectangle'; start: ImagePoint; current: ImagePoint }
  | { id: number; mode: 'circle'; start: ImagePoint; current: ImagePoint; shiftKey: boolean; altKey: boolean };

const POLYGON_FILL = '#7c5cfa';
const POLYGON_STROKE = '#7c5cfa';
// Wart overlay temporarily hidden: const BREAKPOINT_COLOR = '#6d4ef2';
const CUT_COLOR = '#f04438';

type PolygonBounds = { left: number; right: number; top: number; bottom: number };
const polygonBoundsCache = new WeakMap<AnnotationPolygon, PolygonBounds>();

function polygonBounds(polygon: AnnotationPolygon): PolygonBounds {
  const cached = polygonBoundsCache.get(polygon);
  if (cached) return cached;
  const bounds = polygon.nodes.reduce<PolygonBounds>((result, node) => ({
    left: Math.min(result.left, node.x),
    right: Math.max(result.right, node.x),
    top: Math.min(result.top, node.y),
    bottom: Math.max(result.bottom, node.y),
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  polygonBoundsCache.set(polygon, bounds);
  return bounds;
}

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
  let closest: { edgeIndex: number; point: ImagePoint; distance: number } | null = null;
  for (let edgeIndex = 0; edgeIndex < polygon.nodes.length; edgeIndex += 1) {
    const candidate = closestPointOnSegment(
      point,
      polygon.nodes[edgeIndex],
      polygon.nodes[(edgeIndex + 1) % polygon.nodes.length],
    );
    if (!closest || candidate.distance < closest.distance) closest = { edgeIndex, ...candidate };
  }
  return closest;
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
  const { width, height } = source;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 512));
  const gridWidth = Math.ceil(width / step);
  const gridHeight = Math.ceil(height / step);
  const sample = document.createElement('canvas');
  sample.width = gridWidth;
  sample.height = gridHeight;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, gridWidth, gridHeight);
  const pixels = context.getImageData(0, 0, gridWidth, gridHeight).data;
  const visible = new Uint8Array(gridWidth * gridHeight);
  for (let gridY = 0; gridY < gridHeight; gridY += 1) {
    for (let gridX = 0; gridX < gridWidth; gridX += 1) {
      visible[gridY * gridWidth + gridX] = pixels[(gridY * gridWidth + gridX) * 4 + 3] > 0 ? 1 : 0;
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
    onHistoryChange,
    onPolygonComplete,
    onSelectionChange,
    onZoomChange,
    predictionUrl,
    currentMaskUrl,
    showMask,
    tool,
    width,
  } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const predictionRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fittedRef = useRef(false);
  const readyRef = useRef(false);
  const pointerRef = useRef<PointerActivity | null>(null);
  const suppressContextMenuSelectionRef = useRef(false);
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
  const draftEditingRef = useRef(false);
  const draftUndoRef = useRef<PolygonNode[][]>([]);
  const draftRedoRef = useRef<PolygonNode[][]>([]);
  const hoveredNodeRef = useRef<PolygonNode | null>(null);
  const lastHistoryRef = useRef('');
  const polygonHoverRef = useRef<ImagePoint | null>(null);
  const snapTargetRef = useRef<SnapTarget | null>(null);
  const draftAutofillRef = useRef<{
    polygon?: AnnotationPolygon;
    targetPolygons?: AnnotationPolygon[];
    nodes: Array<{ id: string; x: number; y: number; isAnchor: boolean }>;
    closingToStart?: boolean;
  } | null>(null);
  const anchorHoverRef = useRef<{ polygon: AnnotationPolygon; edgeIndex: number; point: ImagePoint } | null>(null);
  const cutPathRef = useRef<PolygonNode[]>([]);
  const marqueeRef = useRef<Marquee | null>(null);
  const breakpointsRef = useRef(copyBreakpoints(initialBreakpoints));
  const pointUndoRef = useRef<BreakpointPoint[][]>([]);
  const pointRedoRef = useRef<BreakpointPoint[][]>([]);
  const selectedPointIdRef = useRef<string | null>(null);
  const humanActionRef = useRef(initialHumanAction);
  const displayRef = useRef({ showMask, maskOpacity });
  const toolRef = useRef(tool);
  const renderFrameRef = useRef<number | null>(null);

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

  const renderNow = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || !readyRef.current) return;
    const context = stage.getContext('2d');
    if (!context) return;
    const rect = stage.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
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
    const viewportPadding = 20 / view.scale;
    const viewportBounds = {
      left: -view.x / view.scale - viewportPadding,
      right: (rect.width - view.x) / view.scale + viewportPadding,
      top: -view.y / view.scale - viewportPadding,
      bottom: (rect.height - view.y) / view.scale + viewportPadding,
    };
    const visiblePolygons = polygonModeRef.current
      ? polygonsRef.current.filter((polygon) => {
        const bounds = polygonBounds(polygon);
        return bounds.right >= viewportBounds.left && bounds.left <= viewportBounds.right
          && bounds.bottom >= viewportBounds.top && bounds.top <= viewportBounds.bottom;
      })
      : [];
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    context.drawImage(image, 0, 0, width, height);

    const display = displayRef.current;
    if (display.showMask) {
      if (polygonModeRef.current) {
        context.globalAlpha = display.maskOpacity;
        context.fillStyle = POLYGON_FILL;
        for (const polygon of visiblePolygons) {
          if (polygon.nodes.length < 3) continue;
          context.beginPath();
          const others = visiblePolygons.filter((p) => p.id !== polygon.id);
          drawSmoothClosedPath(context, polygon.nodes, 0.08, others);
          context.fill();
        }
        context.globalAlpha = 1;
      } else if (tintRef.current && toolRef.current !== 'circle' && toolRef.current !== 'rectangle' && toolRef.current !== 'polygon') {
        context.globalAlpha = display.maskOpacity;
        context.drawImage(tintRef.current, 0, 0);
        context.globalAlpha = 1;
      }
    }

    if (polygonModeRef.current) {
      for (const polygon of visiblePolygons) {
        if (polygon.nodes.length < 2) continue;
        const selected = selectedPolygonIdsRef.current.has(polygon.id);
        context.beginPath();
        const others = visiblePolygons.filter((p) => p.id !== polygon.id);
        drawSmoothClosedPath(context, polygon.nodes, 0.08, others);
        context.lineWidth = (selected ? 3 : 1.5) / view.scale;
        context.strokeStyle = selected ? '#6d4ef2' : POLYGON_STROKE;
        context.stroke();
        if (selected && polygon.label) {
          const bounds = polygonBounds(polygon);
          const anchorX = bounds.left;
          const anchorY = bounds.top;
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
        if (toolRef.current === 'anchor') {
          for (const node of polygon.nodes) {
            if (!node.isAnchor) continue;
            const nodeSelected = selectedNodeIdsRef.current.has(node.id);
            const nodeRadius = (nodeSelected ? 2.8 : 2.0) / view.scale;
            context.beginPath();
            context.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
            context.fillStyle = nodeSelected ? '#ffffff' : '#cfc4ff';
            context.fill();
            context.lineWidth = 1.0 / view.scale;
            context.strokeStyle = nodeSelected ? '#6d4ef2' : '#7c5cfa';
            context.stroke();
            if (hoveredNodeRef.current?.id === node.id) {
              context.beginPath();
              context.arc(node.x, node.y, nodeRadius + 1.5 / view.scale, 0, Math.PI * 2);
              context.strokeStyle = '#6d4ef2';
              context.lineWidth = 1.0 / view.scale;
              context.stroke();
            }
          }
        }
      }
    }

    const draft = draftPolygonRef.current;
    if (draft.length) {
      const hover = polygonHoverRef.current;
      const autofill = draftAutofillRef.current;
      const preview = hover
        ? (autofill
            ? (autofill.closingToStart ? [...draft, ...autofill.nodes] : [...draft, { id: 'preview', ...hover }, ...autofill.nodes])
            : [...draft, { id: 'preview', ...hover }])
        : (autofill ? [...draft, ...autofill.nodes] : draft);
      context.beginPath();
      if (preview.length >= 3) {
        drawSmoothClosedPath(context, preview, 0.08, polygonsRef.current);
        context.globalAlpha = Math.min(0.72, Math.max(0.2, display.maskOpacity * 0.85));
        context.fillStyle = POLYGON_FILL;
        context.fill();
        context.globalAlpha = 1;
        context.setLineDash([8 / view.scale, 5 / view.scale]);
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = autofill ? '#10b981' : '#6d4ef2';
        context.stroke();
        context.setLineDash([]);
      } else {
        preview.forEach((node, index) => index === 0 ? context.moveTo(node.x, node.y) : context.lineTo(node.x, node.y));
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = '#6d4ef2';
        context.stroke();
      }
      for (const node of draft) {
        context.beginPath();
        context.arc(node.x, node.y, 3.5 / view.scale, 0, Math.PI * 2);
        context.fillStyle = '#7c5cfa';
        context.fill();
      }
      if (autofill && autofill.nodes.length) {
        context.beginPath();
        autofill.nodes.forEach((node, idx) => {
          if (idx === 0) context.moveTo(node.x, node.y);
          else context.lineTo(node.x, node.y);
        });
        context.lineWidth = 2.5 / view.scale;
        context.strokeStyle = '#10b981';
        context.stroke();
        for (const node of autofill.nodes) {
          context.beginPath();
          context.arc(node.x, node.y, 2.5 / view.scale, 0, Math.PI * 2);
          context.fillStyle = '#10b981';
          context.fill();
        }
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

    const activePointer = pointerRef.current;
    if (activePointer?.mode === 'rectangle') {
      const minX = Math.min(activePointer.start.x, activePointer.current.x);
      const maxX = Math.max(activePointer.start.x, activePointer.current.x);
      const minY = Math.min(activePointer.start.y, activePointer.current.y);
      const maxY = Math.max(activePointer.start.y, activePointer.current.y);
      const rectW = maxX - minX;
      const rectH = maxY - minY;
      if (rectW > 0 && rectH > 0) {
        context.save();
        context.beginPath();
        context.rect(minX, minY, rectW, rectH);
        context.globalAlpha = Math.min(0.72, Math.max(0.2, display.maskOpacity * 0.85));
        context.fillStyle = POLYGON_FILL;
        context.fill();
        context.globalAlpha = 1;
        context.setLineDash([8 / view.scale, 5 / view.scale]);
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = '#6d4ef2';
        context.stroke();
        context.setLineDash([]);
        const corners = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
        for (const corner of corners) {
          context.beginPath();
          context.arc(corner.x, corner.y, 3.5 / view.scale, 0, Math.PI * 2);
          context.fillStyle = '#ffffff';
          context.fill();
          context.lineWidth = 1.5 / view.scale;
          context.strokeStyle = '#6d4ef2';
          context.stroke();
        }
        const text = `${Math.round(rectW)} × ${Math.round(rectH)} px`;
        context.font = `700 ${11 / view.scale}px ui-sans-serif, system-ui, sans-serif`;
        const textWidth = context.measureText(text).width + 10 / view.scale;
        const tagHeight = 18 / view.scale;
        context.fillStyle = 'rgba(16, 24, 40, 0.88)';
        context.fillRect(minX, Math.max(0, minY - tagHeight - 5 / view.scale), textWidth, tagHeight);
        context.fillStyle = '#ffffff';
        context.textBaseline = 'middle';
        context.fillText(text, minX + 5 / view.scale, Math.max(tagHeight / 2, minY - tagHeight / 2 - 5 / view.scale));
        context.restore();
      }
    }

    if (activePointer?.mode === 'circle') {
      let cx: number;
      let cy: number;
      let rx: number;
      let ry: number;
      if (activePointer.altKey) {
        cx = activePointer.start.x;
        cy = activePointer.start.y;
        if (activePointer.shiftKey) {
          const r = Math.hypot(activePointer.current.x - activePointer.start.x, activePointer.current.y - activePointer.start.y);
          rx = r;
          ry = r;
        } else {
          rx = Math.abs(activePointer.current.x - activePointer.start.x);
          ry = Math.abs(activePointer.current.y - activePointer.start.y);
        }
      } else {
        const minX = Math.min(activePointer.start.x, activePointer.current.x);
        const maxX = Math.max(activePointer.start.x, activePointer.current.x);
        const minY = Math.min(activePointer.start.y, activePointer.current.y);
        const maxY = Math.max(activePointer.start.y, activePointer.current.y);
        rx = (maxX - minX) / 2;
        ry = (maxY - minY) / 2;
        if (activePointer.shiftKey) {
          const r = Math.max(rx, ry);
          rx = r;
          ry = r;
          cx = activePointer.start.x < activePointer.current.x ? activePointer.start.x + r : activePointer.start.x - r;
          cy = activePointer.start.y < activePointer.current.y ? activePointer.start.y + r : activePointer.start.y - r;
        } else {
          cx = minX + rx;
          cy = minY + ry;
        }
      }
      if (rx > 0 && ry > 0) {
        context.save();
        context.beginPath();
        context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        context.globalAlpha = Math.min(0.72, Math.max(0.2, display.maskOpacity * 0.85));
        context.fillStyle = POLYGON_FILL;
        context.fill();
        context.globalAlpha = 1;
        context.setLineDash([8 / view.scale, 5 / view.scale]);
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = '#6d4ef2';
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.arc(cx, cy, 2.5 / view.scale, 0, Math.PI * 2);
        context.fillStyle = '#6d4ef2';
        context.fill();
        const tagText = Math.abs(rx - ry) < 1
          ? `R: ${Math.round(rx)} px`
          : `${Math.round(rx * 2)} × ${Math.round(ry * 2)} px`;
        context.font = `700 ${11 / view.scale}px ui-sans-serif, system-ui, sans-serif`;
        const textWidth = context.measureText(tagText).width + 10 / view.scale;
        const tagHeight = 18 / view.scale;
        context.fillStyle = 'rgba(16, 24, 40, 0.88)';
        context.fillRect(cx - textWidth / 2, Math.max(0, cy - ry - tagHeight - 5 / view.scale), textWidth, tagHeight);
        context.fillStyle = '#ffffff';
        context.textBaseline = 'middle';
        context.textAlign = 'center';
        context.fillText(tagText, cx, Math.max(tagHeight / 2, cy - ry - tagHeight / 2 - 5 / view.scale));
        context.restore();
      }
    }

    const anchorHover = anchorHoverRef.current;
    if (toolRef.current === 'anchor' && anchorHover && !pointerRef.current) {
      context.save();
      const nodes = anchorHover.polygon.nodes;
      const n = nodes.length;
      const i = anchorHover.edgeIndex;
      const edgeStart = nodes[i];
      const edgeEnd = nodes[(i + 1) % n];
      if (edgeStart && edgeEnd) {
        context.beginPath();
        context.moveTo(edgeStart.x, edgeStart.y);
        if (n >= 3) {
          const prev = nodes[(i - 1 + n) % n];
          const next2 = nodes[(i + 2) % n];
          const { cp1, cp2 } = getSmoothSegmentControlPoints(prev, edgeStart, edgeEnd, next2, 0.16);
          context.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, edgeEnd.x, edgeEnd.y);
        } else {
          context.lineTo(edgeEnd.x, edgeEnd.y);
        }
        context.lineWidth = 2 / view.scale;
        context.strokeStyle = '#6d4ef2';
        context.stroke();
      }

      const r = 3.2 / view.scale;
      context.beginPath();
      context.arc(anchorHover.point.x, anchorHover.point.y, r, 0, Math.PI * 2);
      context.fillStyle = '#ffffff';
      context.fill();
      context.lineWidth = 1.4 / view.scale;
      context.strokeStyle = '#6d4ef2';
      context.stroke();

      const plusR = 1.6 / view.scale;
      context.beginPath();
      context.moveTo(anchorHover.point.x - plusR, anchorHover.point.y);
      context.lineTo(anchorHover.point.x + plusR, anchorHover.point.y);
      context.moveTo(anchorHover.point.x, anchorHover.point.y - plusR);
      context.lineTo(anchorHover.point.x, anchorHover.point.y + plusR);
      context.lineWidth = 1.1 / view.scale;
      context.strokeStyle = '#6d4ef2';
      context.stroke();

      const badge = 'Thêm & kéo anchor';
      context.font = `600 ${9 / view.scale}px ui-sans-serif, system-ui, sans-serif`;
      const badgeW = context.measureText(badge).width + 8 / view.scale;
      const badgeH = 16 / view.scale;
      const badgeX = anchorHover.point.x + 8 / view.scale;
      const badgeY = Math.max(0, anchorHover.point.y - badgeH - 3 / view.scale);
      context.fillStyle = 'rgba(16, 24, 40, 0.88)';
      context.fillRect(badgeX, badgeY, badgeW, badgeH);
      context.fillStyle = '#ffffff';
      context.textBaseline = 'middle';
      context.textAlign = 'left';
      context.fillText(badge, badgeX + 4 / view.scale, badgeY + badgeH / 2);
      context.restore();
    }

    const snapTarget = snapTargetRef.current;
    if (snapTarget && (toolRef.current === 'polygon' || toolRef.current === 'anchor')) {
      context.save();
      context.beginPath();
      context.arc(snapTarget.point.x, snapTarget.point.y, 6.5 / view.scale, 0, Math.PI * 2);
      context.strokeStyle = '#10b981';
      context.lineWidth = 2 / view.scale;
      context.stroke();
      context.beginPath();
      context.arc(snapTarget.point.x, snapTarget.point.y, 2.5 / view.scale, 0, Math.PI * 2);
      context.fillStyle = '#10b981';
      context.fill();

      if (toolRef.current === 'polygon' && !snapTarget.isVertex) {
        context.font = `600 ${11 / view.scale}px ui-sans-serif, system-ui, sans-serif`;
        const text = '+ Tạo anchor trên biên';
        const tw = context.measureText(text).width;
        const bx = snapTarget.point.x + 8 / view.scale;
        const by = snapTarget.point.y - 10 / view.scale;
        context.fillStyle = 'rgba(16, 185, 129, 0.9)';
        context.fillRect(bx, by - 12 / view.scale, tw + 8 / view.scale, 16 / view.scale);
        context.fillStyle = '#ffffff';
        context.textBaseline = 'middle';
        context.fillText(text, bx + 4 / view.scale, by - 4 / view.scale);
      }
      context.restore();
    }

    /* Wart overlay temporarily hidden.
    for (const point of breakpointsRef.current.points) {
      context.beginPath();
      context.arc(point.x, point.y, 8 / view.scale, 0, Math.PI * 2);
      context.fillStyle = point.id === selectedPointIdRef.current ? '#ffffff' : BREAKPOINT_COLOR;
      context.fill();
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
    */
    const hovered = hoveredNodeRef.current;
    if (hovered) {
      const radius = 5 / view.scale;
      context.strokeStyle = '#ef4444';
      context.lineWidth = 2.5 / view.scale;
      context.beginPath();
      context.moveTo(hovered.x - radius, hovered.y - radius);
      context.lineTo(hovered.x + radius, hovered.y + radius);
      context.moveTo(hovered.x + radius, hovered.y - radius);
      context.lineTo(hovered.x - radius, hovered.y + radius);
      context.stroke();
    }
    context.restore();
  }, [height, width]);

  const render = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      renderNow();
      const local = draftEditingRef.current;
      const state = {
        local,
        canUndo: (local ? draftUndoRef.current : polygonUndoRef.current).length > 0,
        canRedo: (local ? draftRedoRef.current : polygonRedoRef.current).length > 0,
      };
      const key = JSON.stringify(state);
      if (key !== lastHistoryRef.current) {
        lastHistoryRef.current = key;
        onHistoryChange?.(state);
      }
    });
  }, [onHistoryChange, renderNow]);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
  }, []);

  useEffect(() => {
    if (tool !== 'polygon' && tool !== 'pan' && draftEditingRef.current) {
      draftPolygonRef.current = [];
      draftEditingRef.current = false;
      draftUndoRef.current = [];
      draftRedoRef.current = [];
      polygonHoverRef.current = null;
    }
    hoveredNodeRef.current = null;
    anchorHoverRef.current = null;
    toolRef.current = tool;
    render();
  }, [render, tool]);

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
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!viewport || !surface || !stage) return;
    surface.style.width = '100%';
    surface.style.height = '100%';
    stage.style.width = `${viewport.clientWidth}px`;
    stage.style.height = `${viewport.clientHeight}px`;
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
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
    hoveredNodeRef.current = null;
    polygonsRef.current = clonePolygons(next);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(next);
    humanActionRef.current = 'MODIFIED';
    render();
    notifyChange('MODIFIED', next);
    notifySelection();
  }, [notifyChange, notifySelection, pushPolygonHistory, render]);

  const completePolygon = useCallback(() => {
    const draft = draftPolygonRef.current;
    let autofill = draftAutofillRef.current;

    if (!autofill && draft.length >= 2) {
      const snapTolerance = 14 / viewRef.current.scale;
      const first = draft[0];
      const last = draft[draft.length - 1];
      const autoRes = findMultiPolygonAutofillPath(polygonsRef.current, first, last, draft, snapTolerance);
      if (autoRes) {
        autofill = {
          nodes: autoRes.nodes,
          targetPolygons: autoRes.targetPolygons,
          closingToStart: true,
        };
      }
    }

    let finalNodes: PolygonNode[] = [];

    if (autofill && autofill.nodes.length >= 0) {
      finalNodes = [
        ...draft.map((node) => ({ ...node, isAnchor: true })),
        ...autofill.nodes.map((node) => ({ ...node, isAnchor: true })),
      ];
    } else {
      finalNodes = draft.map((node) => ({ ...node, isAnchor: true }));
    }

    if (finalNodes.length < 3) {
      onMessage('Đa giác cần ít nhất 3 node.');
      return false;
    }

    let nextPolygons = [...polygonsRef.current];

    if (autofill) {
      const targetPolys = autofill.targetPolygons || (autofill.polygon ? [autofill.polygon] : []);
      for (const targetPoly of targetPolys) {
        const polyInNext = nextPolygons.find((p) => p.id === targetPoly.id);
        if (polyInNext) {
          let updated = polyInNext;
          if (draft[0]) {
            const res = ensurePolygonHasNodeAt(updated, draft[0]);
            updated = res.polygon;
          }
          const lastDraftNode = draft[draft.length - 1];
          if (lastDraftNode) {
            const res = ensurePolygonHasNodeAt(updated, lastDraftNode);
            updated = res.polygon;
          }
          nextPolygons = nextPolygons.map((p) => (p.id === updated.id ? updated : p));
        }
      }
    }

    for (const existing of nextPolygons) {
      const clipped = clipPolygonDifference(finalNodes, existing.nodes);
      if (clipped && clipped.length >= 3) {
        finalNodes = clipped;
      }
    }

    const created: AnnotationPolygon = {
      id: crypto.randomUUID(),
      label: 'Vùng hư hại',
      nodes: finalNodes,
    };
    draftPolygonRef.current = [];
    draftEditingRef.current = false;
    draftUndoRef.current = [];
    draftRedoRef.current = [];
    draftAutofillRef.current = null;
    snapTargetRef.current = null;
    hoveredNodeRef.current = null;
    polygonHoverRef.current = null;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([created.id]);
    commitPolygons([...nextPolygons, created]);
    if (autofill) {
      onMessage('Đã tự động nối biên chung với mask kế bên.');
    }
    onPolygonComplete?.();
    return true;
  }, [commitPolygons, onMessage, onPolygonComplete]);

  const cancelCurrentPath = useCallback(() => {
    draftPolygonRef.current = [];
    draftEditingRef.current = false;
    draftUndoRef.current = [];
    draftRedoRef.current = [];
    draftAutofillRef.current = null;
    snapTargetRef.current = null;
    hoveredNodeRef.current = null;
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

  const selectAllPolygons = useCallback(() => {
    if (props.readOnly) return;
    if (!polygonsRef.current.length) {
      onMessage('Không có polygon nào để chọn.');
      return;
    }
    const polygonIds = new Set(polygonsRef.current.map((p) => p.id));
    selectedPolygonIdsRef.current = polygonIds;
    selectedNodeIdsRef.current.clear();
    notifySelection();
    render();
    onMessage(`Đã chọn tất cả (${polygonIds.size} polygon). Nhấn Delete để xóa.`);
  }, [notifySelection, onMessage, props.readOnly, render]);

  const clearAllPolygons = useCallback(() => {
    if (props.readOnly) return;
    if (!polygonsRef.current.length && polygonModeRef.current) {
      onMessage('Không có polygon nào để xóa.');
      return;
    }
    const before = clonePolygons(polygonsRef.current);
    pushPolygonHistory(before);
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    polygonsRef.current = [];
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation([]);
    humanActionRef.current = 'MODIFIED';
    render();
    notifyChange('MODIFIED', []);
    notifySelection();
    onMessage('Đã xóa tất cả polygon (Ctrl+Z để hoàn tác).');
  }, [notifyChange, notifySelection, onMessage, props.readOnly, pushPolygonHistory, render]);

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

  const hitNode = useCallback((point: ImagePoint, onlyAnchors = false) => {
    const radius = 10 / viewRef.current.scale;
    for (let polygonIndex = polygonsRef.current.length - 1; polygonIndex >= 0; polygonIndex -= 1) {
      const polygon = polygonsRef.current[polygonIndex];
      const bounds = polygonBounds(polygon);
      if (point.x < bounds.left - radius || point.x > bounds.right + radius
          || point.y < bounds.top - radius || point.y > bounds.bottom + radius) continue;
      for (let nodeIndex = polygon.nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
        const node = polygon.nodes[nodeIndex];
        if (onlyAnchors && !node.isAnchor) continue;
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

  const findClosestPolygonEdge = useCallback((point: ImagePoint, tolerance: number) => {
    let closest: { polygon: AnnotationPolygon; edgeIndex: number; point: ImagePoint; distance: number } | null = null;
    const selectedId = [...selectedPolygonIdsRef.current][0];
    const selectedPoly = selectedId ? polygonsRef.current.find((p) => p.id === selectedId) : null;
    if (selectedPoly) {
      const edge = closestPolygonEdge(selectedPoly, point);
      if (edge && edge.distance <= tolerance) {
        closest = { polygon: selectedPoly, ...edge };
      }
    }
    if (!closest) {
      for (let index = polygonsRef.current.length - 1; index >= 0; index -= 1) {
        const polygon = polygonsRef.current[index];
        const bounds = polygonBounds(polygon);
        if (point.x < bounds.left - tolerance || point.x > bounds.right + tolerance
            || point.y < bounds.top - tolerance || point.y > bounds.bottom + tolerance) continue;
        const edge = closestPolygonEdge(polygon, point);
        if (edge && edge.distance <= tolerance && (!closest || edge.distance < closest.distance)) {
          closest = { polygon, ...edge };
        }
      }
    }
    return closest;
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyRef.current || (props.readOnly && tool !== 'pan')) return;
    const point = imagePoint(event);
    hoveredNodeRef.current = null;
    if (event.button === 2) {
      event.preventDefault();
      if (tool === 'polygon' || (tool === 'anchor' && hitNode(point, true))) return;
      if (tool !== 'select' && tool !== 'anchor') return;
      const polygon = hitPolygon(point);
      if (!polygon) return;
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const polygonIds = additive ? new Set(selectedPolygonIdsRef.current) : new Set<string>();
      polygonIds.add(polygon.id);
      const nodeIds = new Set<string>();
      for (const item of polygonsRef.current) {
        if (polygonIds.has(item.id)) for (const node of item.nodes) nodeIds.add(node.id);
      }
      selectedPolygonIdsRef.current = polygonIds;
      selectedNodeIdsRef.current = nodeIds;
      suppressContextMenuSelectionRef.current = false;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = {
        id: event.pointerId,
        mode: 'polygons',
        start: point,
        original: clonePolygons(polygonsRef.current),
        polygonIds,
        moved: false,
      };
      notifySelection();
      render();
      return;
    }
    if (event.button !== 0) return;
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
      const snapTolerance = 14 / viewRef.current.scale;
      const snap = findSnapTargetToPolygons(polygonsRef.current, point, snapTolerance);
      let effectivePoint = snap ? snap.point : point;

      if (snap && !snap.isVertex) {
        const targetPoly = polygonsRef.current.find((p) => p.id === snap.polygonId);
        if (targetPoly) {
          const { polygon: updatedTarget, node: newAnchor } = insertNodeAtEdge(
            targetPoly,
            snap.edgeIndex,
            snap.point,
          );
          effectivePoint = { x: newAnchor.x, y: newAnchor.y };
          const before = clonePolygons(polygonsRef.current);
          pushPolygonHistory(before);
          polygonsRef.current = polygonsRef.current.map((p) => (p.id === updatedTarget.id ? updatedTarget : p));
          operationsRef.current = polygonOperation(polygonsRef.current);
          polygonModeRef.current = true;
          humanActionRef.current = 'MODIFIED';
          notifyChange('MODIFIED');
          onMessage('Đã tạo anchor mới trên biên của mask cũ.');
        }
      }

      const first = draftPolygonRef.current[0];
      const isClosingClick = first && draftPolygonRef.current.length >= 2 &&
        Math.hypot(first.x - effectivePoint.x, first.y - effectivePoint.y) <= snapTolerance;

      if (isClosingClick) {
        completePolygon();
      } else if (first && draftPolygonRef.current.length >= 2 && snap && draftAutofillRef.current && !draftAutofillRef.current.closingToStart) {
        draftPolygonRef.current = [...draftPolygonRef.current, { id: crypto.randomUUID(), ...effectivePoint, isAnchor: true }];
        completePolygon();
      } else {
        draftEditingRef.current = true;
        draftUndoRef.current.push(draftPolygonRef.current);
        draftRedoRef.current = [];
        draftPolygonRef.current = [...draftPolygonRef.current, { id: crypto.randomUUID(), ...effectivePoint, isAnchor: true }];
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
    if (tool === 'rectangle') {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = { id: event.pointerId, mode: 'rectangle', start: point, current: point };
      render();
      return;
    }
    if (tool === 'circle') {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = {
        id: event.pointerId,
        mode: 'circle',
        start: point,
        current: point,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      };
      render();
      return;
    }
    if (tool === 'anchor') {
      const nodeHit = hitNode(point, true);
      if (nodeHit) {
        selectedNodeIdsRef.current = new Set([nodeHit.node.id]);
        selectedPolygonIdsRef.current = new Set([nodeHit.polygon.id]);
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerRef.current = {
          id: event.pointerId,
          mode: 'nodes',
          start: point,
          original: clonePolygons(polygonsRef.current),
          nodeIds: new Set([nodeHit.node.id]),
          moved: false,
        };
        notifySelection();
        render();
        return;
      }

      const hitTolerance = 14 / viewRef.current.scale;
      const closest = findClosestPolygonEdge(point, hitTolerance);
      if (closest) {
        const before = clonePolygons(polygonsRef.current);
        const edgeStart = closest.polygon.nodes[closest.edgeIndex];
        const edgeEnd = closest.polygon.nodes[(closest.edgeIndex + 1) % closest.polygon.nodes.length];
        const endpointTolerance = 6 / viewRef.current.scale;
        const existingVertex = Math.hypot(closest.point.x - edgeStart.x, closest.point.y - edgeStart.y) <= endpointTolerance
          ? edgeStart
          : Math.hypot(closest.point.x - edgeEnd.x, closest.point.y - edgeEnd.y) <= endpointTolerance ? edgeEnd : null;

        let targetNode: PolygonNode;
        let nextPolygons: AnnotationPolygon[];

        if (existingVertex) {
          targetNode = { ...existingVertex, isAnchor: true };
          nextPolygons = polygonsRef.current.map((p) => p.id === closest.polygon.id
            ? {
                ...p,
                nodes: p.nodes.map((n) => n.id === existingVertex.id ? targetNode : n),
              }
            : p);
        } else {
          const { polygon: updated, node: insertedNode } = insertNodeAtEdge(
            closest.polygon,
            closest.edgeIndex,
            closest.point,
          );
          targetNode = insertedNode;
          nextPolygons = polygonsRef.current.map((p) => p.id === closest.polygon.id ? updated : p);
        }

        polygonsRef.current = nextPolygons;
        polygonModeRef.current = true;
        operationsRef.current = polygonOperation(nextPolygons);
        humanActionRef.current = 'MODIFIED';
        selectedPolygonIdsRef.current = new Set([closest.polygon.id]);
        selectedNodeIdsRef.current = new Set([targetNode.id]);
        anchorHoverRef.current = null;

        event.currentTarget.setPointerCapture(event.pointerId);
        pointerRef.current = {
          id: event.pointerId,
          mode: 'nodes',
          start: point,
          original: clonePolygons(nextPolygons),
          historyBefore: before,
          nodeIds: new Set([targetNode.id]),
          moved: true,
        };
        notifySelection();
        notifyChange('MODIFIED', nextPolygons);
        onMessage('Đã tạo anchor point trên viền. Hãy kéo để chỉnh hình dạng mask.');
        render();
        return;
      }

      const hitPoly = hitPolygon(point);
      if (hitPoly) {
        selectedPolygonIdsRef.current = new Set([hitPoly.id]);
        selectedNodeIdsRef.current.clear();
        notifySelection();
        render();
        return;
      }

      selectedPolygonIdsRef.current.clear();
      selectedNodeIdsRef.current.clear();
      notifySelection();
      render();
      return;
    }

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (tool === 'select') {
      const polyHit = hitPolygon(point);
      if (polyHit) {
        if (!additive && !selectedPolygonIdsRef.current.has(polyHit.id)) {
          selectedPolygonIdsRef.current = new Set([polyHit.id]);
          selectedNodeIdsRef.current.clear();
        } else if (additive) {
          selectedPolygonIdsRef.current.add(polyHit.id);
        }
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
    }
    if (!additive) {
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeRef.current = { start: point, end: point, additive };
    pointerRef.current = { id: event.pointerId, mode: 'marquee', start: point, additive };
    notifySelection();
    render();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly) return;
    if (tool === 'polygon') {
      event.preventDefault();
      // Hai lần pointer-down của double click đã thêm cùng một đỉnh hai lần.
      // Giữ lần nhấp đầu làm đỉnh cuối và bỏ bản sao trước khi hoàn tất.
      if (draftPolygonRef.current.length > 1) {
        draftPolygonRef.current = draftUndoRef.current.pop() ?? draftPolygonRef.current.slice(0, -1);
      }
      if ((draftPolygonRef.current.length >= 2 && draftAutofillRef.current) || draftPolygonRef.current.length >= 3) {
        completePolygon();
      } else {
        render();
      }
      return;
    }
    if (tool !== 'select' || !readyRef.current) return;
    event.preventDefault();
    const point = imagePoint(event);
    const hitTolerance = 14 / viewRef.current.scale;
    let closest: { polygon: AnnotationPolygon; edgeIndex: number; point: ImagePoint; distance: number } | null = null;
    for (let index = polygonsRef.current.length - 1; index >= 0; index -= 1) {
      const polygon = polygonsRef.current[index];
      const bounds = polygonBounds(polygon);
      if (point.x < bounds.left - hitTolerance || point.x > bounds.right + hitTolerance
          || point.y < bounds.top - hitTolerance || point.y > bounds.bottom + hitTolerance) continue;
      const edge = closestPolygonEdge(polygon, point);
      if (edge && edge.distance <= hitTolerance && (!closest || edge.distance < closest.distance)) {
        closest = { polygon, ...edge };
      }
    }
    if (!closest) {
      onMessage('Hãy nhấp đúp gần đường biên polygon để thêm node.');
      return;
    }
    const edgeStart = closest.polygon.nodes[closest.edgeIndex];
    const edgeEnd = closest.polygon.nodes[(closest.edgeIndex + 1) % closest.polygon.nodes.length];
    const endpointTolerance = 6 / viewRef.current.scale;
    const existingNode = Math.hypot(closest.point.x - edgeStart.x, closest.point.y - edgeStart.y) <= endpointTolerance
      ? edgeStart
      : Math.hypot(closest.point.x - edgeEnd.x, closest.point.y - edgeEnd.y) <= endpointTolerance ? edgeEnd : null;
    if (existingNode) {
      selectedPolygonIdsRef.current = new Set([closest.polygon.id]);
      selectedNodeIdsRef.current = new Set([existingNode.id]);
      notifySelection();
      render();
      return;
    }
    const insertedNode = { id: crypto.randomUUID(), ...closest.point };
    selectedPolygonIdsRef.current = new Set([closest.polygon.id]);
    selectedNodeIdsRef.current = new Set([insertedNode.id]);
    const next = polygonsRef.current.map((polygon) => polygon.id === closest!.polygon.id
      ? {
        ...polygon,
        nodes: [
          ...polygon.nodes.slice(0, closest!.edgeIndex + 1),
          insertedNode,
          ...polygon.nodes.slice(closest!.edgeIndex + 1),
        ],
      }
      : polygon);
    commitPolygons(next);
    onMessage('Đã thêm node mới vào biên polygon.');
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly) { event.preventDefault(); return; }
    event.preventDefault();
    if (suppressContextMenuSelectionRef.current) {
      suppressContextMenuSelectionRef.current = false;
      return;
    }
    if (!readyRef.current) return;
    const point = imagePoint(event);
    if (tool === 'polygon') {
      const hit = draftPolygonRef.current.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= 12 / viewRef.current.scale);
      if (hit) {
        draftUndoRef.current.push(draftPolygonRef.current);
        draftRedoRef.current = [];
        draftPolygonRef.current = draftPolygonRef.current.filter((node) => node.id !== hit.id);
        hoveredNodeRef.current = null;
        render();
      }
      return;
    }
    if (tool !== 'select' && tool !== 'anchor') return;
    const nodeHit = hitNode(point, tool === 'anchor');
    if (nodeHit) {
      if (nodeHit.polygon.nodes.length <= 3) {
        onMessage('Polygon cần ít nhất 3 điểm. Chọn polygon và nhấn Delete để xóa cả vùng.');
        return;
      }
      hoveredNodeRef.current = null;
      selectedNodeIdsRef.current.delete(nodeHit.node.id);
      commitPolygons(polygonsRef.current.map((polygon) => polygon.id === nodeHit.polygon.id
        ? { ...polygon, nodes: polygon.nodes.filter((node) => node.id !== nodeHit.node.id) } : polygon));
      return;
    }
    const polygon = hitPolygon(point);
    if (!polygon) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const nodeIds = additive ? new Set(selectedNodeIdsRef.current) : new Set<string>();
    const polygonIds = additive ? new Set(selectedPolygonIdsRef.current) : new Set<string>();
    for (const node of polygon.nodes) nodeIds.add(node.id);
    polygonIds.add(polygon.id);
    selectedNodeIdsRef.current = nodeIds;
    selectedPolygonIdsRef.current = polygonIds;
    notifySelection();
    render();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.readOnly && pointerRef.current?.mode !== 'pan') { pointerRef.current = null; return; }
    const active = pointerRef.current;
    if (!active) {
      const point = imagePoint(event);
      if (tool === 'anchor') {
        const hitTolerance = 14 / viewRef.current.scale;
        const closest = findClosestPolygonEdge(point, hitTolerance);
        const nodeHit = hitNode(point, true);
        const nextHovered = nodeHit?.node ?? null;
        const nextAnchorHover = closest && !nodeHit
          ? { polygon: closest.polygon, edgeIndex: closest.edgeIndex, point: closest.point }
          : null;
        let needsRender = false;
        if (hoveredNodeRef.current?.id !== nextHovered?.id) {
          hoveredNodeRef.current = nextHovered;
          needsRender = true;
        }
        if (
          anchorHoverRef.current?.polygon.id !== nextAnchorHover?.polygon.id
          || anchorHoverRef.current?.edgeIndex !== nextAnchorHover?.edgeIndex
          || Math.hypot(
            (anchorHoverRef.current?.point.x ?? 0) - (nextAnchorHover?.point.x ?? 0),
            (anchorHoverRef.current?.point.y ?? 0) - (nextAnchorHover?.point.y ?? 0),
          ) > 1
        ) {
          anchorHoverRef.current = nextAnchorHover;
          needsRender = true;
        }
        if (needsRender) render();
        return;
      }
      if (tool === 'polygon') {
        const snapTolerance = 14 / viewRef.current.scale;
        const snap = findSnapTargetToPolygons(polygonsRef.current, point, snapTolerance);
        snapTargetRef.current = snap;
        const effectivePoint = snap ? snap.point : point;

        if (draftPolygonRef.current.length) {
          polygonHoverRef.current = effectivePoint;
          const draft = draftPolygonRef.current;
          const isNearStart = draft.length >= 2 && Math.hypot(draft[0].x - effectivePoint.x, draft[0].y - effectivePoint.y) <= snapTolerance;

          if (isNearStart) {
            const autofill = findMultiPolygonAutofillPath(
              polygonsRef.current,
              draft[0],
              draft[draft.length - 1],
              draft,
              snapTolerance,
            );
            draftAutofillRef.current = autofill
              ? { targetPolygons: autofill.targetPolygons, nodes: autofill.nodes, closingToStart: true }
              : null;
          } else if (snap) {
            const autofill = findMultiPolygonAutofillPath(
              polygonsRef.current,
              draft[0],
              effectivePoint,
              [...draft, effectivePoint],
              snapTolerance,
            );
            draftAutofillRef.current = autofill
              ? { targetPolygons: autofill.targetPolygons, nodes: autofill.nodes, closingToStart: false }
              : null;
          } else {
            draftAutofillRef.current = null;
          }
        } else {
          polygonHoverRef.current = null;
          draftAutofillRef.current = null;
        }

        const hovered = draftPolygonRef.current.find((node) => Math.hypot(node.x - effectivePoint.x, node.y - effectivePoint.y) <= 12 / viewRef.current.scale) ?? null;
        if (hoveredNodeRef.current?.id !== hovered?.id) {
          hoveredNodeRef.current = hovered;
        }
        render();
        return;
      }
      return;
    }
    if (active.id !== event.pointerId) return;
    if (active.mode === 'pan') {
      const viewport = viewportRef.current;
      const deltaX = event.clientX - active.lastClient.x;
      const deltaY = event.clientY - active.lastClient.y;
      if (viewport && (viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight)) {
        viewport.scrollLeft -= deltaX;
        viewport.scrollTop -= deltaY;
        const surfaceWidth = Math.max(viewport.clientWidth, width * viewRef.current.scale + 36);
        const surfaceHeight = Math.max(viewport.clientHeight, height * viewRef.current.scale + 36);
        viewRef.current.x = (surfaceWidth - width * viewRef.current.scale) / 2 - viewport.scrollLeft;
        viewRef.current.y = (surfaceHeight - height * viewRef.current.scale) / 2 - viewport.scrollTop;
      } else {
        viewRef.current.x += deltaX;
        viewRef.current.y += deltaY;
      }
      active.lastClient = { x: event.clientX, y: event.clientY };
      fittedRef.current = true;
      render();
      return;
    }
    const point = imagePoint(event);
    if (active.mode === 'rectangle') {
      active.current = point;
      render();
      return;
    }
    if (active.mode === 'circle') {
      active.current = point;
      active.shiftKey = event.shiftKey;
      active.altKey = event.altKey;
      render();
      return;
    }
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
      if (active.mode === 'polygons' && active.moved) suppressContextMenuSelectionRef.current = true;
      if (active.mode === 'polygons') {
        const polygonIds = active.polygonIds;
        polygonsRef.current = active.original.map((polygon) => {
          if (!polygonIds.has(polygon.id)) return polygon;
          return {
            ...polygon,
            nodes: polygon.nodes.map((node) => ({
              ...node,
              x: Math.max(0, Math.min(width, Math.round((node.x + deltaX) * 10) / 10)),
              y: Math.max(0, Math.min(height, Math.round((node.y + deltaY) * 10) / 10)),
            })),
          };
        });
      } else {
        const nodeIds = active.nodeIds;
        let effectiveDeltaX = deltaX;
        let effectiveDeltaY = deltaY;

        if (nodeIds.size === 1) {
          const draggedId = nodeIds.values().next().value;
          const origPoly = active.original.find((p) => p.nodes.some((n) => n.id === draggedId));
          const origNode = origPoly?.nodes.find((n) => n.id === draggedId);
          if (origNode && origPoly) {
            const targetPos = { x: origNode.x + deltaX, y: origNode.y + deltaY };
            const snapTolerance = 14 / viewRef.current.scale;
            const snap = findSnapTargetToPolygons(polygonsRef.current, targetPos, snapTolerance, origPoly.id);
            if (snap) {
              effectiveDeltaX = snap.point.x - origNode.x;
              effectiveDeltaY = snap.point.y - origNode.y;
              snapTargetRef.current = snap;
            } else {
              snapTargetRef.current = null;
            }
          }
        }

        polygonsRef.current = active.original.map((polygon) => {
          if (!polygon.nodes.some((node) => nodeIds.has(node.id))) return polygon;
          return {
            ...polygon,
            nodes: computeSmoothNodeDisplacements(polygon.nodes, nodeIds, effectiveDeltaX, effectiveDeltaY, width, height),
          };
        });
      }
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
    hoveredNodeRef.current = null;
    anchorHoverRef.current = null;
    render();
    if (!pointerRef.current && polygonHoverRef.current) {
      polygonHoverRef.current = null;
      render();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.readOnly && pointerRef.current?.mode !== 'pan') { pointerRef.current = null; return; }
    const active = pointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    pointerRef.current = null;
    if (active.mode === 'nodes' || active.mode === 'polygons') {
      const snap = snapTargetRef.current;
      snapTargetRef.current = null;

      if (active.mode === 'nodes' && active.moved && snap) {
        const targetPoly = polygonsRef.current.find((p) => p.id === snap.polygonId);
        if (targetPoly) {
          const { polygon: updatedTarget } = ensurePolygonHasNodeAt(targetPoly, snap.point);
          polygonsRef.current = polygonsRef.current.map((p) => {
            if (p.id === snap.polygonId) return updatedTarget;
            if (!p.nodes.some((n) => active.nodeIds.has(n.id))) return p;
            const clipped = clipPolygonDifference(p.nodes, updatedTarget.nodes);
            return clipped && clipped.length >= 3 ? { ...p, nodes: clipped } : p;
          });
          onMessage('Đã tự động khớp biên chung với mask kế bên.');
        }
      }

      if (active.mode === 'nodes' && active.historyBefore) {
        pushPolygonHistory(active.historyBefore);
        operationsRef.current = polygonOperation(polygonsRef.current);
        polygonModeRef.current = true;
        humanActionRef.current = 'MODIFIED';
        notifyChange('MODIFIED');
        render();
        return;
      }
      if (active.moved) {
        pushPolygonHistory(active.original);
        operationsRef.current = polygonOperation(polygonsRef.current);
        polygonModeRef.current = true;
        humanActionRef.current = 'MODIFIED';
        notifyChange('MODIFIED');
        render();
      }
      return;
    }
    if (active.mode === 'cut') {
      render();
      return;
    }
    if (active.mode === 'rectangle') {
      const minX = Math.min(active.start.x, active.current.x);
      const maxX = Math.max(active.start.x, active.current.x);
      const minY = Math.min(active.start.y, active.current.y);
      const maxY = Math.max(active.start.y, active.current.y);
      if (maxX - minX >= 4 && maxY - minY >= 4) {
        const created = createRectanglePolygon(active.start, active.current);
        selectedNodeIdsRef.current.clear();
        selectedPolygonIdsRef.current = new Set([created.id]);
        commitPolygons([...polygonsRef.current, created]);
        onMessage('Đã tạo mask hình chữ nhật.');
        onPolygonComplete?.();
      }
      render();
      return;
    }
    if (active.mode === 'circle') {
      let cx: number;
      let cy: number;
      let rx: number;
      let ry: number;
      if (active.altKey) {
        cx = active.start.x;
        cy = active.start.y;
        if (active.shiftKey) {
          const r = Math.hypot(active.current.x - active.start.x, active.current.y - active.start.y);
          rx = r;
          ry = r;
        } else {
          rx = Math.abs(active.current.x - active.start.x);
          ry = Math.abs(active.current.y - active.start.y);
        }
      } else {
        const minX = Math.min(active.start.x, active.current.x);
        const maxX = Math.max(active.start.x, active.current.x);
        const minY = Math.min(active.start.y, active.current.y);
        const maxY = Math.max(active.start.y, active.current.y);
        rx = (maxX - minX) / 2;
        ry = (maxY - minY) / 2;
        if (active.shiftKey) {
          const r = Math.max(rx, ry);
          rx = r;
          ry = r;
          cx = active.start.x < active.current.x ? active.start.x + r : active.start.x - r;
          cy = active.start.y < active.current.y ? active.start.y + r : active.start.y - r;
        } else {
          cx = minX + rx;
          cy = minY + ry;
        }
      }
      if (rx >= 3 && ry >= 3) {
        const created = createCirclePolygon({ x: cx, y: cy }, rx, ry, 32);
        selectedNodeIdsRef.current.clear();
        selectedPolygonIdsRef.current = new Set([created.id]);
        commitPolygons([...polygonsRef.current, created]);
        onMessage('Đã tạo mask hình tròn.');
        onPolygonComplete?.();
      }
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
    if (pointerRef.current) return;
    if (draftEditingRef.current) {
      const next = draftUndoRef.current.pop();
      if (!next) return;
      draftRedoRef.current.push(draftPolygonRef.current);
      draftPolygonRef.current = next;
      hoveredNodeRef.current = null;
      render();
      return;
    }
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
    hoveredNodeRef.current = null;
    polygonsRef.current = clonePolygons(previous);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(previous);
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    humanActionRef.current = 'MODIFIED';
    render();
    notifyChange('MODIFIED', previous);
    notifySelection();
  }, [notifyChange, notifySelection, render, tool]);

  const redo = useCallback(() => {
    if (pointerRef.current) return;
    if (draftEditingRef.current) {
      const next = draftRedoRef.current.pop();
      if (!next) return;
      draftUndoRef.current.push(draftPolygonRef.current);
      draftPolygonRef.current = next;
      hoveredNodeRef.current = null;
      render();
      return;
    }
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
    hoveredNodeRef.current = null;
    polygonsRef.current = clonePolygons(next);
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(next);
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    humanActionRef.current = 'MODIFIED';
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

  const groupSelectedPolygons = useCallback(() => {
    const selectedIds = selectedPolygonIdsRef.current;
    const selected = polygonsRef.current.filter((polygon) => selectedIds.has(polygon.id));
    const result = mergePolygonsIntoSingle(selected);
    if (!result.polygon) {
      onMessage(result.error || 'Không thể gộp polygon.');
      return false;
    }

    const merged = result.polygon;
    const firstSelectedIndex = polygonsRef.current.findIndex((polygon) => selectedIds.has(polygon.id));
    const next = polygonsRef.current.flatMap((polygon, index) => {
      if (index === firstSelectedIndex) return [merged];
      return selectedIds.has(polygon.id) ? [] : [polygon];
    });
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([merged.id]);
    commitPolygons(next);
    onMessage(`Đã gộp ${selected.length} polygon thành 1 vùng.`);
    return true;
  }, [commitPolygons, onMessage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (props.readOnly) return;
      const target = event.target;
      if (target instanceof HTMLElement
          && target.matches('input, select, textarea, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllPolygons();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && (tool === 'select' || tool === 'anchor')) {
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
  }, [applyCut, cancelCurrentPath, clearAllPolygons, completePolygon, deleteSelectedPoint, deleteSelection, props.readOnly, redo, selectAllPolygons, tool, undo]);

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
          const others = polygonsRef.current.filter((p) => p.id !== polygon.id);
          drawSmoothClosedPath(context, polygon.nodes, 0.08, others);
          context.fill();
        }
        return toBlob(canvas);
      }
      if (!maskRef.current) throw new Error('Mask chưa sẵn sàng.');
      return toBlob(maskRef.current);
    },
    resetToPrediction: () => {
      if (props.readOnly) return;
      const mask = maskRef.current;
      const prediction = predictionRef.current;
      if (mask && prediction) {
        const context = mask.getContext('2d');
        context?.clearRect(0, 0, width, height);
        context?.drawImage(prediction, 0, 0);
        if (tintRef.current) rebuildTint(mask, tintRef.current, POLYGON_FILL);
      }
      cancelCurrentPath();
      polygonsRef.current = [];
      polygonModeRef.current = false;
      operationsRef.current = [{ type: 'RESET_TO_PREDICTION' }];
      polygonUndoRef.current = [];
      polygonRedoRef.current = [];
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      humanActionRef.current = 'MODIFIED';
      render();
      notifyChange('MODIFIED', []);
      notifySelection();
    },
    acceptPrediction: () => {
      if (props.readOnly) return;
      const mask = maskRef.current;
      const prediction = predictionRef.current;
      if (mask && prediction) {
        const context = mask.getContext('2d');
        context?.clearRect(0, 0, width, height);
        context?.drawImage(prediction, 0, 0);
        if (tintRef.current) rebuildTint(mask, tintRef.current, POLYGON_FILL);
      }
      cancelCurrentPath();
      polygonsRef.current = [];
      polygonModeRef.current = false;
      operationsRef.current = [];
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      humanActionRef.current = 'ACCEPTED';
      render();
      notifyChange('ACCEPTED', []);
      notifySelection();
    },
    undo: () => { if (!props.readOnly) undo(); },
    redo: () => { if (!props.readOnly) redo(); },
    deleteSelectedPoint: () => { if (!props.readOnly) deleteSelectedPoint(); },
    deleteSelection: () => { if (!props.readOnly) deleteSelection(); },
    selectAllPolygons: () => { if (!props.readOnly) selectAllPolygons(); },
    clearAllPolygons: () => { if (!props.readOnly) clearAllPolygons(); },
    completePolygon: () => !props.readOnly && completePolygon(),
    cancelCurrentPath,
    applyCut: () => !props.readOnly && applyCut(),
    beginPolygonEdit: () => props.readOnly ? 0 : beginPolygonEdit(),
    selectPolygon,
    updateSelectedPolygonLabel: (label) => !props.readOnly && updateSelectedPolygonLabel(label),
    groupSelectedPolygons: () => !props.readOnly && groupSelectedPolygons(),
    confirmNoBreakpoint: () => {
      if (props.readOnly) return;
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
      const surface = surfaceRef.current;
      const stage = stageRef.current;
      if (!viewport || !surface || !stage) return;
      const view = viewRef.current;
      const next = Math.max(0.05, Math.min(20, view.scale * factor));
      const imageX = (viewport.clientWidth / 2 - view.x) / view.scale;
      const imageY = (viewport.clientHeight / 2 - view.y) / view.scale;
      const surfaceWidth = Math.max(viewport.clientWidth, width * next + 36);
      const surfaceHeight = Math.max(viewport.clientHeight, height * next + 36);
      surface.style.width = `${surfaceWidth}px`;
      surface.style.height = `${surfaceHeight}px`;
      stage.style.width = `${viewport.clientWidth}px`;
      stage.style.height = `${viewport.clientHeight}px`;
      const originX = (surface.offsetWidth - width * next) / 2;
      const originY = (surface.offsetHeight - height * next) / 2;
      viewport.scrollLeft = originX + imageX * next - viewport.clientWidth / 2;
      viewport.scrollTop = originY + imageY * next - viewport.clientHeight / 2;
      viewRef.current = { scale: next, x: originX - viewport.scrollLeft, y: originY - viewport.scrollTop };
      fittedRef.current = true;
      onZoomChange?.(next);
      render();
    },
  }), [applyCut, beginPolygonEdit, cancelCurrentPath, clearAllPolygons, completePolygon, deleteSelectedPoint, deleteSelection, fit, groupSelectedPolygons, height, notifyChange, notifySelection, onZoomChange, props.readOnly, rebuildTint, redo, render, selectAllPolygons, selectPolygon, undo, updateSelectedPolygonLabel, width]);

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.shiftKey) {
      viewport.scrollLeft += event.deltaY || event.deltaX;
      const surfaceWidth = Math.max(viewport.clientWidth, width * viewRef.current.scale + 36);
      viewRef.current.x = (surfaceWidth - width * viewRef.current.scale) / 2 - viewport.scrollLeft;
      render();
      return;
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    const stage = event.currentTarget;
    const rect = stage.getBoundingClientRect();
    const view = viewRef.current;
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const imageX = (mouseX - view.x) / view.scale;
    const imageY = (mouseY - view.y) / view.scale;
    const next = Math.max(0.05, Math.min(20, view.scale * Math.exp(-event.deltaY * 0.001)));
    const surfaceWidth = Math.max(viewport.clientWidth, width * next + 36);
    const surfaceHeight = Math.max(viewport.clientHeight, height * next + 36);
    surface.style.width = `${surfaceWidth}px`;
    surface.style.height = `${surfaceHeight}px`;
    stage.style.width = `${viewport.clientWidth}px`;
    stage.style.height = `${viewport.clientHeight}px`;
    const originX = (surface.offsetWidth - width * next) / 2;
    const originY = (surface.offsetHeight - height * next) / 2;
    viewport.scrollLeft = originX + imageX * next - mouseX;
    viewport.scrollTop = originY + imageY * next - mouseY;
    viewRef.current = { scale: next, x: originX - viewport.scrollLeft, y: originY - viewport.scrollTop };
    fittedRef.current = true;
    onZoomChange?.(next);
    render();
  };

  const onViewportScroll = () => {
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    if (!viewport || !surface) return;
    const view = viewRef.current;
    view.x = (surface.offsetWidth - width * view.scale) / 2 - viewport.scrollLeft;
    view.y = (surface.offsetHeight - height * view.scale) / 2 - viewport.scrollTop;
    render();
  };

  return (
    <div className={`canvas-viewport tool-${tool}`} ref={viewportRef} onScroll={onViewportScroll}>
      <div className="canvas-scroll-surface" ref={surfaceRef}>
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
          onContextMenu={onContextMenu}
          onWheel={onWheel}
        />
      </div>
    </div>
  );
});

export default EditorCanvas;
