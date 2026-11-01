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
  BrushOperation,
  HumanAction,
  MaskOperation,
  PolygonNode,
  VectorCache,
} from '@/types';
import { photoLevelFor, photoPyramidSizes, renderPixelRatio, zoomViewAt } from '@/lib/canvas-view';
import { forEachPolygonSpan, normalizeMaskRgba, polygonPixelRect, simplifyRing, smoothPolygon } from '@/lib/mask-pixels';
import { nextLabel, semanticForLabelKind, type PolygonLabelKind } from '@/lib/polygon-labels';
import { clonePolygons, mergePolygonsIntoSingle, pointInMask, polygonRings, type BrushMode } from '@/lib/polygon-geometry';
import { PolygonDraft } from '@/lib/polygon-draft';
import { packedTransfer, packGeometry, unpackPolygons } from '@/lib/polygon-pack';
import { polygonBounds, preserveVectorIdentity, type PolygonBounds } from '@/lib/vector-identity';
import type { MaskWorkerRequest, MaskWorkerResponse } from '@/lib/brush-worker';

export type EditorTool = 'polygon' | 'select' | 'brush' | 'point' | 'pan';

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
  flushPendingEdits(): Promise<void>;
  resetToPrediction(): void;
  acceptPrediction(): void;
  undo(): void;
  redo(): void;
  deleteSelectedPoint(): void;
  deleteSelection(): void;
  confirmNoBreakpoint(): void;
  completePolygon(): boolean;
  cancelCurrentPath(): void;
  beginPolygonEdit(): number;
  selectPolygon(polygonId: string): void;
  toggleSelectedPolygonLock(): boolean;
  updateSelectedPolygonLabel(label: string, kind: PolygonLabelKind): boolean;
  groupSelectedPolygons(): boolean;
  smoothSelectedPolygons(): boolean;
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
  brushMode: BrushMode;
  brushSize: number;
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
type BrushBounds = PolygonBounds;
/** What undo/redo restores. `vectorsCurrent`: the polygons describe the mask exactly (no raster needed). */
type DocumentState = { operations: MaskOperation[]; polygons: AnnotationPolygon[]; vectorsCurrent: boolean };
/**
 * One linear history for every mask edit. Polygon edits restore their polygons exactly; brush strokes
 * keep the pixels of their rectangle before and after, so undo/redo never re-renders the whole mask.
 */
type HistoryEntry =
  | { kind: 'polygons'; before: DocumentState; after: DocumentState }
  | { kind: 'brush'; before: DocumentState; after: DocumentState; bounds: BrushBounds; beforePixels: ImageData; afterPixels: ImageData };
const HISTORY_LIMIT = 100;
const HISTORY_BYTES = 96 * 1024 * 1024;
const historyBytes = (entry: HistoryEntry) => entry.kind === 'brush' ? entry.beforePixels.data.byteLength + entry.afterPixels.data.byteLength : 0;
const isBrushOperation = (operation: MaskOperation): operation is BrushOperation => operation.type === 'BRUSH_ADD' || operation.type === 'BRUSH_ERASE';
type Marquee = { start: ImagePoint; end: ImagePoint; additive: boolean };
type PointerActivity =
  | { id: number; mode: 'pan'; lastClient: ImagePoint }
  | { id: number; mode: 'brush'; last: ImagePoint; brushMode: BrushMode; radius: number }
  | { id: number; mode: 'nodes'; start: ImagePoint; original: AnnotationPolygon[]; nodeIds: Set<string>; polygonIds: Set<string>; moved: boolean }
  | { id: number; mode: 'marquee'; start: ImagePoint; additive: boolean; clickPolygonId?: string }
  | { id: number; mode: 'point'; pointBefore: BreakpointPoint[]; draggedPointId: string; moved: boolean };

const POLYGON_FILL = '#7c5cfa';
const POLYGON_STROKE = '#7c5cfa';
// Wart overlay temporarily hidden: const BREAKPOINT_COLOR = '#6d4ef2';
const ERASE_COLOR = '#f04438';

const polygonPathCache = new WeakMap<AnnotationPolygon, Path2D>();
function polygonPath(polygon: AnnotationPolygon): Path2D {
  const cached = polygonPathCache.get(polygon);
  if (cached) return cached;
  const path = new Path2D();
  for (const ring of polygonRings(polygon)) {
    ring.forEach((node, index) => index === 0 ? path.moveTo(node.x, node.y) : path.lineTo(node.x, node.y));
    path.closePath();
  }
  polygonPathCache.set(polygon, path);
  return path;
}

// Level-of-detail outlines: when zoomed out, vertices far closer than a screen pixel only cost draw
// time. Each level doubles the simplification tolerance (image px) and is cached per polygon.
const LOD_BASE_TOLERANCE = 0.35;
const polygonLodCache = new WeakMap<AnnotationPolygon, Map<number, Path2D>>();
function polygonPathAt(polygon: AnnotationPolygon, scale: number): Path2D {
  const tolerance = 0.6 / scale;
  if (tolerance <= LOD_BASE_TOLERANCE) return polygonPath(polygon);
  const level = Math.min(16, Math.ceil(Math.log2(tolerance / LOD_BASE_TOLERANCE)));
  let levels = polygonLodCache.get(polygon);
  if (!levels) { levels = new Map(); polygonLodCache.set(polygon, levels); }
  const cached = levels.get(level);
  if (cached) return cached;
  const path = new Path2D();
  for (const ring of polygonRings(polygon)) {
    const simplified = simplifyRing(ring, LOD_BASE_TOLERANCE * 2 ** level);
    if (simplified.length < 3) continue;
    simplified.forEach((node, index) => index === 0 ? path.moveTo(node.x, node.y) : path.lineTo(node.x, node.y));
    path.closePath();
  }
  levels.set(level, path);
  return path;
}

/** One backing-store ratio for every screen-sized layer (capped; 1× on low-memory devices). */
const pixelRatio = () => renderPixelRatio(window.devicePixelRatio, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
const sameView = (a: View, b: View) => a.scale === b.scale && a.x === b.x && a.y === b.y;

/** Runs `task` when the main thread is idle (Safari has no requestIdleCallback: short timeout instead). */
const whenIdle = (task: () => void) => {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(task, { timeout: 300 });
  else window.setTimeout(task, 30);
};

/**
 * Writes the binary pixel-center raster of `polygons` (opaque white, the rest transparent) into a
 * full-image canvas. Only the polygons' pixel rectangle is filled, span by span straight into 32-bit
 * words: no full-image ImageData and no per-pixel conversion loop.
 */
function putPolygonRaster(context: CanvasRenderingContext2D, polygons: AnnotationPolygon[], width: number, height: number) {
  const rect = polygonPixelRect(polygons, width, height);
  if (!rect) { context.clearRect(0, 0, width, height); return; }
  // putImageData replaces the rectangle entirely; clear only the strips around it.
  context.clearRect(0, 0, width, rect.top);
  context.clearRect(0, rect.bottom, width, height - rect.bottom);
  context.clearRect(0, rect.top, rect.left, rect.bottom - rect.top);
  context.clearRect(rect.right, rect.top, width - rect.right, rect.bottom - rect.top);
  const rectWidth = rect.right - rect.left;
  const image = context.createImageData(rectWidth, rect.bottom - rect.top);
  const words = new Uint32Array(image.data.buffer);
  forEachPolygonSpan(polygons, rect, (y, start, end) => {
    const row = (y - rect.top) * rectWidth - rect.left;
    words.fill(0xffffffff, row + start, row + end);
  });
  context.putImageData(image, rect.left, rect.top);
}

/** Image-pixel rectangle visible in a screen area of the given CSS size. */
function visibleImageRect(view: View, cssWidth: number, cssHeight: number, width: number, height: number): PolygonBounds {
  return {
    left: Math.max(0, Math.floor(-view.x / view.scale)),
    top: Math.max(0, Math.floor(-view.y / view.scale)),
    right: Math.min(width, Math.ceil((cssWidth - view.x) / view.scale)),
    bottom: Math.min(height, Math.ceil((cssHeight - view.y) / view.scale)),
  };
}

function brushBounds(points: ImagePoint[], radius: number): BrushBounds {
  const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const point of points) {
    if (point.x - radius < bounds.left) bounds.left = point.x - radius;
    if (point.x + radius > bounds.right) bounds.right = point.x + radius;
    if (point.y - radius < bounds.top) bounds.top = point.y - radius;
    if (point.y + radius > bounds.bottom) bounds.bottom = point.y + radius;
  }
  return bounds;
}

/** Polygons describe the mask only when POLYGON_SET is the last operation (no brush/reset after it). */
function polygonsAreCurrent(operations: MaskOperation[]) {
  return operations.at(-1)?.type === 'POLYGON_SET';
}

function lastPolygonSet(operations: MaskOperation[]): AnnotationPolygon[] {
  const polygonOperation = [...operations].reverse().find((operation) => operation.type === 'POLYGON_SET');
  return polygonOperation?.type === 'POLYGON_SET' ? clonePolygons(polygonOperation.polygons) : [];
}

function polygonsFromOperations(operations: MaskOperation[]): AnnotationPolygon[] {
  return polygonsAreCurrent(operations) ? lastPolygonSet(operations) : [];
}

function polygonOperation(polygons: AnnotationPolygon[]): MaskOperation[] {
  return [{ type: 'POLYGON_SET', polygons }];
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

function closestPolygonEdge(polygon: AnnotationPolygon, point: ImagePoint) {
  let closest: { edgeIndex: number; ring: PolygonNode[]; point: ImagePoint; distance: number } | null = null;
  for (const ring of polygonRings(polygon)) {
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
      const candidate = closestPointOnSegment(point, ring[edgeIndex], ring[(edgeIndex + 1) % ring.length]);
      if (!closest || candidate.distance < closest.distance) closest = { edgeIndex, ring, ...candidate };
    }
  }
  return closest;
}

