import { isCocoDataset, type CocoDataset } from './coco-import';
import { groupFromRelativePath, inferGroupName, isValidExternalKey, isValidGroupName, normalizeGroupName } from './file-groups';

/**
 * Lập kế hoạch nhập một thư mục admin chọn trên trình duyệt (`<input webkitdirectory>`), trước khi
 * gửi gì lên máy chủ. Hai định dạng:
 * - `default`: định dạng có sẵn của hệ thống — `manifest.json` với `items[{ id, image, prediction, prelabel? }]`.
 * - `coco`: COCO 1.0 — `annotations/*.json` (images/annotations/categories) và thư mục ảnh.
 * Mỗi thư mục con (mỗi giống) thành một nhóm, xem `groupFromRelativePath`.
 */

export type ImportFormat = 'default' | 'coco';
/** `folder`: nhóm theo thư mục con; `prefix`: nhóm theo tiền tố tên ảnh (`8582_01` → `8582`). */
export type GroupingMode = 'folder' | 'prefix';

export interface ImportEntry<F> {
  /** Đường dẫn trình duyệt cung cấp (`webkitRelativePath`), bắt đầu bằng tên thư mục gốc. */
  path: string;
  file: F;
}

export interface ParsedJsonFile {
  path: string;
  value: unknown;
}

export interface PlannedItem<F> {
  externalKey: string;
  group: string;
  /** Đường dẫn ảnh tính từ thư mục gốc. */
  imagePath: string;
  image: F;
  prediction?: F;
  prelabel?: F;
  coco?: { setIndex: number; imageId: string; width: number; height: number };
}

export interface ImportPlan<F> {
  rootName: string;
  items: PlannedItem<F>[];
  warnings: string[];
  cocoSets: CocoDataset[];
}

const IMAGE_EXTENSION = /\.(jpe?g|png|webp)$/i;

function splitRoot(fullPath: string): { root: string; rest: string } {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 1 ? { root: parts[0], rest: parts.slice(1).join('/') } : { root: '', rest: parts.join('/') };
}

function dirname(value: string): string {
  const index = value.lastIndexOf('/');
  return index < 0 ? '' : value.slice(0, index);
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function stem(value: string): string {
  const name = basename(value);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Ghép đường dẫn tương đối, chặn `..` và đường dẫn tuyệt đối. */
function joinRelative(base: string, relative: string): string | null {
  const cleaned = relative.replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-z]+:/i.test(cleaned)) return null;
  const parts = [...base.split('/'), ...cleaned.split('/')].filter((part) => part && part !== '.');
  return parts.includes('..') ? null : parts.join('/');
}

/** Thư mục gốc (tên đầu tiên của đường dẫn) và chỉ mục tệp theo đường dẫn tương đối. */
export function indexEntries<F>(entries: ImportEntry<F>[]) {
  let rootName = '';
  const byPath = new Map<string, ImportEntry<F>>();
  const byLowerPath = new Map<string, ImportEntry<F>>();
  for (const entry of entries) {
    const { root, rest } = splitRoot(entry.path);
    if (!rootName && root) rootName = root;
    byPath.set(rest, entry);
    byLowerPath.set(rest.toLowerCase(), entry);
  }
  const find = (relative: string | null) => (relative === null ? undefined : byPath.get(relative) ?? byLowerPath.get(relative.toLowerCase()));
  return { rootName: rootName || 'Thư mục tải lên', byPath, find };
}

/** Đường dẫn tương đối (bỏ tên thư mục gốc) của một entry. */
export function relativeEntryPath(fullPath: string): string {
  return splitRoot(fullPath).rest;
}

