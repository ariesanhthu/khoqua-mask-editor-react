import type { BrushOperation } from '../types/index';
import { forEachPolygonSpan, MaskVectorizer, type PixelBounds } from './mask-pixels';
import { packedTransfer, packPolygons, unpackGeometry, type PackedGeometry, type PackedPolygons } from './polygon-pack';

export type MaskWorkerRequest =
  | { type: 'INIT_MASK'; revision: number; width: number; height: number; imageData: ImageData }
  // The main thread knows the mask as polygons (POLYGON_SET): rasterize them here with the same
  // pixel-center rule instead of reading and transferring the whole raster on the main thread.
  | { type: 'INIT_POLYGONS'; revision: number; width: number; height: number; geometry: PackedGeometry }
  | { type: 'APPLY_STROKE'; operation: BrushOperation }
  | { type: 'PUT_PATCH'; revision: number; bounds: PixelBounds; pixels: ImageData }
  // send=false: re-trace in the background (while the user keeps drawing) without posting anything back.
  | { type: 'VECTORIZE'; revision: number; send: boolean };

export type MaskWorkerResponse =
  | { type: 'MASK_READY'; revision: number }
  | { type: 'STROKE_APPLIED'; revision: number }
  // Delta against the components sent last time; full=true replaces everything (after INIT_*).
  // `added` is packed into transferable typed arrays (see polygon-pack.ts).
  | { type: 'VECTOR_RESULT'; revision: number; full: boolean; removed: string[]; added: PackedPolygons; duration: number }
  | { type: 'ERROR'; revision: number; message: string };

let context: OffscreenCanvasRenderingContext2D | null = null;
let vectorizer: MaskVectorizer | null = null;
let currentMaskRevision = 0;
let generation = 0;
/** Polygon ids the main thread already holds; null forces a full result. */
let sentIds: Set<string> | null = null;

/** Copies only the changed rectangle into the binary buffer and marks it dirty. */
function readRegion(bounds: PixelBounds) {
  if (!context || !vectorizer) return;
  const { width, height, pixels } = vectorizer;
  const left = Math.max(0, Math.floor(bounds.left)); const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(width, Math.ceil(bounds.right)); const bottom = Math.min(height, Math.ceil(bounds.bottom));
  if (right <= left || bottom <= top) return;
  const regionWidth = right - left;
  const rgba = context.getImageData(left, top, regionWidth, bottom - top).data;
  for (let y = top; y < bottom; y += 1) {
    const source = (y - top) * regionWidth;
    const target = y * width + left;
    for (let x = 0; x < regionWidth; x += 1) pixels[target + x] = rgba[(source + x) * 4 + 3] >= 128 ? 255 : 0;
  }
  vectorizer.markDirty({ left, top, right, bottom });
}

function drawStroke(operation: BrushOperation) {
  if (!context || !operation.points.length) return;
  context.save();
  context.globalCompositeOperation = operation.type === 'BRUSH_ERASE' ? 'destination-out' : 'source-over';
  context.fillStyle = '#fff';
  context.strokeStyle = '#fff';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = operation.radius * 2;
  context.beginPath();
  if (operation.points.length === 1) {
    context.arc(operation.points[0].x, operation.points[0].y, operation.radius, 0, Math.PI * 2);
    context.fill();
  } else {
    for (let index = 0; index < operation.points.length; index += 1) {
      const point = operation.points[index];
      if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
    }
    context.stroke();
  }
  context.restore();
}

self.onmessage = (event: MessageEvent<MaskWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'INIT_MASK') {
      const canvas = new OffscreenCanvas(request.width, request.height);
      context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('OffscreenCanvas 2D is unavailable.');
      context.putImageData(request.imageData, 0, 0);
      vectorizer = new MaskVectorizer(request.width, request.height);
      generation += 1;
      sentIds = null;
      readRegion({ left: 0, top: 0, right: request.width, bottom: request.height });
      vectorizer.markAllDirty();
      currentMaskRevision = request.revision;
      self.postMessage({ type: 'MASK_READY', revision: currentMaskRevision } satisfies MaskWorkerResponse);
      return;
    }
    if (request.type === 'INIT_POLYGONS') {
      const { width, height } = request;
      const canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('OffscreenCanvas 2D is unavailable.');
      vectorizer = new MaskVectorizer(width, height);
      const { pixels } = vectorizer;
      forEachPolygonSpan(unpackGeometry(request.geometry), { left: 0, top: 0, right: width, bottom: height }, (y, start, end) => {
        pixels.fill(255, y * width + start, y * width + end);
      });
      // Keep the canvas in step with the binary buffer for APPLY_STROKE (PUT_PATCH overwrites its rectangle).
      const image = context.createImageData(width, height);
      const words = new Uint32Array(image.data.buffer);
      for (let index = 0; index < pixels.length; index += 1) if (pixels[index]) words[index] = 0xffffffff;
      context.putImageData(image, 0, 0);
      generation += 1;
      sentIds = null;
      vectorizer.markAllDirty();
      currentMaskRevision = request.revision;
      self.postMessage({ type: 'MASK_READY', revision: currentMaskRevision } satisfies MaskWorkerResponse);
      return;
    }
    if (request.type === 'APPLY_STROKE') {
      if (!context) throw new Error('Worker mask is not initialized.');
      drawStroke(request.operation);
      const { bounds } = request.operation;
      readRegion({ left: bounds.left - 1, top: bounds.top - 1, right: bounds.right + 1, bottom: bounds.bottom + 1 });
      currentMaskRevision = request.operation.revision;
      self.postMessage({ type: 'STROKE_APPLIED', revision: currentMaskRevision } satisfies MaskWorkerResponse);
      return;
    }
    if (request.type === 'PUT_PATCH') {
      if (!context) throw new Error('Worker mask is not initialized.');
      context.putImageData(request.pixels, request.bounds.left, request.bounds.top);
      readRegion(request.bounds);
      currentMaskRevision = request.revision;
      self.postMessage({ type: 'STROKE_APPLIED', revision: currentMaskRevision } satisfies MaskWorkerResponse);
      return;
    }
    if (!vectorizer || request.revision !== currentMaskRevision) {
      if (!request.send) return; // A stale background pass is simply skipped.
      throw new Error(`Cannot vectorize revision ${request.revision}; worker is at ${currentMaskRevision}.`);
    }
    const started = performance.now();
    // Incremental: only components touching edits since the last pass are traced again.
    const polygons = vectorizer.vectorize(`mask-g${generation}-r${request.revision}`);
    if (!request.send) return;
    const ids = new Set(polygons.map((polygon) => polygon.id));
    const previous = sentIds;
    sentIds = ids;
    const added = packPolygons(previous ? polygons.filter((polygon) => !previous.has(polygon.id)) : polygons);
    self.postMessage({
      type: 'VECTOR_RESULT', revision: request.revision, full: !previous,
      removed: previous ? [...previous].filter((id) => !ids.has(id)) : [],
      added,
      duration: performance.now() - started,
    } satisfies MaskWorkerResponse, { transfer: packedTransfer(added) });
  } catch (error) {
    self.postMessage({
      type: 'ERROR', revision: currentMaskRevision, message: (error as Error).message,
    } satisfies MaskWorkerResponse);
  }
};
