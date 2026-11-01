import 'server-only';

import crypto from 'crypto';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import type { AnnotationPolygon, DatasetImportResult } from '@/types';
import { generateId, getDb, nowISO } from './db';
import { isValidExternalKey, isValidGroupName, normalizeGroupName } from './file-groups';
import { ensureGroup } from './group-service';
import { rasterizePolygons } from './mask-pixels';
import { datasetObjectReference, putObject } from './object-store';
import { parsePrelabelOperations } from './prelabel-service';

/**
 * Nhập một ảnh của thư mục admin tải lên (một request mỗi ảnh để nằm dưới giới hạn ~4.5 MB của Vercel).
 * Ảnh, mask gợi ý và prelabel được lưu như một dataset `blob:` bình thường nên editor, thumbnail,
 * export và version đọc chúng y như dữ liệu đồng bộ từ manifest. Nhập lại cùng tên ảnh cập nhật
 * nguồn nhưng không bao giờ đụng annotation đã lưu.
 */

export class DatasetImportError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES: Record<string, { extension: string; contentType: string }> = {
  jpeg: { extension: '.jpg', contentType: 'image/jpeg' },
  png: { extension: '.png', contentType: 'image/png' },
  webp: { extension: '.webp', contentType: 'image/webp' },
};
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface DatasetImportItem {
  externalKey: string;
  groupName: string;
  image: Uint8Array;
  /** Mask gợi ý PNG của định dạng mặc định. Thiếu thì dựng từ polygon prelabel (COCO) hoặc mask rỗng. */
  prediction?: Uint8Array;
  /** Prelabel `bitter-melon-prelabel-1.x`, có thể đã được trình duyệt nén gzip. */
  prelabel?: Uint8Array;
}

function storageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'item';
}

async function readImage(bytes: Uint8Array) {
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata().catch(() => null);
  if (!metadata) throw new DatasetImportError('Tệp ảnh bị hỏng hoặc không phải ảnh.');
  const type = metadata.format ? IMAGE_TYPES[metadata.format] : undefined;
  if (!type) throw new DatasetImportError('Ảnh phải là JPEG, PNG hoặc WebP.');
  // Trình duyệt hiển thị ảnh đã xoay theo EXIF còn mask/polygon tính theo pixel lưu trong tệp: nhập vào
  // sẽ lệch nhãn mà không báo lỗi gì, nên từ chối thay vì đoán.
  if (metadata.orientation && metadata.orientation !== 1) {
    throw new DatasetImportError(`Ảnh có EXIF xoay (orientation ${metadata.orientation}). Hãy xuất lại ảnh đã xoay đúng chiều rồi nhập lại.`);
  }
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (width < 1 || height < 1) throw new DatasetImportError('Không đọc được kích thước ảnh.');
  return { width, height, ...type };
}

function readPrelabel(bytes: Uint8Array): { raw: Buffer; value: unknown } {
  let raw: Buffer;
  try {
    raw = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_ASSET_BYTES })
      : Buffer.from(bytes);
  } catch {
    throw new DatasetImportError('Prelabel nén gzip bị hỏng hoặc lớn hơn 50 MB khi giải nén.');
  }
  try {
    return { raw, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    throw new DatasetImportError('Prelabel không phải JSON hợp lệ.');
  }
}

async function checkPrediction(bytes: Uint8Array, width: number, height: number) {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new DatasetImportError('Mask phải là ảnh PNG.');
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata().catch(() => null);
  if (!metadata) throw new DatasetImportError('Tệp mask PNG bị hỏng.');
  if (metadata.width !== width || metadata.height !== height) {
    throw new DatasetImportError(`Mask ${metadata.width}×${metadata.height} không khớp kích thước ảnh ${width}×${height}.`);
  }
}