const EditorCanvas = forwardRef<EditorCanvasHandle, Props>(function EditorCanvas(props, ref) {
  const {
    brushMode,
    brushSize,
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
  const interactionCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskLayerRef = useRef<HTMLCanvasElement>(null);
  const vectorLayerRef = useRef<HTMLCanvasElement>(null);
  // Polygon being drawn and the selection marquee: tiny, redrawn per move, so the photo stays untouched.
  const draftLayerRef = useRef<HTMLCanvasElement>(null);
  // Off-DOM back buffer for dirty-rectangle redraws of the vector layer (see renderVectorLayer).
  const vectorBufferRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // [full photo, ½, ¼, …]: zoomed out, the stage samples the smallest level that still covers the screen.
  const photoLevelsRef = useRef<Array<HTMLImageElement | HTMLCanvasElement>>([]);
  // Decoded prediction; its normalized binary canvas (predictionRef) is only built when reset/accept needs it.
  const predictionImageRef = useRef<HTMLImageElement | null>(null);
  const predictionRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  // White pixels for locked polygons. Brush commits restore only the touched ROI from this cache.
  const lockedMaskRef = useRef<HTMLCanvasElement | null>(null);
  // False while no polygon is locked: lockedMaskRef is then fully transparent and restoring it is skipped.
  const lockedPixelsRef = useRef(false);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fittedRef = useRef(false);
  const readyRef = useRef(false);
  const pointerRef = useRef<PointerActivity | null>(null);
  // Brush strokes saved after a POLYGON_SET make the saved raster authoritative: those polygons are
  // stale. They only carry labels/ids into the next vectorization and are never painted over the mask.
  const [initialPolygonData] = useState(() => ({
    polygons: polygonsFromOperations(initialOperations),
    identity: lastPolygonSet(initialOperations),
  }));
  const polygonModeRef = useRef(polygonsAreCurrent(initialOperations));
  const operationsRef = useRef<MaskOperation[]>([...initialOperations]);
  const polygonsRef = useRef<AnnotationPolygon[]>(initialPolygonData.polygons);
  const initialRevision = initialOperations.reduce((revision, operation) => (
    operation.type === 'BRUSH_ADD' || operation.type === 'BRUSH_ERASE'
      ? Math.max(revision, operation.revision ?? 0) : revision
  ), 0);
  const maskRevisionRef = useRef(initialRevision);
  const vectorRevisionRef = useRef(polygonModeRef.current ? initialRevision : -1);
  const vectorStatusRef = useRef<VectorCache['status']>(polygonModeRef.current ? 'READY' : 'EMPTY');
  const vectorCacheRef = useRef<VectorCache>({
    revision: vectorRevisionRef.current,
    status: vectorStatusRef.current,
    polygons: initialPolygonData.identity,
  });
  const brushOperationRef = useRef<BrushOperation[]>(initialOperations.filter(
    (operation): operation is BrushOperation => operation.type === 'BRUSH_ADD' || operation.type === 'BRUSH_ERASE',
  ));
  const historyUndoRef = useRef<HistoryEntry[]>([]);
  const historyRedoRef = useRef<HistoryEntry[]>([]);
  const selectedNodeIdsRef = useRef(new Set<string>());
  const selectedPolygonIdsRef = useRef(new Set<string>());
  // New polygon being placed point by point, with its own per-point undo/redo (see polygon-draft.ts).
  const draftRef = useRef(new PolygonDraft());
  const draftLayerDrawnRef = useRef(false);
  const hoveredNodeRef = useRef<PolygonNode | null>(null);
  const lastHistoryRef = useRef('');
  const polygonHoverRef = useRef<ImagePoint | null>(null);
  const brushStrokeRef = useRef<ImagePoint[]>([]);
  const brushCursorRef = useRef<ImagePoint | null>(null);
  const pendingBrushSamplesRef = useRef<Array<{ clientX: number; clientY: number }>>([]);
  const latestBrushCursorRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const brushFrameRef = useRef<number | null>(null);
  const brushRef = useRef({ mode: brushMode, size: brushSize });
  const marqueeRef = useRef<Marquee | null>(null);
  const breakpointsRef = useRef(copyBreakpoints(initialBreakpoints));
  const pointUndoRef = useRef<BreakpointPoint[][]>([]);
  const pointRedoRef = useRef<BreakpointPoint[][]>([]);
  const selectedPointIdRef = useRef<string | null>(null);
  const humanActionRef = useRef(initialHumanAction);
  const displayRef = useRef({ showMask, maskOpacity });
  const toolRef = useRef(tool);
  const renderFrameRef = useRef<number | null>(null);
  const brushWorkerRef = useRef<Worker | null>(null);
  const pyramidBuildRef = useRef(0);
  // Worker mask is synced lazily: false means maskRef changed wholesale and must be re-sent.
  const workerSyncedRef = useRef(false);
  // Polygons whose binary raster has not been written to maskRef yet (export/brush only need it later).
  const pendingMaskPolygonsRef = useRef<AnnotationPolygon[] | null>(null);
  const vectorSourceRef = useRef(new Map<string, AnnotationPolygon>());
  const workerMessageRef = useRef<(response: MaskWorkerResponse) => void>(() => undefined);
  const vectorizeTimerRef = useRef<number | null>(null);
  const scheduleVectorizationRef = useRef<(delay?: number) => void>(() => undefined);
  const workerRasterRevisionRef = useRef(initialRevision);
  const vectorizingRevisionRef = useRef<number | null>(null);
  const vectorWaitersRef = useRef(new Map<number, Array<() => void>>());
  // Screen-space layers remember the view they were drawn at. Zoom/pan only moves them with a CSS
  // transform (GPU) until the gesture settles; then they are redrawn sharp at the new view.
  const layerViewRef = useRef<{ mask: View | null; vectors: View | null }>({ mask: null, vectors: null });
  // Each layer is redrawn only when its own content changed: `stage` = background + photo (view
  // changes, resize), `draft` = draft polygon + marquee, `mask` / `vectors` (optionally only the dirty
  // rectangle `maskRect` / `vectorsRect`, in image pixels).
  const dirtyRef = useRef<{
    stage: boolean; draft: boolean; mask: boolean; maskRect: PolygonBounds | null; vectors: boolean; vectorsRect: PolygonBounds | null;
  }>({ stage: true, draft: true, mask: true, maskRect: null, vectors: true, vectorsRect: null });
  const settleTimerRef = useRef<number | null>(null);
  const notifyTimerRef = useRef<number | null>(null);
  const backgroundVectorTimerRef = useRef<number | null>(null);
  const pendingVectorNotifyRef = useRef(false);
  const clearInteractionOnFrameRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      brushWorkerRef.current?.terminate();
      brushWorkerRef.current = null;
      if (brushFrameRef.current !== null) cancelAnimationFrame(brushFrameRef.current);
      for (const timer of [vectorizeTimerRef, settleTimerRef, notifyTimerRef, backgroundVectorTimerRef]) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  // Once brush edits are vectorized for the current mask revision, save those polygons as the single
  // source of truth: reopening, ZIP export and version previews all read the last POLYGON_SET.
  const vectorsCurrent = useCallback(() => (
    vectorRevisionRef.current === maskRevisionRef.current && vectorStatusRef.current === 'READY'
  ), []);

  const captureDocument = useCallback((): DocumentState => ({
    operations: [...operationsRef.current],
    polygons: polygonsRef.current,
    vectorsCurrent: vectorsCurrent(),
  }), [vectorsCurrent]);

  const currentOperations = useCallback((): MaskOperation[] => {
    const operations = operationsRef.current;
    return vectorsCurrent() && operations.some(isBrushOperation) && !polygonsAreCurrent(operations)
      ? polygonOperation(polygonsRef.current)
      : [...operations];
  }, [vectorsCurrent]);

  const notifyChange = useCallback((
    nextHumanAction = humanActionRef.current,
    polygons = polygonsRef.current,
  ) => {
    onChange({
      humanAction: nextHumanAction,
      breakpoints: copyBreakpoints(breakpointsRef.current),
      maskOperations: currentOperations(),
      polygons,
    });
  }, [currentOperations, onChange]);

  const notifySelection = useCallback(() => {
    onSelectionChange([...selectedPolygonIdsRef.current]);
  }, [onSelectionChange]);

  // Brush strokes reach React (workspace panels, dirty state) at most every 400 ms instead of per
  // stroke; saving and leaving the brush flush the pending notification first.
  const scheduleNotify = useCallback(() => {
    if (notifyTimerRef.current !== null) return;
    notifyTimerRef.current = window.setTimeout(() => {
      notifyTimerRef.current = null;
      notifyChange();
    }, 400);
  }, [notifyChange]);

  const flushNotify = useCallback(() => {
    if (notifyTimerRef.current === null) return;
    window.clearTimeout(notifyTimerRef.current);
    notifyTimerRef.current = null;
    notifyChange();
  }, [notifyChange]);

  const ensureMaskRaster = useCallback(() => {
    const polygons = pendingMaskPolygonsRef.current;
    const context = maskRef.current?.getContext('2d', { willReadFrequently: true });
    if (!polygons || !context) return;
    // Saved/imported data can contain a degenerate ring (<3 nodes, NaN). Throwing here would leave the
    // prediction raster in place and the next stroke would merge into the wrong mask, so skip those rings.
    const validRing = (ring: PolygonNode[] | undefined) => Array.isArray(ring) && ring.length >= 3
      && ring.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
    const drawable = polygons.flatMap((polygon) => validRing(polygon.nodes)
      ? [{ ...polygon, holes: polygon.holes?.filter(validRing) }] : []);
    putPolygonRaster(context, drawable, width, height);
    pendingMaskPolygonsRef.current = null;
    // The worker rebuilds the identical raster from the same polygons (a few typed arrays), instead of a
    // later full-image getImageData + transfer on the main thread right after the first brush stroke.
    const worker = brushWorkerRef.current;
    if (worker) {
      const geometry = packGeometry(drawable);
      worker.postMessage(
        { type: 'INIT_POLYGONS', revision: maskRevisionRef.current, width, height, geometry } satisfies MaskWorkerRequest,
        packedTransfer(geometry),
      );
      workerSyncedRef.current = true;
    }
  }, [height, width]);

  const syncWorkerMask = useCallback(() => {
    const worker = brushWorkerRef.current;
    const context = maskRef.current?.getContext('2d', { willReadFrequently: true });
    if (!worker || !context || workerSyncedRef.current) return;
    ensureMaskRaster();
    // Pending polygons were just sent to the worker as INIT_POLYGONS.
    if (workerSyncedRef.current) return;
    const imageData = context.getImageData(0, 0, width, height);
    worker.postMessage(
      { type: 'INIT_MASK', revision: maskRevisionRef.current, width, height, imageData } satisfies MaskWorkerRequest,
      [imageData.data.buffer],
    );
    workerSyncedRef.current = true;
  }, [ensureMaskRaster, height, width]);

  const drawBrushCursor = useCallback(() => {
    const target = cursorCanvasRef.current;
    const context = target?.getContext('2d');
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    const cursor = brushCursorRef.current;
    if (!cursor || toolRef.current !== 'brush') return;
    const ratio = pixelRatio();
    const view = viewRef.current;
    const radius = Math.max(0.5, brushRef.current.size / 2);
    context.save();
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    context.beginPath();
    context.arc(cursor.x, cursor.y, radius, 0, Math.PI * 2);
    context.lineWidth = 3 / view.scale;
    context.strokeStyle = 'rgba(255,255,255,.9)';
    context.stroke();
    context.lineWidth = 1.25 / view.scale;
    context.strokeStyle = brushRef.current.mode === 'add' ? '#6d4ef2' : ERASE_COLOR;
    context.stroke();
    context.restore();
  }, []);

  /**
   * Stage: background + photo only, redrawn when the view or the canvas size changes (never for a
   * selection, node drag, draft point or brush commit). Zoomed out, the photo is sampled from the
   * pyramid level closest to screen resolution instead of resampling the full image every frame.
   */
  const renderNow = useCallback((): 'skipped' | 'drawn' | 'resized' => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || !readyRef.current) return 'skipped';
    const context = stage.getContext('2d');
    if (!context) return 'skipped';
    const rect = stage.getBoundingClientRect();
    const ratio = pixelRatio();
    const pixelWidth = Math.max(1, Math.round(rect.width * ratio));
    const pixelHeight = Math.max(1, Math.round(rect.height * ratio));
    let resized = false;
    for (const canvas of [stage, maskLayerRef.current, vectorLayerRef.current, draftLayerRef.current, interactionCanvasRef.current, cursorCanvasRef.current]) {
      if (canvas && (canvas.width !== pixelWidth || canvas.height !== pixelHeight)) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        resized = true;
      }
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = '#f1f3f7';
    context.fillRect(0, 0, rect.width, rect.height);

    const view = viewRef.current;
    const visible = visibleImageRect(view, rect.width, rect.height, width, height);
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);
    if (visible.right > visible.left && visible.bottom > visible.top) {
      // Only the visible part of the photo. Real pixels when zoomed in (no blur), smooth when zoomed out.
      context.imageSmoothingEnabled = view.scale < 1.5;
      context.imageSmoothingQuality = 'medium';
      const visibleWidth = visible.right - visible.left;
      const visibleHeight = visible.bottom - visible.top;
      const levels = photoLevelsRef.current;
      const level = photoLevelFor(view.scale, ratio, levels.length);
      const source = levels[level] ?? image;
      const scaleX = level ? (source as HTMLCanvasElement).width / width : 1;
      const scaleY = level ? (source as HTMLCanvasElement).height / height : 1;
      context.drawImage(source, visible.left * scaleX, visible.top * scaleY, visibleWidth * scaleX, visibleHeight * scaleY,
        visible.left, visible.top, visibleWidth, visibleHeight);
    }
    context.restore();
    // The cursor overlay lives in screen space; keep it attached to the image while zooming/panning.
    if (toolRef.current === 'brush') drawBrushCursor();
    return resized ? 'resized' : 'drawn';
  }, [drawBrushCursor, height, width]);

  /** Draft polygon (with the hover preview edge) and the selection marquee, in screen space. */
  const renderDraftLayer = useCallback(() => {
    const layer = draftLayerRef.current;
    const context = layer?.getContext('2d');
    if (!layer || !context) return;
    const draft = draftRef.current.nodes;
    const marquee = marqueeRef.current;
    if (!draft.length && !marquee) {
      // Nothing to show: clear once, then skip until something is drawn again.
      if (draftLayerDrawnRef.current) { context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, layer.width, layer.height); }
      draftLayerDrawnRef.current = false;
      return;
    }
    draftLayerDrawnRef.current = true;
    const ratio = pixelRatio();
    const view = viewRef.current;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, layer.width, layer.height);
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    const display = displayRef.current;
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

    if (marquee) {
      context.fillStyle = 'rgba(124, 92, 250, .12)';
      context.strokeStyle = '#7c5cfa';
      context.lineWidth = 1 / view.scale;
      context.fillRect(marquee.start.x, marquee.start.y, marquee.end.x - marquee.start.x, marquee.end.y - marquee.start.y);
      context.strokeRect(marquee.start.x, marquee.start.y, marquee.end.x - marquee.start.x, marquee.end.y - marquee.start.y);
    }

    /* Wart overlay temporarily hidden (re-enable here, on the draft layer).
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
    /* Hover delete cross overlay hidden — hoveredNodeRef is still tracked for hit-testing.
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
    */
  }, []);

  /**
   * Mask layer, screen-sized. Polygon mode fills vectors (smooth at any zoom); raster mode copies the
   * image-resolution tint with real pixels when zoomed in, so it never looks blurred. With `rect`
   * only that image rectangle is redrawn (a brush stroke), not the whole mask.
   */
  const renderMaskLayer = useCallback((rect: PolygonBounds | null) => {
    const layer = maskLayerRef.current;
    const tint = tintRef.current;
    const context = layer?.getContext('2d');
    if (!layer || !tint || !context) return;
    const ratio = pixelRatio();
    const view = viewRef.current;
    const display = displayRef.current;
    layer.style.display = display.showMask ? 'block' : 'none';
    layer.style.opacity = String(display.maskOpacity);
    if (!rect) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, layer.width, layer.height);
    }
    const visible = visibleImageRect(view, layer.width / ratio, layer.height / ratio, width, height);
    const area = rect ? {
      left: Math.max(visible.left, Math.floor(rect.left) - 1), top: Math.max(visible.top, Math.floor(rect.top) - 1),
      right: Math.min(visible.right, Math.ceil(rect.right) + 1), bottom: Math.min(visible.bottom, Math.ceil(rect.bottom) + 1),
    } : visible;
    if (area.right <= area.left || area.bottom <= area.top) return;
    const areaWidth = area.right - area.left;
    const areaHeight = area.bottom - area.top;
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    context.save();
    context.beginPath();
    context.rect(area.left, area.top, areaWidth, areaHeight);
    context.clip();
    if (rect) context.clearRect(area.left, area.top, areaWidth, areaHeight);
    if (polygonModeRef.current && vectorRevisionRef.current === maskRevisionRef.current) {
      for (const polygon of polygonsRef.current) {
        if (polygon.nodes.length < 3) continue;
        const bounds = polygonBounds(polygon);
        if (bounds.right < area.left || bounds.left > area.right || bounds.bottom < area.top || bounds.top > area.bottom) continue;
        context.fillStyle = polygon.meta?.locked ? '#fff' : POLYGON_FILL;
        context.fill(polygonPathAt(polygon, view.scale), 'evenodd');
      }
    } else {
      context.imageSmoothingEnabled = view.scale < 1;
      context.drawImage(tint, area.left, area.top, areaWidth, areaHeight, area.left, area.top, areaWidth, areaHeight);
    }
    context.restore();
  }, [height, width]);

  /**
   * Image-space box containing everything the outline layer draws for `polygon` at `scale`: the
   * outline (≤ 3 px), node handles (≤ 4.25 px + stroke) and, for a selected polygon, its label tag.
   */
  const vectorExtent = useCallback((polygon: AnnotationPolygon, scale: number): PolygonBounds => {
    const bounds = polygonBounds(polygon);
    const pad = 8 / scale;
    const extent = { left: bounds.left - pad, top: bounds.top - pad, right: bounds.right + pad, bottom: bounds.bottom + pad };
    if (polygon.label && selectedPolygonIdsRef.current.has(polygon.id)) {
      const tagTop = Math.max(0, bounds.top - 29 / scale);
      extent.top = Math.min(extent.top, tagTop - pad);
      extent.bottom = Math.max(extent.bottom, tagTop + 23 / scale + pad);
      extent.right = Math.max(extent.right, bounds.left + 260 / scale);
    }
    return extent;
  }, []);

  /**
   * Outlines, labels and node handles in screen space; redrawn on content change or when a zoom settles.
   * With `rect` (image space, e.g. a node drag) only that dirty rectangle — snapped outward to device
   * pixels — is replaced: polygons whose extent touches it are drawn into a back buffer and the
   * rectangle is copied over 1:1, identical to a full redraw (checked by scripts/canvas-browser-check.mjs).
   */
  const renderVectorLayer = useCallback((rect: PolygonBounds | null = null) => {
    const layer = vectorLayerRef.current;
    const layerContext = layer?.getContext('2d');
    if (!layer || !layerContext) return;
    const ratio = pixelRatio();
    const view = viewRef.current;
    layerContext.setTransform(1, 0, 0, 1, 0, 0);
    let context = layerContext;
    // Dirty rectangle in device pixels, and the same area in image space (`clip`).
    let device: PolygonBounds | null = null;
    let clip: PolygonBounds | null = null;
    if (rect) {
      const left = Math.max(0, Math.floor((rect.left * view.scale + view.x) * ratio));
      const top = Math.max(0, Math.floor((rect.top * view.scale + view.y) * ratio));
      const right = Math.min(layer.width, Math.ceil((rect.right * view.scale + view.x) * ratio));
      const bottom = Math.min(layer.height, Math.ceil((rect.bottom * view.scale + view.y) * ratio));
      if (right <= left || bottom <= top) return;
      // The touched polygons are drawn unclipped into a back buffer and only the rectangle is copied
      // back 1:1, so each pixel in it is rasterized exactly as in a full redraw (a clip() would
      // antialias strokes crossing its edge slightly differently).
      let buffer = vectorBufferRef.current;
      if (!buffer) { buffer = document.createElement('canvas'); vectorBufferRef.current = buffer; }
      if (buffer.width !== layer.width) buffer.width = layer.width;
      if (buffer.height !== layer.height) buffer.height = layer.height;
      const bufferContext = buffer.getContext('2d');
      if (!bufferContext) return;
      context = bufferContext;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(left, top, right - left, bottom - top);
      device = { left, top, right, bottom };
      clip = {
        left: (left / ratio - view.x) / view.scale, top: (top / ratio - view.y) / view.scale,
        right: (right / ratio - view.x) / view.scale, bottom: (bottom / ratio - view.y) / view.scale,
      };
    } else {
      layerContext.clearRect(0, 0, layer.width, layer.height);
    }
    const copyBack = () => {
      if (!device) return;
      const width = device.right - device.left;
      const height = device.bottom - device.top;
      layerContext.setTransform(1, 0, 0, 1, 0, 0);
      layerContext.imageSmoothingEnabled = false;
      layerContext.clearRect(device.left, device.top, width, height);
      layerContext.drawImage(context.canvas, device.left, device.top, width, height, device.left, device.top, width, height);
    };
    if (!polygonModeRef.current || vectorRevisionRef.current !== maskRevisionRef.current) {
      copyBack();
      return;
    }
    // Handles near the rectangle edge share the 8 px de-dup grid with nodes just outside it: cull 16 px wider.
    const viewportPadding = (clip ? 16 : 20) / view.scale;
    const viewportBounds = clip ? {
      left: clip.left - viewportPadding, right: clip.right + viewportPadding,
      top: clip.top - viewportPadding, bottom: clip.bottom + viewportPadding,
    } : {
      left: -view.x / view.scale - viewportPadding,
      right: (layer.width / ratio - view.x) / view.scale + viewportPadding,
      top: -view.y / view.scale - viewportPadding,
      bottom: (layer.height / ratio - view.y) / view.scale + viewportPadding,
    };
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    const minimumSize = 1.5 / view.scale;
    const dots = new Path2D();
    let hasDots = false;
    const lockedPolygons: AnnotationPolygon[] = [];
    const selectedPolygons: AnnotationPolygon[] = [];
    context.lineWidth = 1.5 / view.scale;
    context.strokeStyle = POLYGON_STROKE;
    for (const polygon of polygonsRef.current) {
      if (polygon.nodes.length < 2) continue;
      const bounds = polygonBounds(polygon);
      const reach = clip ? vectorExtent(polygon, view.scale) : bounds;
      if (reach.right < viewportBounds.left || reach.left > viewportBounds.right
          || reach.bottom < viewportBounds.top || reach.top > viewportBounds.bottom) continue;
      if (selectedPolygonIdsRef.current.has(polygon.id)) { selectedPolygons.push(polygon); continue; }
      if (polygon.meta?.locked) { lockedPolygons.push(polygon); continue; }
      // Regions smaller than a screen pixel at this zoom: one dot instead of a path.
      if (bounds.right - bounds.left < minimumSize && bounds.bottom - bounds.top < minimumSize) {
        dots.rect(bounds.left, bounds.top, minimumSize, minimumSize);
        hasDots = true;
        continue;
      }
      context.stroke(polygonPathAt(polygon, view.scale));
    }
    if (hasDots) {
      context.fillStyle = POLYGON_STROKE;
      context.fill(dots);
    }
    context.strokeStyle = '#667085';
    for (const polygon of lockedPolygons) context.stroke(polygonPathAt(polygon, view.scale));
    for (const polygon of selectedPolygons) {
      const locked = polygon.meta?.locked === true;
      context.lineWidth = 3 / view.scale;
      context.strokeStyle = locked ? '#667085' : '#6d4ef2';
      context.stroke(polygonPathAt(polygon, view.scale));
      if (polygon.label) {
        const bounds = polygonBounds(polygon);
        const anchorX = bounds.left;
        const anchorY = bounds.top;
        const fontSize = 12 / view.scale;
        const paddingX = 7 / view.scale;
        const tagHeight = 23 / view.scale;
        const labelText = polygon.label;
        const text = labelText.length > 28 ? `${labelText.slice(0, 27)}…` : labelText;
        context.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        const iconWidth = locked ? 18 / view.scale : 0;
        const tagWidth = context.measureText(text).width + paddingX * 2 + iconWidth;
        const tagY = Math.max(0, anchorY - tagHeight - 6 / view.scale);
        context.fillStyle = '#ffffff';
        context.fillRect(anchorX, tagY, tagWidth, tagHeight);
        context.fillStyle = '#344054';
        context.textBaseline = 'middle';
        if (locked) {
          context.save();
          context.translate(anchorX + paddingX, tagY + (tagHeight - 14 / view.scale) / 2);
          context.scale(1 / view.scale, 1 / view.scale);
          context.strokeStyle = '#667085';
          context.lineWidth = 1.5;
          context.lineJoin = 'round';
          context.lineCap = 'round';
          context.beginPath();
          context.roundRect(1.5, 6, 11, 7.5, 1.5);
          context.stroke();
          context.beginPath();
          context.moveTo(4, 6);
          context.lineTo(4, 4);
          context.arc(7, 4, 3, Math.PI, 0);
          context.lineTo(10, 6);
          context.stroke();
          context.restore();
        }
        context.fillText(text, anchorX + paddingX + iconWidth, tagY + tagHeight / 2);
      }
      if (toolRef.current === 'select' || toolRef.current === 'polygon') {
        // Screen-space grid: retain exact vertices for editing, avoid overdraw of overlapping handles.
        // All handles of one style go into a single path, so thousands of nodes cost two draw calls.
        const occupied = new Set<number>();
        const normalHandles = new Path2D();
        const activeHandles = new Path2D();
        const normalRadius = 2.75 / view.scale;
        const activeRadius = 4.25 / view.scale;
        for (const ring of polygonRings(polygon)) {
          for (const node of ring) {
            if (node.x < viewportBounds.left || node.x > viewportBounds.right
                || node.y < viewportBounds.top || node.y > viewportBounds.bottom) continue;
            const nodeSelected = selectedNodeIdsRef.current.has(node.id);
            const cell = Math.floor((node.x * view.scale + view.x) / 8) * 65536 + Math.floor((node.y * view.scale + view.y) / 8);
            if (!nodeSelected && occupied.has(cell)) continue;
            occupied.add(cell);
            const path = nodeSelected ? activeHandles : normalHandles;
            const radius = nodeSelected ? activeRadius : normalRadius;
            path.moveTo(node.x + radius, node.y);
            path.arc(node.x, node.y, radius, 0, Math.PI * 2);
          }
        }
        context.lineWidth = 1.5 / view.scale;
        context.fillStyle = locked ? '#eaecf0' : '#cfc4ff';
        context.fill(normalHandles);
        context.strokeStyle = locked ? '#98a2b3' : '#7c5cfa';
        context.stroke(normalHandles);
        context.fillStyle = locked ? '#eaecf0' : '#ffffff';
        context.fill(activeHandles);
        context.strokeStyle = locked ? '#98a2b3' : '#6d4ef2';
        context.stroke(activeHandles);
      }
    }
    copyBack();
  }, [vectorExtent]);

  /** Moves not-yet-redrawn layers from the view they were drawn at to the current view (GPU only). */
  const applyLayerTransforms = useCallback(() => {
    const view = viewRef.current;
    const layers = layerViewRef.current;
    for (const [layer, drawnAt] of [[maskLayerRef.current, layers.mask], [vectorLayerRef.current, layers.vectors]] as const) {
      if (!layer) continue;
      // A promoted compositor layer costs GPU memory; only keep it while a zoom/pan is in progress.
      if (!drawnAt || sameView(drawnAt, view)) { layer.style.transform = ''; layer.style.willChange = ''; continue; }
      const factor = view.scale / drawnAt.scale;
      layer.style.willChange = 'transform';
      layer.style.transform = `matrix(${factor},0,0,${factor},${view.x - factor * drawnAt.x},${view.y - factor * drawnAt.y})`;
    }
  }, []);

  const scheduleFrame = useCallback(() => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      const dirty = dirtyRef.current;
      if (dirty.stage) {
        const stage = renderNow();
        if (stage !== 'skipped') dirty.stage = false;
        // Resizing a canvas clears it: every layer must be drawn again.
        if (stage === 'resized') { dirty.draft = true; dirty.mask = true; dirty.maskRect = null; dirty.vectors = true; dirty.vectorsRect = null; }
      }
      if (!readyRef.current) return;
      const view = { ...viewRef.current };
      const layers = layerViewRef.current;
      if (dirty.mask) {
        // A partial redraw is only valid when the layer is still aligned with the current view.
        renderMaskLayer(dirty.maskRect && layers.mask && sameView(layers.mask, view) ? dirty.maskRect : null);
        layers.mask = view;
        dirty.mask = false;
        dirty.maskRect = null;
      }
      if (dirty.vectors) {
        // Same rule as the mask: a partial redraw needs the layer aligned with the current view.
        renderVectorLayer(dirty.vectorsRect && layers.vectors && sameView(layers.vectors, view) ? dirty.vectorsRect : null);
        layers.vectors = view;
        dirty.vectors = false;
        dirty.vectorsRect = null;
      }
      if (dirty.draft) {
        renderDraftLayer();
        dirty.draft = false;
      }
      applyLayerTransforms();
      if (clearInteractionOnFrameRef.current) {
        // The live brush preview disappears in the same frame as the committed mask appears: no flicker.
        clearInteractionOnFrameRef.current = false;
        const overlay = interactionCanvasRef.current;
        overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height);
      }
      // While points of a new polygon are being placed, undo/redo only step through those points.
      const state = draftRef.current.historyState(historyUndoRef.current.length, historyRedoRef.current.length);
      const key = JSON.stringify(state);
      if (key !== lastHistoryRef.current) {
        lastHistoryRef.current = key;
        onHistoryChange?.(state);
      }
    });
  }, [applyLayerTransforms, onHistoryChange, renderDraftLayer, renderMaskLayer, renderNow, renderVectorLayer]);

  /** Content changed (polygons, selection, draft, tool): redraw outlines and the draft layer, not the photo. */
  const render = useCallback(() => {
    dirtyRef.current.vectors = true;
    dirtyRef.current.vectorsRect = null;
    dirtyRef.current.draft = true;
    scheduleFrame();
  }, [scheduleFrame]);

  /** Only the outlines inside `rect` (image space) changed, e.g. the polygons under a node drag. */
  const invalidateVectors = useCallback((rect: PolygonBounds) => {
    const dirty = dirtyRef.current;
    if (!dirty.vectors) {
      dirty.vectorsRect = { ...rect };
    } else if (dirty.vectorsRect) {
      dirty.vectorsRect = {
        left: Math.min(dirty.vectorsRect.left, rect.left), top: Math.min(dirty.vectorsRect.top, rect.top),
        right: Math.max(dirty.vectorsRect.right, rect.right), bottom: Math.max(dirty.vectorsRect.bottom, rect.bottom),
      };
    }
    // else: a full redraw is already pending.
    dirty.vectors = true;
    scheduleFrame();
  }, [scheduleFrame]);

  /** Only the draft preview or the marquee moved. */
  const renderDraft = useCallback(() => {
    dirtyRef.current.draft = true;
    scheduleFrame();
  }, [scheduleFrame]);

  /**
   * View changed (zoom/pan): redraw the photo and draft now, move the mask/vector layers on the GPU,
   * and redraw those sharp once the gesture settles.
   */
  const renderView = useCallback(() => {
    dirtyRef.current.stage = true;
    dirtyRef.current.draft = true;
    scheduleFrame();
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      const dirty = dirtyRef.current;
      dirty.mask = true;
      dirty.maskRect = null;
      dirty.vectors = true;
      dirty.vectorsRect = null;
      scheduleFrame();
    }, 120);
  }, [scheduleFrame]);

  /** Mask content changed; with `rect` only that image rectangle of the mask layer is redrawn. */
  const invalidateMask = useCallback((rect?: PolygonBounds) => {
    const dirty = dirtyRef.current;
    if (!rect || (dirty.mask && !dirty.maskRect)) {
      dirty.maskRect = null;
    } else if (!dirty.mask) {
      dirty.maskRect = { ...rect };
    } else if (dirty.maskRect) {
      dirty.maskRect = {
        left: Math.min(dirty.maskRect.left, rect.left), top: Math.min(dirty.maskRect.top, rect.top),
        right: Math.max(dirty.maskRect.right, rect.right), bottom: Math.max(dirty.maskRect.bottom, rect.bottom),
      };
    }
    dirty.mask = true;
    scheduleFrame();
  }, [scheduleFrame]);

  const invalidateAll = useCallback(() => {
    dirtyRef.current = { stage: true, draft: true, mask: true, maskRect: null, vectors: true, vectorsRect: null };
    scheduleFrame();
  }, [scheduleFrame]);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
    // StrictMode (dev) remounts with the same refs; a stale id would make render() skip forever.
    renderFrameRef.current = null;
  }, []);

  useEffect(() => {
    if (toolRef.current === 'brush' && tool !== 'brush') {
      flushNotify();
      if (pendingVectorNotifyRef.current) {
        pendingVectorNotifyRef.current = false;
        notifyChange('MODIFIED', polygonsRef.current);
      }
      brushStrokeRef.current = [];
      brushCursorRef.current = null;
      pendingBrushSamplesRef.current = [];
      if (pointerRef.current?.mode === 'brush') pointerRef.current = null;
      for (const canvas of [interactionCanvasRef.current, cursorCanvasRef.current]) {
        const context = canvas?.getContext('2d');
        if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (vectorRevisionRef.current !== maskRevisionRef.current) {
        vectorStatusRef.current = 'DIRTY';
        vectorCacheRef.current.status = 'DIRTY';
        polygonModeRef.current = false;
        scheduleVectorizationRef.current(0);
        onMessage('Đang chuẩn bị biên polygon… Mask raster vẫn được giữ nguyên.');
      }
    }
    // Prepare the binary raster (and the worker) as soon as the main thread is idle, so the first stroke
    // commits without a hitch while the tool switch itself paints immediately. A stroke that starts
    // earlier prepares it synchronously in commitBrushStroke.
    if (tool === 'brush') whenIdle(() => { if (aliveRef.current && toolRef.current === 'brush') ensureMaskRaster(); });
    if (tool !== 'polygon' && tool !== 'pan' && draftRef.current.editing) {
      draftRef.current.clear();
      polygonHoverRef.current = null;
    }
    hoveredNodeRef.current = null;
    toolRef.current = tool;
    render();
  }, [ensureMaskRaster, flushNotify, notifyChange, onMessage, render, tool]);

  useEffect(() => {
    displayRef.current = { showMask, maskOpacity };
    // Visibility and opacity are layer styles: no redraw needed.
    const layer = maskLayerRef.current;
    if (layer) {
      layer.style.display = showMask ? 'block' : 'none';
      layer.style.opacity = String(maskOpacity);
    }
  }, [maskOpacity, showMask]);

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

  const clearOverlay = useCallback((target: HTMLCanvasElement | null) => {
    const context = target?.getContext('2d');
    if (target && context) context.clearRect(0, 0, target.width, target.height);
  }, []);

  const drawTransientSegments = useCallback((points: ImagePoint[], mode: BrushMode, radius: number) => {
    const target = interactionCanvasRef.current;
    const context = target?.getContext('2d');
    if (!target || !context || !points.length) return;
    const ratio = pixelRatio();
    const view = viewRef.current;
    context.save();
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    // Opaque paint + CSS opacity on the layer: overlapping frame segments do not darken at joints.
    context.fillStyle = mode === 'add' ? POLYGON_FILL : ERASE_COLOR;
    context.strokeStyle = context.fillStyle;
    context.lineWidth = radius * 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    if (points.length === 1) {
      context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
      context.stroke();
    }
    context.restore();
  }, []);

  useEffect(() => {
    brushRef.current = { mode: brushMode, size: brushSize };
    if (toolRef.current === 'brush') drawBrushCursor();
  }, [brushMode, brushSize, drawBrushCursor]);

  const rebuildPolygonTint = useCallback((polygons: AnnotationPolygon[]) => {
    const target = tintRef.current;
    const context = target?.getContext('2d');
    if (!target || !context) return;
    let lockedMask = lockedMaskRef.current;
    if (!lockedMask) {
      lockedMask = document.createElement('canvas');
      lockedMaskRef.current = lockedMask;
    }
    if (lockedMask.width !== target.width) lockedMask.width = target.width;
    if (lockedMask.height !== target.height) lockedMask.height = target.height;
    const lockedContext = lockedMask.getContext('2d');
    const lockedPolygons = polygons.filter((polygon) => polygon.meta?.locked && polygon.nodes.length >= 3);
    // Keep the protection mask binary, matching the authoritative pixel mask exactly. Opaque cached
    // pixels can be copied repeatedly without antialiased edge alpha accumulating between strokes.
    if (lockedContext) putPolygonRaster(lockedContext, lockedPolygons, lockedMask.width, lockedMask.height);
    lockedPixelsRef.current = Boolean(lockedContext) && lockedPolygons.length > 0;
    // Native antialiased fill (cached Path2D) instead of a per-pixel JS loop: smooth edges and
    // no full-image ImageData. The binary export raster is rebuilt lazily by ensureMaskRaster.
    context.clearRect(0, 0, target.width, target.height);
    for (const polygon of polygons) {
      if (polygon.nodes.length < 3) continue;
      const path = polygonPath(polygon);
      context.fillStyle = polygon.meta?.locked ? '#fff' : POLYGON_FILL;
      context.fill(path, 'evenodd');
    }
    pendingMaskPolygonsRef.current = polygons;
    workerSyncedRef.current = false;
    invalidateMask();
  }, [invalidateMask]);

  /**
   * Image pyramid of the photo, one halving per idle slice (each level drawn from the previous one, which
   * averages like a box filter). The stage switches to a level as soon as it exists; until then, and
   * when zoomed in, it draws the full photo.
   */
  const buildPhotoPyramid = useCallback((image: HTMLImageElement) => {
    const build = ++pyramidBuildRef.current;
    const sizes = photoPyramidSizes(width, height);
    const levels: Array<HTMLImageElement | HTMLCanvasElement> = [image];
    photoLevelsRef.current = levels.slice();
    const next = () => {
      const size = sizes[levels.length - 1];
      if (!size || !aliveRef.current || pyramidBuildRef.current !== build || imageRef.current !== image) return;
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(levels[levels.length - 1], 0, 0, size.width, size.height);
      levels.push(canvas);
      photoLevelsRef.current = levels.slice();
      dirtyRef.current.stage = true;
      scheduleFrame();
      whenIdle(next);
    };
    whenIdle(next);
  }, [height, scheduleFrame, width]);

  /**
   * GPU-backed canvases lose their pixels on a GPU reset or under memory pressure. The layers are only
   * redrawn where something changed, so without this the screen would show just the next brush stroke.
   * The binary mask lives on a CPU canvas (willReadFrequently) and survives: rebuild the tint from it.
   */
  const repaintAfterContextLoss = useCallback(() => {
    const tint = tintRef.current;
    const mask = maskRef.current;
    const tintContext = tint?.getContext('2d');
    if (tint && mask && tintContext && !tintContext.isContextLost()) {
      const polygons = pendingMaskPolygonsRef.current;
      if (polygons) {
        tintContext.clearRect(0, 0, tint.width, tint.height);
        for (const polygon of polygons) {
          if (polygon.nodes.length >= 3) {
            tintContext.fillStyle = polygon.meta?.locked ? '#fff' : POLYGON_FILL;
            tintContext.fill(polygonPath(polygon), 'evenodd');
          }
        }
      } else {
        rebuildTint(mask, tint, POLYGON_FILL);
      }
    }
    // Pyramid levels are GPU canvases too.
    if (imageRef.current) buildPhotoPyramid(imageRef.current);
    invalidateAll();
  }, [buildPhotoPyramid, invalidateAll, rebuildTint]);
  const contextRestoreRef = useRef(repaintAfterContextLoss);
  contextRestoreRef.current = repaintAfterContextLoss;

  useEffect(() => {
    const canvases = [stageRef, maskLayerRef, vectorLayerRef, draftLayerRef, interactionCanvasRef, cursorCanvasRef]
      .flatMap((canvasRef) => canvasRef.current ? [canvasRef.current] : []);
    const onRestored = () => contextRestoreRef.current();
    for (const canvas of canvases) canvas.addEventListener('contextrestored', onRestored);
    return () => { for (const canvas of canvases) canvas.removeEventListener('contextrestored', onRestored); };
  }, []);

  const paintBrushPreview = useCallback((points: ImagePoint[], mode: BrushMode, radius: number, bounds?: BrushBounds) => {
    if (!points.length) return;
    for (const [target, color] of [[maskRef.current, '#fff'], [tintRef.current, POLYGON_FILL]] as const) {
      const context = target?.getContext('2d');
      if (!target || !context) continue;
      context.save();
      context.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
      context.fillStyle = color;
      context.strokeStyle = color;
      context.lineWidth = radius * 2;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      if (points.length === 1) {
        context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
        context.fill();
      } else {
        points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
        context.stroke();
      }
      context.restore();
    }
    const lockedMask = lockedMaskRef.current;
    if (!lockedMask || !bounds || !lockedPixelsRef.current) return;
    const patchWidth = bounds.right - bounds.left;
    const patchHeight = bounds.bottom - bounds.top;
    if (patchWidth <= 0 || patchHeight <= 0) return;
    // Restore only the touched region, so locked pixels stay immutable without scanning the mask.
    for (const target of [maskRef.current, tintRef.current]) {
      const context = target?.getContext('2d');
      if (!target || !context) continue;
      context.drawImage(
        lockedMask,
        bounds.left, bounds.top, patchWidth, patchHeight,
        bounds.left, bounds.top, patchWidth, patchHeight,
      );
    }
  }, []);

  const requestLatestVector = useCallback((): Promise<void> => {
    const revision = maskRevisionRef.current;
    if (vectorRevisionRef.current === revision && vectorStatusRef.current === 'READY') return Promise.resolve();
    if (vectorizeTimerRef.current !== null) {
      window.clearTimeout(vectorizeTimerRef.current);
      vectorizeTimerRef.current = null;
    }
    const waiting = new Promise<void>((resolve) => {
      const waiters = vectorWaitersRef.current.get(revision) ?? [];
      waiters.push(resolve);
      vectorWaitersRef.current.set(revision, waiters);
    });
    if (vectorizingRevisionRef.current !== null) return waiting;
    vectorStatusRef.current = 'VECTORING';
    vectorCacheRef.current.status = 'VECTORING';
    vectorizingRevisionRef.current = revision;
    if (backgroundVectorTimerRef.current !== null) {
      window.clearTimeout(backgroundVectorTimerRef.current);
      backgroundVectorTimerRef.current = null;
    }
    syncWorkerMask();
    brushWorkerRef.current?.postMessage({ type: 'VECTORIZE', revision, send: true } satisfies MaskWorkerRequest);
    return waiting;
  }, [syncWorkerMask]);

  const scheduleVectorization = useCallback((delay = 180) => {
    if (vectorizeTimerRef.current !== null) window.clearTimeout(vectorizeTimerRef.current);
    // Never downgrade polygons that already describe the current mask (e.g. just committed by the user):
    // a late worker result would otherwise re-trace them and merge touching polygons into one component.
    if (vectorsCurrent()) { vectorizeTimerRef.current = null; return; }
    vectorStatusRef.current = 'DIRTY';
    vectorCacheRef.current.status = 'DIRTY';
    vectorizeTimerRef.current = window.setTimeout(() => {
      vectorizeTimerRef.current = null;
      void requestLatestVector();
    }, delay);
  }, [requestLatestVector, vectorsCurrent]);
  scheduleVectorizationRef.current = scheduleVectorization;

  // While the user draws, the worker keeps contours up to date in the background without posting them
  // back (no main-thread cost). Leaving the brush or saving then only transfers the changed components.
  const scheduleBackgroundVectorize = useCallback(() => {
    if (backgroundVectorTimerRef.current !== null) window.clearTimeout(backgroundVectorTimerRef.current);
    backgroundVectorTimerRef.current = window.setTimeout(() => {
      backgroundVectorTimerRef.current = null;
      if (pointerRef.current || vectorizingRevisionRef.current !== null || vectorsCurrent()) return;
      syncWorkerMask();
      brushWorkerRef.current?.postMessage({ type: 'VECTORIZE', revision: maskRevisionRef.current, send: false } satisfies MaskWorkerRequest);
    }, 450);
  }, [syncWorkerMask, vectorsCurrent]);

  const handleWorkerMessage = useCallback((response: MaskWorkerResponse) => {
    if (!aliveRef.current) return;
    if (response.type === 'ERROR') {
      vectorStatusRef.current = 'DIRTY';
      vectorCacheRef.current.status = 'DIRTY';
      vectorizingRevisionRef.current = null;
      // Self-heal: the next attempt re-sends the full mask at the current revision.
      workerSyncedRef.current = false;
      // Nobody may wait forever on a failed vectorization; savers fall back to the raw operations.
      vectorWaitersRef.current.forEach((waiters) => waiters.forEach((resolve) => resolve()));
      vectorWaitersRef.current.clear();
      onMessage(response.message);
      if (response.revision !== maskRevisionRef.current && !vectorsCurrent()) scheduleVectorizationRef.current(0);
      return;
    }
    if (response.type === 'MASK_READY' || response.type === 'STROKE_APPLIED') {
      workerRasterRevisionRef.current = response.revision;
      return;
    }
    {
      vectorizingRevisionRef.current = null;
      // vectorSourceRef mirrors what the worker has sent (worker id -> adopted polygon). Deltas are applied
      // even for a stale revision, otherwise the next delta would no longer line up with the mirror.
      const added = unpackPolygons(response.added);
      if (response.full) {
        const adopted = preserveVectorIdentity(added, vectorCacheRef.current.polygons);
        vectorSourceRef.current = new Map(added.map((polygon, index) => [polygon.id, adopted[index]]));
      } else {
        const mirror = new Map(vectorSourceRef.current);
        const removed = response.removed.flatMap((id) => {
          const polygon = mirror.get(id);
          mirror.delete(id);
          return polygon ? [polygon] : [];
        });
        // Labels/ids only need matching against the components that were replaced.
        const adopted = preserveVectorIdentity(added, removed);
        added.forEach((polygon, index) => mirror.set(polygon.id, adopted[index]));
        vectorSourceRef.current = mirror;
      }
      const completedWaiters = vectorWaitersRef.current.get(response.revision) ?? [];
      vectorWaitersRef.current.delete(response.revision);
      if (response.revision !== maskRevisionRef.current) {
        // The mask changed meanwhile. Only re-trace when the current polygons are really out of date.
        if (!vectorsCurrent()) {
          if (toolRef.current === 'brush' && !vectorWaitersRef.current.size) scheduleBackgroundVectorize();
          else scheduleVectorizationRef.current(0);
        }
        completedWaiters.forEach((resolve) => resolve());
        return;
      }
      if (pointerRef.current?.mode === 'nodes') {
        // Never swap polygons under a node drag; the drag's commit decides what happens next.
        completedWaiters.forEach((resolve) => resolve());
        return;
      }
      const polygons = [...vectorSourceRef.current.values()];
      polygonsRef.current = polygons;
      if (toolRef.current === 'select' || toolRef.current === 'polygon') polygonModeRef.current = true;
      vectorRevisionRef.current = response.revision;
      vectorStatusRef.current = 'READY';
      vectorCacheRef.current = { revision: response.revision, status: 'READY', polygons };
      // Still drawing: no React update now (it would stall the brush); leaving the brush/saving notifies.
      if (toolRef.current === 'brush') pendingVectorNotifyRef.current = true;
      else notifyChange('MODIFIED', polygons);
      invalidateMask();
      render();
      completedWaiters.forEach((resolve) => resolve());
      if (process.env.NODE_ENV !== 'production') {
        console.debug('[brush-performance]', {
          maskRevision: maskRevisionRef.current,
          vectorRevision: response.revision,
          vectorizeDuration: response.duration,
          full: response.full,
          addedComponents: added.length,
          removedComponents: response.removed.length,
        });
      }
    }
  }, [invalidateMask, notifyChange, onMessage, render, scheduleBackgroundVectorize, vectorsCurrent]);
  workerMessageRef.current = handleWorkerMessage;

  /** One long-lived worker per canvas; its mask is (re)sent lazily by syncWorkerMask. */
  const createMaskWorker = useCallback(() => {
    brushWorkerRef.current?.terminate();
    const worker = new Worker(new URL('../lib/brush-worker.ts', import.meta.url), { type: 'module' });
    brushWorkerRef.current = worker;
    workerSyncedRef.current = false;
    worker.onmessage = (event: MessageEvent<MaskWorkerResponse>) => workerMessageRef.current(event.data);
    worker.onerror = () => {
      workerSyncedRef.current = false;
      vectorizingRevisionRef.current = null;
      workerMessageRef.current({ type: 'ERROR', revision: maskRevisionRef.current, message: 'Worker mask gặp lỗi. Raster mask vẫn được giữ nguyên.' });
    };
  }, []);

  const normalizeMask = useCallback((image: CanvasImageSource, target: HTMLCanvasElement) => {
    const context = target.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D không khả dụng.');
    context.clearRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    normalizeMaskRgba(data.data);
    context.putImageData(data, 0, 0);
  }, [height, width]);

  /** Binary prediction raster for reset/accept, normalized on first use instead of on every load. */
  const ensurePrediction = useCallback(() => {
    if (predictionRef.current) return predictionRef.current;
    const image = predictionImageRef.current;
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    normalizeMask(image, canvas);
    predictionRef.current = canvas;
    return canvas;
  }, [height, normalizeMask, width]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (!viewport || !surface || !stage) return;
    surface.style.width = '100%';
    surface.style.height = '100%';
    stage.style.width = '100%';
    stage.style.height = '100%';
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    const rect = { width: viewport.clientWidth, height: viewport.clientHeight };
    const scale = Math.max(0.05, Math.min((rect.width - 36) / width, (rect.height - 36) / height));
    viewRef.current = { scale, x: (rect.width - width * scale) / 2, y: (rect.height - height * scale) / 2 };
    onZoomChange?.(scale);
    invalidateAll();
  }, [height, invalidateAll, onZoomChange, width]);

  useEffect(() => {
    let cancelled = false;
    const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      // decode() finishes decoding off the main thread, so the first drawImage does not block on it.
      image.onload = () => { void image.decode().catch(() => undefined).then(() => resolve(image)); };
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
        // When POLYGON_SET is the last operation the polygons are the mask (rebuildPolygonTint below);
        // a stored raster would be decoded, normalized and then overwritten, so it is not loaded at all.
        const polygonMode = polygonModeRef.current;
        const savedMaskUrl = polygonMode ? undefined : localUrl || currentMaskUrl;
        const [image, prediction, savedMask] = await Promise.all([
          loadImage(imageUrl),
          loadImage(predictionUrl),
          // A missing stored mask (e.g. uploaded to another Blob store) must not take the whole
          // editor down: polygons still come from the annotation JSON, the raster falls back.
          savedMaskUrl ? loadImage(savedMaskUrl).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (savedMaskUrl && !savedMask) {
          onMessage('Không tải được mask đã lưu trên máy chủ. Đang hiển thị polygon/mask dự đoán thay thế.');
        }
        for (const asset of [image, prediction, savedMask]) {
          if (asset && (asset.naturalWidth !== width || asset.naturalHeight !== height)) {
            throw new Error('Ảnh/mask khác kích thước tọa độ đã lưu. Dừng tải để tránh kéo giãn và làm lệch polygon.');
          }
        }
        const maskCanvas = makeCanvas();
        // Image-resolution tint stays offscreen; the visible mask layer is screen-sized (sharp at any zoom).
        const tintCanvas = makeCanvas();
        tintRef.current = tintCanvas;
        tintCanvas.addEventListener('contextrestored', () => contextRestoreRef.current());
        predictionImageRef.current = prediction;
        predictionRef.current = null;
        if (polygonMode) {
          // CPU-backed from the first getContext call: brush patches read it back with getImageData.
          maskCanvas.getContext('2d', { willReadFrequently: true });
        } else {
          normalizeMask(savedMask ?? prediction, maskCanvas);
          rebuildTint(maskCanvas, tintCanvas, POLYGON_FILL);
        }
        imageRef.current = image;
        maskRef.current = maskCanvas;
        // Also for an empty POLYGON_SET: the edited raster must match what is shown (nothing), not the prediction.
        if (polygonMode) rebuildPolygonTint(polygonsRef.current);
        createMaskWorker();
        buildPhotoPyramid(image);
        readyRef.current = true;
        fittedRef.current = true;
        fit();
        onReady();
      } catch (error) {
        onMessage((error as Error).message);
      } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [buildPhotoPyramid, createMaskWorker, currentMaskUrl, fit, height, imageUrl, initialHumanAction, localMaskBlob, normalizeMask, notifyChange, onMessage, onReady, predictionUrl, rebuildPolygonTint, rebuildTint, width]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => fittedRef.current ? invalidateAll() : fit());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fit, invalidateAll]);

  const imagePoint = useCallback((event: React.MouseEvent<HTMLCanvasElement>): ImagePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left - view.x) / view.scale)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top - view.y) / view.scale)),
    };
  }, [height, width]);

  const clientPointToImage = useCallback((clientX: number, clientY: number, knownRect?: DOMRect): ImagePoint => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = knownRect ?? stage.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: Math.max(0, Math.min(width, (clientX - rect.left - view.x) / view.scale)),
      y: Math.max(0, Math.min(height, (clientY - rect.top - view.y) / view.scale)),
    };
  }, [height, width]);

  const flushBrushFrame = useCallback(() => {
    brushFrameRef.current = null;
    const started = performance.now();
    const active = pointerRef.current;
    const samples = pendingBrushSamplesRef.current;
    pendingBrushSamplesRef.current = [];
    const rect = stageRef.current?.getBoundingClientRect();
    if (active?.mode === 'brush' && samples.length) {
      const segment = [active.last];
      const minimumDistance = Math.max(0.1, Math.min(0.5, active.radius * 0.2));
      for (const sample of samples) {
        const point = clientPointToImage(sample.clientX, sample.clientY, rect);
        if (Math.hypot(point.x - active.last.x, point.y - active.last.y) < minimumDistance) continue;
        brushStrokeRef.current.push(point);
        active.last = point;
        segment.push(point);
      }
      if (segment.length > 1) drawTransientSegments(segment, active.brushMode, active.radius);
    }
    const cursor = latestBrushCursorRef.current;
    if (cursor) brushCursorRef.current = clientPointToImage(cursor.clientX, cursor.clientY, rect);
    drawBrushCursor();
    if (process.env.NODE_ENV !== 'production' && performance.now() - started > 4) {
      console.debug('[brush-performance]', { brushFrameDuration: performance.now() - started });
    }
  }, [clientPointToImage, drawBrushCursor, drawTransientSegments]);

  const scheduleBrushFrame = useCallback(() => {
    if (brushFrameRef.current === null) brushFrameRef.current = requestAnimationFrame(flushBrushFrame);
  }, [flushBrushFrame]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    const stack = historyUndoRef.current;
    stack.push(entry);
    let bytes = stack.reduce((sum, item) => sum + historyBytes(item), 0);
    while (stack.length > HISTORY_LIMIT || (bytes > HISTORY_BYTES && stack.length > 1)) bytes -= historyBytes(stack.shift()!);
    historyRedoRef.current = [];
  }, []);

  /**
   * Polygon edits are only valid on polygons that describe the current mask. Right after brush strokes
   * (or on a raster-only file) they are still being traced: committing then would replace the whole mask
   * with stale or empty polygons, and undo would "restore" that empty state.
   */
  const commitPolygons = useCallback((next: AnnotationPolygon[], before: DocumentState = captureDocument()) => {
    if (!before.vectorsCurrent) {
      onMessage('Polygon đang được cập nhật theo mask vừa sửa. Hãy thử lại sau giây lát.');
      scheduleVectorizationRef.current(0);
      return false;
    }
    hoveredNodeRef.current = null;
    polygonsRef.current = next;
    polygonModeRef.current = true;
    operationsRef.current = polygonOperation(next);
    brushOperationRef.current = [];
    maskRevisionRef.current += 1;
    vectorRevisionRef.current = maskRevisionRef.current;
    vectorStatusRef.current = 'READY';
    vectorCacheRef.current = { revision: maskRevisionRef.current, status: 'READY', polygons: next };
    humanActionRef.current = 'MODIFIED';
    pushHistory({ kind: 'polygons', before, after: captureDocument() });
    rebuildPolygonTint(next);
    render();
    notifyChange('MODIFIED', next);
    notifySelection();
    return true;
  }, [captureDocument, notifyChange, notifySelection, onMessage, pushHistory, rebuildPolygonTint, render]);

  const commitDraft = useCallback((draft: PolygonNode[]) => {
    const created: AnnotationPolygon = {
      id: crypto.randomUUID(),
      label: nextLabel(polygonsRef.current, 'ridge'),
      nodes: draft.map((node) => ({ ...node })),
      meta: { semantic: 'main_flesh_band', source: 'human' },
    };
    draftRef.current.clear();
    hoveredNodeRef.current = null;
    polygonHoverRef.current = null;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([created.id]);
    commitPolygons([...polygonsRef.current, created]);
    onPolygonComplete?.();
    return true;
  }, [commitPolygons, onPolygonComplete]);

  const completePolygon = useCallback(() => {
    const draft = draftRef.current.nodes;
    if (draft.length < 3) {
      onMessage('Đa giác cần ít nhất 3 node.');
      return false;
    }
    if (vectorsCurrent()) return commitDraft(draft);
    // Existing mask is still being turned into polygons: keep the draft and add it as soon as they are ready.
    onMessage('Đang cập nhật polygon từ mask… polygon mới sẽ được thêm ngay khi xong.');
    void requestLatestVector().then(() => {
      if (!aliveRef.current || draftRef.current.nodes !== draft) return;
      if (vectorsCurrent()) commitDraft(draft);
      else onMessage('Chưa cập nhật được polygon từ mask. Hãy bấm hoàn tất lại.');
    });
    return false;
  }, [commitDraft, onMessage, requestLatestVector, vectorsCurrent]);

  const cancelCurrentPath = useCallback(() => {
    draftRef.current.clear();
    hoveredNodeRef.current = null;
    polygonHoverRef.current = null;
    brushStrokeRef.current = [];
    brushCursorRef.current = null;
    if (pointerRef.current?.mode === 'brush') pointerRef.current = null;
    marqueeRef.current = null;
    render();
  }, [render]);

  const commitBrushStroke = useCallback((points: ImagePoint[], mode: BrushMode, radius: number) => {
    if (!points.length || !maskRef.current) return;
    if (process.env.NODE_ENV !== 'production') performance.mark('brush-pointerup-start');
    const rawBounds = brushBounds(points, radius + 1);
    const bounds = {
      left: Math.max(0, Math.floor(rawBounds.left)), top: Math.max(0, Math.floor(rawBounds.top)),
      right: Math.min(width, Math.ceil(rawBounds.right)), bottom: Math.min(height, Math.ceil(rawBounds.bottom)),
    };
    ensureMaskRaster();
    const context = maskRef.current.getContext('2d', { willReadFrequently: true });
    if (!context || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
    const before = captureDocument();
    const patchWidth = bounds.right - bounds.left;
    const patchHeight = bounds.bottom - bounds.top;
    const beforePixels = context.getImageData(bounds.left, bounds.top, patchWidth, patchHeight);
    paintBrushPreview(points, mode, radius, bounds);
    const afterPixels = context.getImageData(bounds.left, bounds.top, patchWidth, patchHeight);
    maskRevisionRef.current += 1;
    // Sub-centipixel precision is invisible but bloats the saved JSON for long strokes.
    const compactPoints = points.map((point) => ({ x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }));
    const operation: BrushOperation = {
      id: crypto.randomUUID(), revision: maskRevisionRef.current,
      type: mode === 'erase' ? 'BRUSH_ERASE' : 'BRUSH_ADD', radius, points: compactPoints, bounds,
    };
    operationsRef.current.push(operation);
    brushOperationRef.current.push(operation);
    const hadSelection = selectedPolygonIdsRef.current.size > 0 || selectedNodeIdsRef.current.size > 0;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    humanActionRef.current = 'MODIFIED';
    vectorStatusRef.current = 'DIRTY';
    vectorCacheRef.current.status = 'DIRTY';
    pushHistory({ kind: 'brush', before, after: captureDocument(), bounds, beforePixels, afterPixels });
    // Visible immediately: only the stroke rectangle of the mask layer is redrawn.
    invalidateMask(bounds);
    // The worker receives just the stroke rectangle and re-traces contours in the background while the
    // user keeps drawing; nothing comes back until polygons are needed (leave brush / save).
    if (workerSyncedRef.current) {
      // The protected ROI is authoritative; replaying the stroke in the worker could erase locked pixels.
      const pixels = new ImageData(new Uint8ClampedArray(afterPixels.data), patchWidth, patchHeight);
      brushWorkerRef.current?.postMessage(
        { type: 'PUT_PATCH', revision: maskRevisionRef.current, bounds, pixels } satisfies MaskWorkerRequest,
        [pixels.data.buffer],
      );
    }
    scheduleBackgroundVectorize();
    scheduleNotify();
    if (hadSelection) notifySelection();
    drawBrushCursor();
    if (process.env.NODE_ENV !== 'production') {
      performance.mark('brush-visible-commit');
      performance.measure('brush-pointerup-visible', 'brush-pointerup-start', 'brush-visible-commit');
    }
  }, [captureDocument, drawBrushCursor, ensureMaskRaster, height, invalidateMask, notifySelection, paintBrushPreview, pushHistory, scheduleBackgroundVectorize, scheduleNotify, width]);

  const deleteSelection = useCallback(() => {
    const selectedNodes = selectedNodeIdsRef.current;
    const selectedPolygons = selectedPolygonIdsRef.current;
    if (!selectedNodes.size && !selectedPolygons.size) return;
    const next = polygonsRef.current.flatMap((polygon) => {
      if (polygon.meta?.locked) return [polygon];
      if (!selectedNodes.size && selectedPolygons.has(polygon.id)) return [];
      const nodes = polygon.nodes.filter((node) => !selectedNodes.has(node.id));
      return nodes.length >= 3 ? [{ ...polygon, nodes, holes: polygon.holes?.map((ring) => ring.filter((node) => !selectedNodes.has(node.id))).filter((ring) => ring.length >= 3) }] : [];
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
      if (!selectedPolygonIdsRef.current.has(polygon.id)) continue;
      const bounds = polygonBounds(polygon);
      if (point.x < bounds.left - radius || point.x > bounds.right + radius
          || point.y < bounds.top - radius || point.y > bounds.bottom + radius) continue;
      for (const ring of polygonRings(polygon)) {
        for (let nodeIndex = ring.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
          const node = ring[nodeIndex];
          if (Math.hypot(node.x - point.x, node.y - point.y) <= radius) return { polygon, node, ring };
        }
      }
    }
    return null;
  }, []);

  const hitPolygon = useCallback((point: ImagePoint) => {
    for (let index = polygonsRef.current.length - 1; index >= 0; index -= 1) {
      if (pointInMask(point, polygonsRef.current[index])) return polygonsRef.current[index];
    }
    return null;
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!readyRef.current || (props.readOnly && tool !== 'pan')) return;
    const point = imagePoint(event);
    hoveredNodeRef.current = null;
    if (event.button === 2) {
      event.preventDefault();
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
      const draft = draftRef.current.nodes;
      const first = draft[0];
      // Clicking the first point closes the polygon; any other click places one undoable point.
      if (first && draft.length >= 3 && Math.hypot(first.x - point.x, first.y - point.y) <= 14 / viewRef.current.scale) {
        completePolygon();
      } else {
        draftRef.current.add({ id: crypto.randomUUID(), ...point });
        render();
      }
      return;
    }
    if (tool === 'brush') {
      event.currentTarget.setPointerCapture(event.pointerId);
      brushStrokeRef.current = [point];
      brushCursorRef.current = point;
      pendingBrushSamplesRef.current = [];
      pointerRef.current = {
        id: event.pointerId,
        mode: 'brush',
        last: point,
        brushMode: brushRef.current.mode,
        radius: Math.max(0.5, brushRef.current.size / 2),
      };
      clearOverlay(interactionCanvasRef.current);
      const overlay = interactionCanvasRef.current;
      if (overlay) {
        overlay.style.opacity = brushRef.current.mode === 'add'
          ? String(Math.min(0.85, Math.max(0.3, displayRef.current.maskOpacity))) : '0.42';
      }
      drawTransientSegments([point], brushRef.current.mode, Math.max(0.5, brushRef.current.size / 2));
      drawBrushCursor();
      return;
    }

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const nodeHit = hitNode(point);
    if (nodeHit) {
      event.preventDefault();
      if (nodeHit.polygon.meta?.locked) {
        selectedNodeIdsRef.current.clear();
        selectedPolygonIdsRef.current = new Set([nodeHit.polygon.id]);
        notifySelection();
        render();
        onMessage('Polygon đang khóa. Mở khóa để chỉnh sửa điểm.');
        return;
      }
      if (!additive && !selectedNodeIdsRef.current.has(nodeHit.node.id)) selectedNodeIdsRef.current.clear();
      selectedNodeIdsRef.current.add(nodeHit.node.id);
      if (!additive) selectedPolygonIdsRef.current = new Set([nodeHit.polygon.id]);
      else selectedPolygonIdsRef.current.add(nodeHit.polygon.id);
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerRef.current = {
        id: event.pointerId,
        mode: 'nodes',
        start: point,
        original: polygonsRef.current,
        polygonIds: new Set(polygonsRef.current.filter((polygon) => polygonRings(polygon).some((ring) => ring.some((node) => selectedNodeIdsRef.current.has(node.id)))).map((polygon) => polygon.id)),
        nodeIds: new Set(selectedNodeIdsRef.current),
        moved: false,
      };
      notifySelection();
      render();
      return;
    }
    const polygonHit = hitPolygon(point);
    if (!additive) {
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueeRef.current = { start: point, end: point, additive };
    pointerRef.current = { id: event.pointerId, mode: 'marquee', start: point, additive, clickPolygonId: polygonHit?.id };
    notifySelection();
    render();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly) return;
    if (tool === 'polygon') {
      event.preventDefault();
      // Hai lần pointer-down của double click đã thêm cùng một đỉnh hai lần.
      // Giữ lần nhấp đầu làm đỉnh cuối và bỏ bản sao trước khi hoàn tất.
      draftRef.current.dropDoubleClickDuplicate();
      if (draftRef.current.nodes.length >= 3) completePolygon();
      else render();
      return;
    }
    if (tool !== 'select' || !readyRef.current) return;
    event.preventDefault();
    const point = imagePoint(event);
    const hitTolerance = 14 / viewRef.current.scale;
    let closest: { polygon: AnnotationPolygon; edgeIndex: number; ring: PolygonNode[]; point: ImagePoint; distance: number } | null = null;
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
    if (closest.polygon.meta?.locked) {
      onMessage('Polygon đang khóa. Mở khóa để thêm điểm.');
      return;
    }
    const edgeStart = closest.ring[closest.edgeIndex];
    const edgeEnd = closest.ring[(closest.edgeIndex + 1) % closest.ring.length];
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
        nodes: polygon.nodes === closest!.ring
          ? [...polygon.nodes.slice(0, closest!.edgeIndex + 1), insertedNode, ...polygon.nodes.slice(closest!.edgeIndex + 1)]
          : polygon.nodes,
        holes: polygon.holes?.map((ring) => ring === closest!.ring
          ? [...ring.slice(0, closest!.edgeIndex + 1), insertedNode, ...ring.slice(closest!.edgeIndex + 1)] : ring),
      }
      : polygon);
    commitPolygons(next);
    onMessage('Đã thêm node mới vào biên polygon.');
  };

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly) { event.preventDefault(); return; }
    event.preventDefault();
    if (!readyRef.current) return;
    const point = imagePoint(event);
    if (tool === 'polygon') {
      const hit = draftRef.current.nodes.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= 12 / viewRef.current.scale);
      if (hit) {
        draftRef.current.remove(hit.id);
        hoveredNodeRef.current = null;
        render();
      }
      return;
    }
    if (tool !== 'select') return;
    const nodeHit = hitNode(point);
    if (nodeHit) {
      if (nodeHit.polygon.meta?.locked) {
        onMessage('Polygon đang khóa. Mở khóa để xóa điểm.');
        return;
      }
      if (nodeHit.ring.length <= 3) {
        onMessage('Polygon cần ít nhất 3 điểm. Chọn polygon và nhấn Delete để xóa cả vùng.');
        return;
      }
      hoveredNodeRef.current = null;
      selectedNodeIdsRef.current.delete(nodeHit.node.id);
      commitPolygons(polygonsRef.current.map((polygon) => polygon.id === nodeHit.polygon.id
        ? { ...polygon, nodes: polygon.nodes.filter((node) => node.id !== nodeHit.node.id), holes: polygon.holes?.map((ring) => ring.filter((node) => node.id !== nodeHit.node.id)) } : polygon));
      return;
    }
    const polygon = hitPolygon(point);
    if (!polygon) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const nodeIds = additive ? new Set(selectedNodeIdsRef.current) : new Set<string>();
    const polygonIds = additive ? new Set(selectedPolygonIdsRef.current) : new Set<string>();
    if (!polygon.meta?.locked) {
      for (const node of polygonRings(polygon).flat()) nodeIds.add(node.id);
    }
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
      if (tool === 'brush') {
        latestBrushCursorRef.current = { clientX: event.clientX, clientY: event.clientY };
        scheduleBrushFrame();
        return;
      }
      const point = imagePoint(event);
      const hovered = tool === 'polygon'
        ? draftRef.current.nodes.find((node) => Math.hypot(node.x - point.x, node.y - point.y) <= 12 / viewRef.current.scale) ?? null
        : tool === 'select' ? hitNode(point)?.node ?? null : null;
      // Hover and the draft preview live on the stage: no outline redraw needed.
      if (hoveredNodeRef.current?.id !== hovered?.id) {
        hoveredNodeRef.current = hovered;
        scheduleFrame();
      }
      if (tool === 'polygon' && draftRef.current.nodes.length) {
        polygonHoverRef.current = imagePoint(event);
        renderDraft();
      }
      return;
    }
    if (active.id !== event.pointerId) return;
    event.preventDefault();
    if (active.mode === 'pan') {
      viewRef.current.x += event.clientX - active.lastClient.x;
      viewRef.current.y += event.clientY - active.lastClient.y;
      active.lastClient = { x: event.clientX, y: event.clientY };
      fittedRef.current = true;
      renderView();
      return;
    }
    if (active.mode === 'brush') {
      const samples = typeof event.nativeEvent.getCoalescedEvents === 'function'
        ? event.nativeEvent.getCoalescedEvents()
        : [event.nativeEvent];
      for (const sample of samples) {
        pendingBrushSamplesRef.current.push({ clientX: sample.clientX, clientY: sample.clientY });
      }
      latestBrushCursorRef.current = { clientX: event.clientX, clientY: event.clientY };
      scheduleBrushFrame();
      return;
    }
    const point = imagePoint(event);
    if (active.mode === 'nodes') {
      const deltaX = point.x - active.start.x;
      const deltaY = point.y - active.start.y;
      active.moved = active.moved || Math.hypot(deltaX, deltaY) > 0.5;
      const previous = polygonsRef.current;
      const wasPolygonMode = polygonModeRef.current;
      polygonsRef.current = active.original.map((polygon) => {
        if (polygon.meta?.locked) return polygon;
        if (!active.polygonIds.has(polygon.id)) return polygon;
        return {
          ...polygon,
          nodes: polygon.nodes.map((node) => active.nodeIds.has(node.id)
            ? { ...node, x: Math.max(0, Math.min(width, node.x + deltaX)), y: Math.max(0, Math.min(height, node.y + deltaY)) }
            : node),
          holes: polygon.holes?.map((ring) => ring.map((node) => active.nodeIds.has(node.id)
            ? { ...node, x: Math.max(0, Math.min(width, node.x + deltaX)), y: Math.max(0, Math.min(height, node.y + deltaY)) } : node)),
        };
      });
      polygonModeRef.current = true;
      // Dirty rectangle: only where the moved polygons were drawn last frame and are drawn now.
      const next = polygonsRef.current;
      let dirtyRect: PolygonBounds | null = null;
      if (wasPolygonMode && previous.length === next.length) {
        const scale = viewRef.current.scale;
        for (let index = 0; index < next.length; index += 1) {
          if (previous[index] === next[index]) continue;
          for (const extent of [vectorExtent(previous[index], scale), vectorExtent(next[index], scale)]) {
            dirtyRect = dirtyRect ? {
              left: Math.min(dirtyRect.left, extent.left), top: Math.min(dirtyRect.top, extent.top),
              right: Math.max(dirtyRect.right, extent.right), bottom: Math.max(dirtyRect.bottom, extent.bottom),
            } : extent;
          }
        }
      }
      if (dirtyRect) invalidateVectors(dirtyRect); else render();
      return;
    }
    if (active.mode === 'marquee') {
      marqueeRef.current = { start: active.start, end: point, additive: active.additive };
      renderDraft();
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
    if (pointerRef.current) return;
    if (brushCursorRef.current) {
      brushCursorRef.current = null;
      latestBrushCursorRef.current = null;
      drawBrushCursor();
    }
    if (polygonHoverRef.current) {
      polygonHoverRef.current = null;
      render();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.readOnly && pointerRef.current?.mode !== 'pan') { pointerRef.current = null; return; }
    const active = pointerRef.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.mode === 'brush') {
      if (brushFrameRef.current !== null) cancelAnimationFrame(brushFrameRef.current);
      flushBrushFrame();
    }
    pointerRef.current = null;
    if (active.mode === 'brush') {
      const stroke = brushStrokeRef.current;
      brushStrokeRef.current = [];
      if (event.type !== 'pointercancel' && stroke.length) {
        const point = imagePoint(event);
        const last = stroke[stroke.length - 1];
        const completedStroke = Math.hypot(point.x - last.x, point.y - last.y) > 0 ? [...stroke, point] : stroke;
        commitBrushStroke(completedStroke, active.brushMode, active.radius);
      }
      clearInteractionOnFrameRef.current = true;
      scheduleFrame();
      drawBrushCursor();
      return;
    }
    if (active.mode === 'nodes') {
      if (active.moved) {
        const moved = polygonsRef.current;
        polygonsRef.current = active.original;
        const before = { operations: [...operationsRef.current], polygons: active.original, vectorsCurrent: vectorsCurrent() };
        if (!commitPolygons(moved, before)) render();
      }
      return;
    }
    if (active.mode === 'marquee') {
      const marquee = marqueeRef.current;
      marqueeRef.current = null;
      if (marquee) {
        const clickTolerance = 3 / viewRef.current.scale;
        const isClick = Math.hypot(marquee.end.x - marquee.start.x, marquee.end.y - marquee.start.y) <= clickTolerance;
        if (isClick && active.clickPolygonId) {
          selectedNodeIdsRef.current.clear();
          selectedPolygonIdsRef.current = active.additive
            ? new Set([...selectedPolygonIdsRef.current, active.clickPolygonId])
            : new Set([active.clickPolygonId]);
          notifySelection();
          render();
          return;
        }
        const left = Math.min(marquee.start.x, marquee.end.x);
        const right = Math.max(marquee.start.x, marquee.end.x);
        const top = Math.min(marquee.start.y, marquee.end.y);
        const bottom = Math.max(marquee.start.y, marquee.end.y);
        const selected = marquee.additive ? new Set(selectedNodeIdsRef.current) : new Set<string>();
        const polygonIds = marquee.additive ? new Set(selectedPolygonIdsRef.current) : new Set<string>();
        for (const polygon of polygonsRef.current) {
          for (const node of polygonRings(polygon).flat()) {
            if (node.x >= left && node.x <= right && node.y >= top && node.y <= bottom) {
              if (!polygon.meta?.locked) selected.add(node.id);
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

  /**
   * Restores one side of a history entry. States whose polygons describe the mask are restored exactly
   * from those polygons; brush states only put back the pixels of the stroke rectangle.
   */
  const restoreDocument = useCallback((state: DocumentState, patch?: { bounds: BrushBounds; pixels: ImageData }) => {
    hoveredNodeRef.current = null;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current.clear();
    operationsRef.current = [...state.operations];
    brushOperationRef.current = state.operations.filter(isBrushOperation);
    humanActionRef.current = 'MODIFIED';
    maskRevisionRef.current += 1;
    if (state.vectorsCurrent || !patch) {
      polygonsRef.current = state.polygons;
      polygonModeRef.current = true;
      vectorRevisionRef.current = maskRevisionRef.current;
      vectorStatusRef.current = 'READY';
      vectorCacheRef.current = { revision: maskRevisionRef.current, status: 'READY', polygons: state.polygons };
      rebuildPolygonTint(state.polygons);
    } else {
      ensureMaskRaster();
      const maskContext = maskRef.current?.getContext('2d', { willReadFrequently: true });
      const tintContext = tintRef.current?.getContext('2d');
      if (!maskContext || !tintContext) return;
      const { bounds, pixels } = patch;
      maskContext.putImageData(pixels, bounds.left, bounds.top);
      const colored = tintContext.createImageData(pixels.width, pixels.height);
      for (let offset = 0; offset < colored.data.length; offset += 4) {
        colored.data[offset] = 124; colored.data[offset + 1] = 92; colored.data[offset + 2] = 250;
        colored.data[offset + 3] = pixels.data[offset + 3];
      }
      tintContext.putImageData(colored, bounds.left, bounds.top);
      const lockedMask = lockedMaskRef.current;
      if (lockedMask && lockedPixelsRef.current) {
        tintContext.drawImage(
          lockedMask,
          bounds.left, bounds.top, pixels.width, pixels.height,
          bounds.left, bounds.top, pixels.width, pixels.height,
        );
      }
      if (workerSyncedRef.current) {
        const copy = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
        brushWorkerRef.current?.postMessage(
          { type: 'PUT_PATCH', revision: maskRevisionRef.current, bounds, pixels: copy } satisfies MaskWorkerRequest,
          [copy.data.buffer],
        );
      }
      vectorStatusRef.current = 'DIRTY';
      vectorCacheRef.current.status = 'DIRTY';
      polygonModeRef.current = false;
      if (toolRef.current === 'brush') scheduleBackgroundVectorize(); else scheduleVectorizationRef.current();
      invalidateMask(bounds);
    }
    render();
    notifyChange('MODIFIED');
    notifySelection();
  }, [ensureMaskRaster, invalidateMask, notifyChange, notifySelection, rebuildPolygonTint, render, scheduleBackgroundVectorize]);

  const undo = useCallback(() => {
    if (pointerRef.current) return;
    // Placing a new polygon: step back through its points only (one point per undo). Once every point
    // was undone, the draft is left and undo continues with the global history.
    const draftStep = draftRef.current.undo();
    if (draftStep === 'draft') {
      hoveredNodeRef.current = null;
      render();
      return;
    }
    if (draftStep === 'blocked') return;
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
    const entry = historyUndoRef.current.pop();
    if (!entry) { render(); return; }
    historyRedoRef.current.push(entry);
    restoreDocument(entry.before, entry.kind === 'brush' ? { bounds: entry.bounds, pixels: entry.beforePixels } : undefined);
  }, [notifyChange, render, restoreDocument, tool]);

  const redo = useCallback(() => {
    if (pointerRef.current) return;
    const draftStep = draftRef.current.redo();
    if (draftStep === 'draft') {
      hoveredNodeRef.current = null;
      render();
      return;
    }
    if (draftStep === 'blocked') return;
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
    const entry = historyRedoRef.current.pop();
    if (!entry) return;
    historyUndoRef.current.push(entry);
    restoreDocument(entry.after, entry.kind === 'brush' ? { bounds: entry.bounds, pixels: entry.afterPixels } : undefined);
  }, [notifyChange, render, restoreDocument, tool]);

  const beginPolygonEdit = useCallback(() => {
    if (vectorRevisionRef.current === maskRevisionRef.current) {
      polygonModeRef.current = true;
      invalidateMask();
      render();
      return polygonsRef.current.length;
    }
    polygonModeRef.current = false;
    scheduleVectorizationRef.current(0);
    onMessage('Đang chuẩn bị biên polygon… Mask raster vẫn hiển thị trong lúc chờ.');
    invalidateMask();
    render();
    return 0;
  }, [invalidateMask, onMessage, render]);

  const selectPolygon = useCallback((polygonId: string) => {
    if (!polygonsRef.current.some((polygon) => polygon.id === polygonId)) return;
    selectedNodeIdsRef.current.clear();
    selectedPolygonIdsRef.current = new Set([polygonId]);
    notifySelection();
    render();
  }, [notifySelection, render]);

  const toggleSelectedPolygonLock = useCallback(() => {
    if (selectedPolygonIdsRef.current.size !== 1) {
      onMessage('Hãy chọn đúng một polygon để khóa hoặc mở khóa.');
      return false;
    }
    const selectedId = [...selectedPolygonIdsRef.current][0];
    const selected = polygonsRef.current.find((polygon) => polygon.id === selectedId);
    if (!selected) return false;
    const locked = !selected.meta?.locked;
    const next = polygonsRef.current.map((polygon) => polygon.id === selectedId
      ? { ...polygon, meta: { ...polygon.meta, locked, source: 'human' as const } }
      : polygon);
    selectedNodeIdsRef.current.clear();
    commitPolygons(next);
    onMessage(locked ? `Đã khóa polygon ${selected.label}.` : `Đã mở khóa polygon ${selected.label}.`);
    return true;
  }, [commitPolygons, onMessage]);

  const updateSelectedPolygonLabel = useCallback((label: string, kind: PolygonLabelKind) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel || !selectedPolygonIdsRef.current.size) {
      onMessage('Hãy chọn polygon và nhập label hợp lệ.');
      return false;
    }
    if (polygonsRef.current.some((polygon) => selectedPolygonIdsRef.current.has(polygon.id) && polygon.meta?.locked)) {
      onMessage('Polygon \u0111ang kh\u00f3a. M\u1edf kh\u00f3a \u0111\u1ec3 \u0111\u1ed5i label.');
      return false;
    }
    const next = polygonsRef.current.map((polygon) => (
      selectedPolygonIdsRef.current.has(polygon.id)
        ? {
          ...polygon,
          label: normalizedLabel,
          meta: { ...polygon.meta, semantic: semanticForLabelKind(kind), source: 'human' as const },
        }
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
    if (selected.some((polygon) => polygon.meta?.locked)) {
      onMessage('Hãy mở khóa các polygon trước khi gộp.');
      return false;
    }
    if (polygonsRef.current.some((polygon) => selectedPolygonIdsRef.current.has(polygon.id) && polygon.meta?.locked)) {
      onMessage('Polygon đang khóa. Mở khóa để đổi label.');
      return false;
    }
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

  const smoothSelectedPolygons = useCallback(() => {
    const selectedIds = selectedPolygonIdsRef.current;
    if (!selectedIds.size) {
      onMessage('Hãy chọn polygon cần làm mịn.');
      return false;
    }
    let count = 0;
    const next = polygonsRef.current.map((polygon) => {
      if (!selectedIds.has(polygon.id) || polygon.meta?.locked) return polygon;
      const smoothed = smoothPolygon(polygon, { width, height });
      if (smoothed !== polygon) count += 1;
      return smoothed;
    });
    if (!count) {
      onMessage('Polygon đã chọn quá nhỏ hoặc đang khóa nên không làm mịn.');
      return false;
    }
    selectedNodeIdsRef.current.clear();
    commitPolygons(next);
    onMessage(`Đã làm mịn biên ${count} polygon.`);
    return true;
  }, [commitPolygons, height, onMessage, width]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (props.readOnly) return;
      const target = event.target;
      if (target instanceof HTMLElement
          && target.matches('input, select, textarea, [contenteditable="true"]')) return;
      const labelKind = event.key === '1' ? 'wart' : event.key === '2' ? 'ridge' : null;
      if (labelKind && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && tool === 'select') {
        event.preventDefault();
        updateSelectedPolygonLabel(nextLabel(polygonsRef.current, labelKind), labelKind);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'select') {
        event.preventDefault();
        deleteSelection();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && tool === 'point') {
        event.preventDefault();
        deleteSelectedPoint();
      } else if (event.key === 'Enter' && tool === 'polygon') {
        event.preventDefault();
        completePolygon();
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
  }, [cancelCurrentPath, completePolygon, deleteSelectedPoint, deleteSelection, props.readOnly, redo, tool, undo, updateSelectedPolygonLabel]);

  const zoomAt = useCallback((factor: number, anchor: ImagePoint) => {
    viewRef.current = zoomViewAt(viewRef.current, factor, anchor);
    fittedRef.current = true;
    onZoomChange?.(viewRef.current.scale);
    renderView();
  }, [onZoomChange, renderView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      if (event.shiftKey) {
        viewRef.current.x -= (event.deltaY || event.deltaX) * unit;
        renderView();
        return;
      }
      zoomAt(Math.exp(-event.deltaY * unit * 0.001), {
        x: event.clientX - rect.left, y: event.clientY - rect.top,
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [renderView, zoomAt]);

  useImperativeHandle(ref, () => ({
    // Before saving brush edits, vectorize once so the saved POLYGON_SET matches what was drawn
    // (see currentOperations). A failed or slow worker falls back to saving the raw operations.
    flushPendingEdits: async () => {
      flushNotify();
      const last = operationsRef.current.at(-1);
      if ((last?.type === 'BRUSH_ADD' || last?.type === 'BRUSH_ERASE') && vectorRevisionRef.current !== maskRevisionRef.current) {
        let timer = 0;
        await Promise.race([
          requestLatestVector(),
          new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 15_000); }),
        ]);
        window.clearTimeout(timer);
      }
      // Polygons adopted while still in the brush tool were not announced yet.
      if (pendingVectorNotifyRef.current) {
        pendingVectorNotifyRef.current = false;
        notifyChange('MODIFIED', polygonsRef.current);
      }
    },
    exportMask: async () => {
      if (!maskRef.current) throw new Error('Mask chưa sẵn sàng.');
      ensureMaskRaster();
      return toBlob(maskRef.current);
    },
    resetToPrediction: () => {
      if (props.readOnly) return;
      const prediction = ensurePrediction();
      const mask = maskRef.current;
      const tint = tintRef.current;
      if (!prediction || !mask || !tint) return;
      const context = mask.getContext('2d');
      pendingMaskPolygonsRef.current = null;
      context?.clearRect(0, 0, width, height);
      context?.drawImage(prediction, 0, 0);
      rebuildTint(mask, tint, POLYGON_FILL);
      invalidateMask();
      cancelCurrentPath();
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      maskRevisionRef.current += 1;
      vectorRevisionRef.current = -1;
      vectorStatusRef.current = 'DIRTY';
      vectorCacheRef.current = { revision: -1, status: 'DIRTY', polygons: [] };
      polygonsRef.current = [];
      lockedMaskRef.current?.getContext('2d')?.clearRect(0, 0, width, height);
      lockedPixelsRef.current = false;
      polygonModeRef.current = false;
      operationsRef.current = [{ type: 'RESET_TO_PREDICTION' }];
      brushOperationRef.current = [];
      // Earlier stroke patches no longer apply to the replaced raster.
      historyUndoRef.current = [];
      historyRedoRef.current = [];
      humanActionRef.current = 'MODIFIED';
      workerSyncedRef.current = false;
      render();
      notifyChange('MODIFIED', []);
      notifySelection();
      onMessage('Đã khôi phục mask ban đầu.');
    },
    acceptPrediction: () => {
      if (props.readOnly) return;
      const mask = maskRef.current;
      const prediction = ensurePrediction();
      if (mask && prediction) {
        const context = mask.getContext('2d');
        pendingMaskPolygonsRef.current = null;
        context?.clearRect(0, 0, width, height);
        context?.drawImage(prediction, 0, 0);
        if (tintRef.current) rebuildTint(mask, tintRef.current, POLYGON_FILL);
        invalidateMask();
      }
      cancelCurrentPath();
      polygonsRef.current = [];
      lockedMaskRef.current?.getContext('2d')?.clearRect(0, 0, width, height);
      lockedPixelsRef.current = false;
      polygonModeRef.current = false;
      maskRevisionRef.current += 1;
      vectorRevisionRef.current = -1;
      vectorStatusRef.current = 'DIRTY';
      vectorCacheRef.current = { revision: -1, status: 'DIRTY', polygons: [] };
      operationsRef.current = [{ type: 'RESET_TO_PREDICTION' }];
      brushOperationRef.current = [];
      historyUndoRef.current = [];
      historyRedoRef.current = [];
      selectedNodeIdsRef.current.clear();
      selectedPolygonIdsRef.current.clear();
      humanActionRef.current = 'ACCEPTED';
      workerSyncedRef.current = false;
      render();
      notifyChange('ACCEPTED', []);
      notifySelection();
    },
    undo: () => { if (!props.readOnly) undo(); },
    redo: () => { if (!props.readOnly) redo(); },
    deleteSelectedPoint: () => { if (!props.readOnly) deleteSelectedPoint(); },
    deleteSelection: () => { if (!props.readOnly) deleteSelection(); },
    completePolygon: () => !props.readOnly && completePolygon(),
    cancelCurrentPath,
    beginPolygonEdit: () => props.readOnly ? 0 : beginPolygonEdit(),
    selectPolygon,
    toggleSelectedPolygonLock: () => !props.readOnly && toggleSelectedPolygonLock(),
    updateSelectedPolygonLabel: (label, kind) => !props.readOnly && updateSelectedPolygonLabel(label, kind),
    groupSelectedPolygons: () => !props.readOnly && groupSelectedPolygons(),
    smoothSelectedPolygons: () => !props.readOnly && smoothSelectedPolygons(),
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
      const stage = stageRef.current;
      if (stage) zoomAt(factor, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
    },
  }), [beginPolygonEdit, cancelCurrentPath, completePolygon, deleteSelectedPoint, deleteSelection, ensureMaskRaster, ensurePrediction, fit, flushNotify, groupSelectedPolygons, height, invalidateMask, notifyChange, notifySelection, onMessage, props.readOnly, rebuildTint, redo, render, requestLatestVector, selectPolygon, smoothSelectedPolygons, toggleSelectedPolygonLock, undo, updateSelectedPolygonLabel, width, zoomAt]);

  return (
    <div className={`canvas-viewport tool-${tool}`} ref={viewportRef}>
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
        />
        <canvas ref={maskLayerRef} className="raster-mask-layer" aria-hidden="true" />
        <canvas ref={vectorLayerRef} className="vector-layer" aria-hidden="true" />
        <canvas ref={draftLayerRef} className="draft-layer" aria-hidden="true" />
        <canvas ref={interactionCanvasRef} className="brush-interaction-layer" aria-hidden="true" />
        <canvas ref={cursorCanvasRef} className="brush-cursor-layer" aria-hidden="true" />
      </div>
    </div>
  );
});

export default EditorCanvas;