/** JSON cần đọc để lập kế hoạch: tránh đọc hàng trăm prelabel JSON khi chỉ cần manifest/COCO. */
export function isPlanJsonCandidate(fullPath: string, format: ImportFormat): boolean {
  const rest = splitRoot(fullPath).rest;
  const name = basename(rest).toLowerCase();
  if (!name.endsWith('.json')) return false;
  if (format === 'default') return name === 'manifest.json';
  return rest.toLowerCase().split('/').includes('annotations')
    || /^(instances.*|.*coco.*|annotations?)\.json$/.test(name);
}

function groupName(imagePath: string, externalKey: string, rootName: string, grouping: GroupingMode, explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit.trim()) return normalizeGroupName(explicit);
  if (grouping === 'prefix') return normalizeGroupName(inferGroupName(externalKey) ?? rootName);
  return normalizeGroupName(groupFromRelativePath(imagePath, rootName));
}

/** Khóa trùng giữa các nhóm (vd. hai giống cùng có `01.jpg`) được thêm tiền tố nhóm; trùng hẳn thì bỏ. */
function finalize<F>(rootName: string, items: PlannedItem<F>[], warnings: string[], cocoSets: CocoDataset[]): ImportPlan<F> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.externalKey, (counts.get(item.externalKey) ?? 0) + 1);
  const seen = new Set<string>();
  const result: PlannedItem<F>[] = [];
  for (const item of items) {
    let key = item.externalKey;
    if ((counts.get(key) ?? 0) > 1) key = `${item.group}_${key}`;
    if (!isValidExternalKey(key)) { warnings.push(`Bỏ qua ${item.imagePath}: tên ảnh "${key}" không hợp lệ.`); continue; }
    if (!isValidGroupName(item.group)) { warnings.push(`Bỏ qua ${item.imagePath}: tên nhóm "${item.group}" không hợp lệ.`); continue; }
    if (seen.has(key)) { warnings.push(`Bỏ qua ${item.imagePath}: trùng tên ảnh "${key}" trong cùng nhóm.`); continue; }
    if (key !== item.externalKey) warnings.push(`Ảnh ${item.imagePath} trùng tên với nhóm khác, lưu thành "${key}".`);
    seen.add(key);
    result.push({ ...item, externalKey: key });
  }
  return { rootName, items: result, warnings, cocoSets };
}

/** Định dạng mặc định: mỗi `manifest.json` trong thư mục; đường dẫn item tính từ thư mục của manifest. */
export function planDefaultImport<F>(entries: ImportEntry<F>[], manifests: ParsedJsonFile[], grouping: GroupingMode): ImportPlan<F> {
  const { rootName, find } = indexEntries(entries);
  const warnings: string[] = [];
  const items: PlannedItem<F>[] = [];
  if (!manifests.length) warnings.push('Không tìm thấy manifest.json. Định dạng mặc định cần manifest.json cùng thư mục images/, predictions/ (prelabels/ nếu có).');
  for (const manifest of manifests) {
    const manifestPath = relativeEntryPath(manifest.path);
    const directory = dirname(manifestPath);
    const list = (manifest.value as { items?: unknown } | null)?.items;
    if (!Array.isArray(list)) { warnings.push(`${manifestPath}: thiếu danh sách items.`); continue; }
    for (const raw of list) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || typeof item.image !== 'string' || typeof item.prediction !== 'string') {
        warnings.push(`${manifestPath}: item ${id || '(không có id)'} thiếu id, image hoặc prediction.`);
        continue;
      }
      const image = find(joinRelative(directory, item.image));
      const prediction = find(joinRelative(directory, item.prediction));
      const prelabelPath = typeof item.prelabel === 'string' ? joinRelative(directory, item.prelabel) : undefined;
      const prelabel = prelabelPath === undefined ? undefined : find(prelabelPath);
      if (!image) { warnings.push(`${id}: không thấy ảnh ${item.image}.`); continue; }
      if (!prediction) { warnings.push(`${id}: không thấy mask ${item.prediction}.`); continue; }
      if (prelabelPath !== undefined && !prelabel) { warnings.push(`${id}: không thấy prelabel ${String(item.prelabel)}.`); continue; }
      const imagePath = relativeEntryPath(image.path);
      items.push({
        externalKey: id,
        group: groupName(imagePath, id, rootName, grouping, item.group),
        imagePath,
        image: image.file,
        prediction: prediction.file,
        prelabel: prelabel?.file,
      });
    }
  }
  return finalize(rootName, items, warnings, []);
}