/** Mask gợi ý cùng quy tắc raster của editor/export: tâm pixel, evenodd, không khử răng cưa. */
async function renderPrediction(polygons: AnnotationPolygon[], width: number, height: number): Promise<Buffer> {
  const pixels = rasterizePolygons(polygons, width, height);
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

export async function importDatasetItem(projectId: string, item: DatasetImportItem): Promise<DatasetImportResult> {
  const { externalKey } = item;
  if (!isValidExternalKey(externalKey)) throw new DatasetImportError('Tên ảnh không hợp lệ.');
  const groupName = normalizeGroupName(item.groupName);
  if (!isValidGroupName(groupName)) throw new DatasetImportError('Tên nhóm không hợp lệ.');
  for (const [label, bytes] of [['Ảnh', item.image], ['Mask', item.prediction], ['Prelabel', item.prelabel]] as const) {
    if (bytes && (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES)) {
      throw new DatasetImportError(`${label} phải có kích thước từ 1 byte đến 50 MB.`);
    }
  }

  const image = await readImage(item.image);
  const prelabel = item.prelabel ? readPrelabel(item.prelabel) : undefined;
  let polygons: AnnotationPolygon[] = [];
  if (prelabel) {
    try {
      polygons = parsePrelabelOperations(prelabel.value, image.width, image.height)
        .flatMap((operation) => operation.type === 'POLYGON_SET' ? operation.polygons : []);
    } catch (error) {
      throw new DatasetImportError(error instanceof Error ? error.message : 'Prelabel không hợp lệ.');
    }
  }
  if (item.prediction) await checkPrediction(item.prediction, image.width, image.height);
  const prediction = item.prediction ?? await renderPrediction(polygons, image.width, image.height);

  // putObject không ghi đè nên mỗi lần nhập có thư mục riêng; nếu bước DB sau đó lỗi thì chỉ còn object mồ côi.
  const folder = `datasets/uploads/${storageSegment(projectId)}/${storageSegment(externalKey)}/${Date.now()}-${crypto.randomUUID()}`;
  const imageKey = `${folder}/image${image.extension}`;
  const predictionKey = `${folder}/prediction.png`;
  const prelabelKey = prelabel ? `${folder}/prelabel.json` : null;
  await Promise.all([
    putObject(imageKey, item.image, image.contentType),
    putObject(predictionKey, prediction, 'image/png'),
    prelabel && prelabelKey ? putObject(prelabelKey, prelabel.raw, 'application/json') : Promise.resolve(),
  ]);
  const references = [
    datasetObjectReference(imageKey),
    datasetObjectReference(predictionKey),
    prelabelKey ? datasetObjectReference(prelabelKey) : null,
  ];
  const filenames = [`${externalKey}${image.extension}`, `${externalKey}.png`, prelabelKey ? `${externalKey}.json` : null];

  const db = await getDb();
  return db.transaction(async (tx) => {
    // Khóa hàng project để các request nhập song song của cùng dự án không tạo trùng dataset hay ảnh.
    const project = await tx.prepare<{ id: string; name: string }>('SELECT id, name FROM projects WHERE id = ? FOR UPDATE').get(projectId);
    if (!project) throw new DatasetImportError('Không tìm thấy dự án.', 404);
    const now = nowISO();
    let dataset = await tx.prepare<{ id: string }>('SELECT id FROM datasets WHERE project_id = ? ORDER BY created_at LIMIT 1').get(projectId);
    if (!dataset) {
      dataset = { id: generateId() };
      await tx.prepare('INSERT INTO datasets (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(dataset.id, projectId, `${project.name} Dataset`, now, now);
    }
    const group = await ensureGroup(tx, projectId, groupName);
    // Cùng thứ tự khóa với lock-service (dataset_files trước): không ai nhận khóa sửa giữa lúc kiểm và ghi.
    const existing = await tx.prepare<{
      id: string; width: number | null; height: number | null; annotated: boolean;
      lock_holder: string | null; lock_expires_at: string | null;
    }>(`SELECT df.id, df.width, df.height,
        EXISTS (SELECT 1 FROM annotations a WHERE a.dataset_file_id = df.id) AS annotated,
        lu.display_name AS lock_holder, fl.expires_at AS lock_expires_at
      FROM dataset_files df
      LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id
      LEFT JOIN users lu ON lu.id = fl.user_id
      WHERE df.dataset_id = ? AND df.external_key = ?
      FOR UPDATE OF df`).get(dataset.id, externalKey);
    let fileId: string;
    if (existing) {
      if (existing.lock_expires_at && new Date(existing.lock_expires_at) > new Date()) {
        throw new DatasetImportError(`Ảnh ${externalKey} đang được ${existing.lock_holder || 'người khác'} chỉnh sửa; hãy nhập lại sau.`, 409);
      }
      if (existing.annotated && (Number(existing.width) !== image.width || Number(existing.height) !== image.height)) {
        throw new DatasetImportError(`Ảnh ${externalKey} đã có nhãn trên kích thước ${existing.width ?? '?'}×${existing.height ?? '?'}; ảnh mới ${image.width}×${image.height} sẽ làm lệch nhãn.`, 409);
      }
      fileId = existing.id;
      await tx.prepare(`UPDATE dataset_files SET image_drive_file_id = ?, prediction_drive_file_id = ?, prelabel_storage_ref = ?,
        image_filename = ?, prediction_filename = ?, prelabel_filename = ?, width = ?, height = ?, asset_state = 'READY',
        group_id = ?, updated_at = ? WHERE id = ?`)
        .run(...references, ...filenames, image.width, image.height, group.id, now, fileId);
    } else {
      fileId = generateId();
      await tx.prepare(`INSERT INTO dataset_files
        (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, prelabel_storage_ref,
         image_filename, prediction_filename, prelabel_filename, width, height, annotation_state, group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNSTARTED', ?, ?, ?)`)
        .run(fileId, dataset.id, externalKey, ...references, ...filenames, image.width, image.height, group.id, now, now);
    }
    await tx.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    return { fileId, externalKey, groupId: group.id, groupName: group.name, created: !existing };
  });
}
