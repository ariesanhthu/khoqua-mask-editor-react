import type { AnnotationPolygon, PolygonNode } from '../types/index';
import { vectorizeBinaryMask } from './mask-pixels';

/**
 * Đọc COCO 1.0 (định dạng instances của CVAT/pycocotools) ở trình duyệt và đổi từng ảnh thành
 * prelabel `bitter-melon-prelabel-1.1` mà editor vốn đã mở được. File COCO của cả bộ dữ liệu có thể
 * vài chục MB, vượt giới hạn request của máy chủ, nên chỉ gửi kết quả của từng ảnh lên server.
 */

export interface CocoImage { id: number | string; file_name: string; width: number; height: number }
export interface CocoCategory { id: number | string; name: string; supercategory?: string }
export interface CocoRle { counts: number[] | string; size: [number, number] }
export interface CocoAnnotation {
  id?: number | string;
  image_id: number | string;
  category_id: number | string;
  segmentation?: number[][] | CocoRle;
  iscrowd?: number;
  attributes?: Record<string, unknown>;
}
export interface CocoDataset { images: CocoImage[]; annotations: CocoAnnotation[]; categories: CocoCategory[] }

/** `r` = vết gợn (`r*`, main_flesh_band), `w` = u vấu (`w*`, wart_flesh), `skip` = không nhập. */
export type CategoryTarget = 'r' | 'w' | 'skip';

export function isCocoDataset(value: unknown): value is CocoDataset {
  const dataset = value as Partial<CocoDataset> | null;
  return Boolean(dataset && typeof dataset === 'object'
    && Array.isArray(dataset.images) && Array.isArray(dataset.annotations) && Array.isArray(dataset.categories));
}

/** Gợi ý ánh xạ theo tên danh mục; admin luôn xem và sửa được trước khi nhập. */
export function guessCategoryTarget(name: string): CategoryTarget {
  const plain = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (/wart|u ?vau|^w\d*$/.test(plain)) return 'w';
  if (/main_flesh|flesh_band|flesh|ridge|vet ?gon|^r\d*$/.test(plain)) return 'r';
  return 'skip';
}

/** Chuỗi counts nén của pycocotools (rleFrString): 5 bit mỗi ký tự, từ count thứ 4 lưu chênh lệch. */
function decodeRleString(text: string): number[] {
  const counts: number[] = [];
  let position = 0;
  while (position < text.length) {
    let value = 0;
    let chunk = 0;
    let more = true;
    while (more) {
      if (position >= text.length) throw new Error('RLE COCO bị cắt cụt.');
      const code = text.charCodeAt(position) - 48;
      if (code < 0 || code > 63) throw new Error('RLE COCO chứa ký tự không hợp lệ.');
      value += (code & 0x1f) * 2 ** (5 * chunk);
      more = (code & 0x20) !== 0;
      position += 1;
      chunk += 1;
      // Bit dấu của nhóm 5 bit cuối: giá trị âm theo bù hai trên 5·chunk bit.
      if (!more && (code & 0x10)) value -= 2 ** (5 * chunk);
    }
    if (counts.length > 2) value += counts[counts.length - 2];
    counts.push(value);
  }
  return counts;
}

/** RLE COCO (mảng hoặc chuỗi nén) → điểm ảnh 0/255 theo hàng. COCO đếm theo cột, bắt đầu bằng nền. */
export function decodeCocoRle(rle: CocoRle, width: number, height: number): Uint8Array {
  if (!Array.isArray(rle.size) || rle.size[0] !== height || rle.size[1] !== width) {
    throw new Error('Kích thước RLE không khớp ảnh.');
  }
  const counts = typeof rle.counts === 'string' ? decodeRleString(rle.counts) : rle.counts;
  if (!Array.isArray(counts)) throw new Error('RLE COCO thiếu counts.');
  const total = width * height;
  const pixels = new Uint8Array(total);
  let index = 0;
  let foreground = false;
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0 || index + count > total) throw new Error('RLE COCO không hợp lệ.');
    if (foreground) {
      for (let cursor = index; cursor < index + count; cursor += 1) {
        pixels[(cursor % height) * width + Math.floor(cursor / height)] = 255;
      }
    }
    index += count;
    foreground = !foreground;
  }
  return pixels;
}