/**
 * COCO 1.0: file JSON nằm trong `annotations/` thì thư mục gốc của bộ COCO là thư mục cha. `file_name`
 * được tìm theo `<gốc>/<file_name>`, `<gốc>/images/<file_name>`, rồi theo tên tệp duy nhất trong bộ.
 */
export function planCocoImport<F>(entries: ImportEntry<F>[], jsonFiles: ParsedJsonFile[], grouping: GroupingMode): ImportPlan<F> {
  const { rootName, byPath, find } = indexEntries(entries);
  const warnings: string[] = [];
  const items: PlannedItem<F>[] = [];
  const cocoSets: CocoDataset[] = [];
  for (const json of jsonFiles) {
    const dataset = json.value;
    if (!isCocoDataset(dataset)) continue;
    const setIndex = cocoSets.push(dataset) - 1;
    const jsonDirectory = dirname(relativeEntryPath(json.path));
    const base = basename(jsonDirectory).toLowerCase() === 'annotations' ? dirname(jsonDirectory) : jsonDirectory;
    const byName = new Map<string, string[]>();
    for (const relative of byPath.keys()) {
      if (!IMAGE_EXTENSION.test(relative) || (base && !relative.startsWith(`${base}/`))) continue;
      const name = basename(relative).toLowerCase();
      byName.set(name, [...(byName.get(name) ?? []), relative]);
    }
    for (const image of dataset.images) {
      const fileName = typeof image?.file_name === 'string' ? image.file_name.replace(/\\/g, '/') : '';
      const width = Number(image?.width);
      const height = Number(image?.height);
      if (!fileName) { warnings.push(`${relativeEntryPath(json.path)}: ảnh id ${String(image?.id)} thiếu file_name.`); continue; }
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        warnings.push(`${fileName}: thiếu width/height hợp lệ trong COCO.`);
        continue;
      }
      let imagePath: string | undefined;
      for (const candidate of [joinRelative(base, fileName), joinRelative(base, `images/${fileName}`)]) {
        const entry = find(candidate);
        if (entry) { imagePath = relativeEntryPath(entry.path); break; }
      }
      if (!imagePath) {
        const matches = byName.get(basename(fileName).toLowerCase()) ?? [];
        const suffixed = matches.filter((path) => path.toLowerCase().endsWith(`/${fileName.toLowerCase()}`));
        if (matches.length === 1) imagePath = matches[0];
        else if (suffixed.length === 1) imagePath = suffixed[0];
        else {
          warnings.push(matches.length ? `${fileName}: có nhiều ảnh cùng tên, không xác định được ảnh nào.` : `${fileName}: không thấy ảnh trong thư mục.`);
          continue;
        }
      }
      const entry = byPath.get(imagePath)!;
      const externalKey = stem(fileName);
      items.push({
        externalKey,
        group: groupName(imagePath, externalKey, rootName, grouping),
        imagePath,
        image: entry.file,
        coco: { setIndex, imageId: String(image.id), width, height },
      });
    }
  }
  if (!cocoSets.length) warnings.push('Không tìm thấy file COCO (annotations/instances_*.json có images, annotations, categories).');
  return finalize(rootName, items, warnings, cocoSets);
}

/** Thống kê theo nhóm cho phần xem trước. */
export function summarizePlan<F>(plan: ImportPlan<F>) {
  const groups = new Map<string, number>();
  for (const item of plan.items) groups.set(item.group, (groups.get(item.group) ?? 0) + 1);
  return [...groups].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
}
