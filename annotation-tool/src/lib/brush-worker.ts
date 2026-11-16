import { MaskVectorizer, type PixelBounds } from './mask-pixels';
import { packedTransfer, packPolygons, type PackedPolygons } from './polygon-pack';

/**
 * Worker chuyển mask CHỈ CÓ RASTER sang polygon một lần (mask dự đoán PNG, "Khôi phục mask ban đầu", annotation cũ
 * lưu bằng nét brush). Từ 2026-11-12 Paint sửa thẳng trên polygon (polygon-paint.ts) nên không còn gửi nét tô
 * hay vùng pixel thay đổi tới đây (người dùng xác nhận: bỏ chuyển pixel → polygon trong Paint).
 */
export type MaskWorkerRequest =
  | { type: 'INIT_MASK'; revision: number; width: number; height: number; imageData: ImageData }
  // send=false: re-trace without posting anything back.
  | { type: 'VECTORIZE'; revision: number; send: boolean };

export type MaskWorkerResponse =
  | { type: 'MASK_READY'; revision: number }
  // Delta against the components sent last time; full=true replaces everything (after INIT_MASK).
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
