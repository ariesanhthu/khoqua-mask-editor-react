import 'server-only';

import JSZip from 'jszip';
import sharp from 'sharp';
import type { MaskOperation } from '@/types';
import { FILE_ACCESS_SQL, PROJECT_ACCESS_SQL } from './access-service';
import { cocoCategories, cocoInstance } from './coco-export';
import { getDb } from './db';
import { fetchDatasetAsset } from './drive-service';
import { rasterizePolygons } from './mask-pixels';

interface CompletedRow extends Record<string, unknown> {
  file_id: string;
  external_key: string;
  image_ref: string;
  width: number;
  height: number;
  segmentation_json: string;
  revision: number;
}

/** Separate from the full ZIP/Drive export: never change their draft/history behavior. */
export async function createCompletedProjectExportArchive(projectId: string, userId: string) {
  const db = await getDb();
  const project = await db.prepare<{ name: string }>(`SELECT p.name FROM projects p WHERE p.id = ?
    AND ${PROJECT_ACCESS_SQL}`)
    .get(projectId, userId, userId);
  if (!project) return null;

  // One query captures the current status, vectors, revision and corresponding active image.
  const rows = await db.prepare<CompletedRow>(`SELECT df.id AS file_id, df.external_key,
      df.image_drive_file_id AS image_ref, df.width, df.height, a.segmentation_json, a.revision
    FROM dataset_files df JOIN datasets d ON d.id = df.dataset_id
    JOIN annotations a ON a.dataset_file_id = df.id
    WHERE d.project_id = ? AND a.status = 'DONE' AND ${FILE_ACCESS_SQL}
    ORDER BY df.external_key, df.id`).all(projectId, userId, userId);
  if (!rows.length) throw new Error('Chưa có ảnh đã hoàn tất trong các nhóm bạn được phép tải.');

  const archive = new JSZip();
  const images: Array<{ id: number; file_name: string; width: number; height: number;
    external_key: string; dataset_file_id: string; revision: number; status: 'DONE' }> = [];
  const annotations: ReturnType<typeof cocoInstance>[] = [];
  const usedNames = new Set<string>();
  for (const row of rows) {
    try {
      const segmentation = JSON.parse(row.segmentation_json) as { maskOperations?: MaskOperation[] };
      const operation = segmentation.maskOperations?.at(-1);
      // A later brush/reset invalidates older vectors. Never fabricate empty ground truth from it.
      if (operation?.type !== 'POLYGON_SET') {
        throw new Error('Chưa có polygon hiện hành đã lưu. Hãy mở ảnh, lưu polygon và Hoàn tất lại.');
      }
      const width = Number(row.width), height = Number(row.height);
      if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
        throw new Error('Thiếu kích thước ảnh gốc hợp lệ.');
      }
      const stem = row.external_key.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (usedNames.has(stem)) throw new Error(`Trùng tên tệp xuất: ${stem}`);
      usedNames.add(stem);

      const image = await fetchDatasetAsset(row.image_ref);
      const metadata = await sharp(image).metadata();
      if (metadata.width !== width || metadata.height !== height) {
        throw new Error('Kích thước ảnh gốc không khớp hệ tọa độ polygon đã lưu.');
      }
      const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format || 'png';
      const imagePath = `images/${stem}.${extension}`;
      const imageId = images.length + 1;
      images.push({ id: imageId, file_name: imagePath, width, height, external_key: row.external_key,
        dataset_file_id: row.file_id, revision: Number(row.revision), status: 'DONE' });
      archive.file(imagePath, image);
      archive.file(`polygons/${stem}.json`, JSON.stringify({ schemaVersion: 'bitter-melon-prelabel-1.1',
        imageId: row.external_key, datasetFileId: row.file_id, width, height, coordinateSpace: 'image_pixels',
        revision: Number(row.revision), status: 'DONE', image: `../${imagePath}`, maskOperations: [operation] }));
      for (const polygon of operation.polygons) {
        annotations.push(cocoInstance(polygon, rasterizePolygons([polygon], width, height),
          width, height, annotations.length + 1, imageId));
      }
    } catch (error) {
      // All source assets are checked before returning a stream, so a failure cannot look like a partial ZIP.
      throw new Error(`${row.external_key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  archive.file('coco.json', JSON.stringify({ info: { description: 'Completed current polygons; independent COCO RLE preserves holes and overlaps. Original vectors in polygons/.' },
    images, annotations, categories: cocoCategories }));
  return { archive, exported: images.length,
    filename: `${project.name.replace(/[^a-zA-Z0-9._-]/g, '_')}-completed.zip` };
}