const ringArea = (ring: Array<{ x: number; y: number }>) => ring.reduce((sum, point, index) => {
  const next = ring[(index + 1) % ring.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;

/** Polygon COCO `[x1, y1, x2, y2, …]` → ring hợp lệ; tọa độ lệch ra ngoài ảnh được kẹp về biên. */
function cocoRing(values: unknown, width: number, height: number): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(values) || values.length < 6 || values.length % 2 !== 0) return null;
  const ring: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < values.length; index += 2) {
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const point = { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
    const last = ring.at(-1);
    if (!last || last.x !== point.x || last.y !== point.y) ring.push(point);
  }
  if (ring.length > 1 && ring[0].x === ring.at(-1)!.x && ring[0].y === ring.at(-1)!.y) ring.pop();
  return ring.length >= 3 && Math.abs(ringArea(ring)) > 0 ? ring : null;
}

export interface CocoConversion {
  polygons: AnnotationPolygon[];
  /** Annotation thuộc danh mục bị bỏ qua. */
  skipped: number;
  /** Annotation không đọc được hình học (polygon suy biến, RLE lỗi…). */
  invalid: number;
}

/**
 * Annotation COCO của một ảnh → polygon editor. Mỗi annotation là một instance: mọi mảnh của nó dùng
 * chung label `r<n>`/`w<n>`. Label `attributes.label` hợp lệ (bản xuất COCO của chính tool) được giữ;
 * annotation còn lại nhận số tiếp theo chưa dùng. RLE được vector hóa chính xác theo pixel, giữ lỗ.
 */
export function cocoImagePolygons(
  annotations: CocoAnnotation[],
  targets: ReadonlyMap<string, CategoryTarget>,
  width: number,
  height: number,
): CocoConversion {
  const used = { r: new Set<number>(), w: new Set<number>() };
  const accepted: Array<{ annotation: CocoAnnotation; target: 'r' | 'w'; explicit?: number }> = [];
  let skipped = 0;
  for (const annotation of annotations) {
    const target = targets.get(String(annotation.category_id)) ?? 'skip';
    if (target === 'skip') { skipped += 1; continue; }
    const label = annotation.attributes?.label;
    const explicit = typeof label === 'string' && new RegExp(`^${target}([1-9]\\d*)$`).exec(label);
    if (explicit) used[target].add(Number(explicit[1]));
    accepted.push({ annotation, target, explicit: explicit ? Number(explicit[1]) : undefined });
  }

  const next = { r: 1, w: 1 };
  const ids = new Set<string>();
  const polygons: AnnotationPolygon[] = [];
  let invalid = 0;
  accepted.forEach(({ annotation, target, explicit }, index) => {
    let number = explicit;
    if (number === undefined) {
      while (used[target].has(next[target])) next[target] += 1;
      number = next[target];
      used[target].add(number);
    }
    const label = `${target}${number}`;
    const meta = target === 'r'
      ? { semantic: 'main_flesh_band', mainGroupId: number }
      : { semantic: 'wart_flesh', wartId: number };
    let base = `coco-${annotation.id ?? `a${index}`}`;
    if (ids.has(base)) base = `${base}-${index}`;
    ids.add(base);

    const parts: AnnotationPolygon[] = [];
    const segmentation = annotation.segmentation;
    try {
      if (Array.isArray(segmentation)) {
        segmentation.forEach((values, part) => {
          const ring = cocoRing(values, width, height);
          if (!ring) return;
          const id = `${base}-${part}`;
          parts.push({ id, label, nodes: ring.map((point, node): PolygonNode => ({ id: `${id}-n${node}`, ...point })), meta });
        });
      } else if (segmentation && typeof segmentation === 'object') {
        const pixels = decodeCocoRle(segmentation, width, height);
        parts.push(...vectorizeBinaryMask(pixels, width, height, base).map((polygon) => ({ ...polygon, label, meta })));
      }
    } catch {
      parts.length = 0;
    }
    if (parts.length) polygons.push(...parts);
    else invalid += 1;
  });
  return { polygons, skipped, invalid };
}

/** Tài liệu prelabel đúng schema editor đọc (`prelabel-service.loadPrelabelOperations`). */
export function buildPrelabelDocument(imageId: string, width: number, height: number, polygons: AnnotationPolygon[]) {
  return {
    schemaVersion: 'bitter-melon-prelabel-1.1',
    imageId,
    coordinateSpace: 'image_pixels',
    width,
    height,
    maskOperations: [{ type: 'POLYGON_SET', polygons }],
  };
}

/** Annotation theo ảnh, giữ thứ tự trong file COCO. */
export function annotationsByImage(dataset: CocoDataset): Map<string, CocoAnnotation[]> {
  const byImage = new Map<string, CocoAnnotation[]>();
  for (const annotation of dataset.annotations) {
    const key = String(annotation.image_id);
    const list = byImage.get(key);
    if (list) list.push(annotation); else byImage.set(key, [annotation]);
  }
  return byImage;
}
