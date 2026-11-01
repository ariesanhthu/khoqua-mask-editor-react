import 'server-only';

import crypto from 'crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { MaskOperation } from '@/types';
import { ensureDriveFolder, fetchDatasetAsset, normalizeDriveFolderId, readDriveTextFile, upsertDriveFile } from './drive-service';
import { getDb } from './db';
import { readStoredMask } from './storage';
import { rasterizePolygons } from './mask-pixels';
import { annotationSvg } from './annotation-svg';
import { addPixelAudit, addPolygonFiles } from './polygon-export';
import { cocoCategories, cocoInstance } from './coco-export';

interface ExportRow extends Record<string, unknown> {
  file_id: string;
  external_key: string;
  prediction_ref: string;
  image_ref: string;
  image_filename: string;
  prelabel_ref?: string;
  last_edited_by?: string;
  updated_at?: string;
  segmentation_json: string;
  breakpoints_json: string;
  revision: number;
  latest_version_number: number;
  annotation_status: string;
  width: number;
  height: number;
}

interface ManifestEntry {
  image_id: string;
  mask: string;
  human_action: string;
  revision: number;
  version: number;
  mask_sha256?: string;
  breakpoints_sha256?: string;
  wart_points_sha256?: string;
  annotation_status?: string;
  annotation?: string;
  image?: string;
  mask_encoding?: string;
}

interface BreakpointEntry {
  image_id: string;
  state: string;
  points: Array<{ x: number; y: number }>;
}

async function loadProjectExport(projectId: string) {
  const db = await getDb();
  const project = await db.prepare<{ id: string; name: string; export_drive_folder_id: string }>(
    'SELECT id, name, export_drive_folder_id FROM projects WHERE id = ?',
  ).get(projectId);
  if (!project) return null;
  const rows = await db.prepare<ExportRow>(`
    SELECT df.id AS file_id, df.external_key, df.prediction_drive_file_id AS prediction_ref, df.image_drive_file_id AS image_ref, df.image_filename, df.prelabel_storage_ref AS prelabel_ref, a.last_edited_by, a.updated_at,
      COALESCE(a.segmentation_json, '{"humanAction":"UNTOUCHED"}') AS segmentation_json,
      COALESCE(a.breakpoints_json, '{"state":"NOT_ANNOTATED","points":[]}') AS breakpoints_json,
      COALESCE(a.revision, 0) AS revision, df.latest_version_number,
      COALESCE(a.status, 'UNSTARTED') AS annotation_status, df.width, df.height
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    LEFT JOIN annotations a ON a.dataset_file_id = df.id
    WHERE d.project_id = ?
    ORDER BY df.external_key
  `).all(projectId);
  return { project, rows };
}

function parseRow(row: ExportRow) {
  const segmentation = JSON.parse(row.segmentation_json) as { humanAction: string; maskStorageKey?: string; maskOperations?: MaskOperation[]; wartPoints?: { state: string; points: Array<{ id: string; x: number; y: number }> } };
  const breakpoints = JSON.parse(row.breakpoints_json) as { state: string; points: Array<{ x: number; y: number }> };
  const maskFilename = `${safeFilename(row.external_key)}.png`;
  const manifest: ManifestEntry = {
    image_id: row.external_key,
    mask: `masks/${maskFilename}`,
    human_action: segmentation.humanAction,
    revision: Number(row.revision),
    version: Number(row.latest_version_number),
    annotation_status: row.annotation_status,
    mask_encoding: 'binary-pixel-center-v1',
  };
  return {
    segmentation,
    breakpoint: { image_id: row.external_key, state: breakpoints.state, points: breakpoints.points },
    wartPoints: { image_id: row.external_key, state: segmentation.wartPoints?.state ?? 'NOT_ANNOTATED', points: segmentation.wartPoints?.points ?? [] },
    manifest,
    maskFilename,
  };
}

async function loadMask(row: ExportRow, segmentation: ReturnType<typeof parseRow>['segmentation']): Promise<Uint8Array> {
  const operation = segmentation.maskOperations?.at(-1);
  // Older drafts contain polygon operations but no rendered mask (or an older mask key).
  if (segmentation.humanAction === 'MODIFIED' && operation?.type === 'POLYGON_SET') {
    if (!(row.width > 0 && row.height > 0)) throw new Error('Missing source image dimensions.');
    const pixels = rasterizePolygons(operation.polygons, Number(row.width), Number(row.height));
    return sharp(pixels, { raw: { width: Number(row.width), height: Number(row.height), channels: 1 } }).png().toBuffer();
  }
  if (segmentation.humanAction === 'ACCEPTED' || operation?.type === 'RESET_TO_PREDICTION') return fetchDatasetAsset(row.prediction_ref);
  if (segmentation.maskStorageKey) return readStoredMask(segmentation.maskStorageKey);
  if (segmentation.humanAction === 'MODIFIED') throw new Error('Modified mask has no renderable operations or saved mask.');
  return fetchDatasetAsset(row.prediction_ref);
}

function jsonLines(items: unknown[]): Uint8Array {
  return new TextEncoder().encode(items.length ? `${items.map((item) => JSON.stringify(item)).join('\n')}\n` : '');
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseManifestLog(value: string | null): Map<string, ManifestEntry> {
  const entries = new Map<string, ManifestEntry>();
  for (const line of value?.split(/\r?\n/) || []) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as ManifestEntry;
    if (entry.image_id) entries.set(entry.image_id, entry);
  }
  return entries;
}

export async function syncProjectAnnotationsToDrive(projectId: string) {
  const data = await loadProjectExport(projectId);
  if (!data) return null;
  const destination = data.project.export_drive_folder_id || process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID;
  if (!destination) throw new Error('Chưa cấu hình thư mục Drive đích để xuất ground truth.');

  const exportFolderId = normalizeDriveFolderId(destination);
  const [masksFolderId, existingManifestText, existingBreakpointsText, existingWartPointsText] = await Promise.all([
    ensureDriveFolder('masks', exportFolderId),
    readDriveTextFile('manifest.jsonl', exportFolderId),
    readDriveTextFile('breakpoints.jsonl', exportFolderId),
    readDriveTextFile('wart-points.jsonl', exportFolderId),
  ]);
  const previousManifest = parseManifestLog(existingManifestText);
  const manifestEntries: ManifestEntry[] = [];
  const breakpointEntries: BreakpointEntry[] = [];
  const wartPointEntries: BreakpointEntry[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  let updated = 0;
  let skipped = 0;

  for (const row of data.rows) {
    if (row.annotation_status === 'UNSTARTED') continue;
    try {
      const parsed = parseRow(row);
      manifestEntries.push(parsed.manifest);
      breakpointEntries.push(parsed.breakpoint);
      wartPointEntries.push(parsed.wartPoints);
      parsed.manifest.wart_points_sha256 = sha256(jsonLines([parsed.wartPoints]));
      const previous = previousManifest.get(row.external_key);
      const metadataChanged = !previous
        || Number(previous.revision) !== parsed.manifest.revision
        || Number(previous.version) !== parsed.manifest.version
        || previous.mask !== parsed.manifest.mask
        || previous.human_action !== parsed.manifest.human_action
        || previous.annotation_status !== parsed.manifest.annotation_status
        || previous.mask_encoding !== parsed.manifest.mask_encoding
        || previous.wart_points_sha256 !== parsed.manifest.wart_points_sha256;
      if (!metadataChanged && previous?.mask_sha256 && previous.breakpoints_sha256) {
        parsed.manifest.mask_sha256 = previous.mask_sha256;
        parsed.manifest.breakpoints_sha256 = previous.breakpoints_sha256;
        skipped += 1;
        continue;
      }
      const mask = await loadMask(row, parsed.segmentation);
      parsed.manifest.mask_sha256 = sha256(mask);
      parsed.manifest.breakpoints_sha256 = sha256(jsonLines([parsed.breakpoint]));
      if (parsed.manifest.mask_sha256 !== previous?.mask_sha256) {
        await upsertDriveFile(parsed.maskFilename, masksFolderId, mask, 'image/png');
      }
      updated += 1;
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (errors.length === 0) {
    const nextBreakpoints = jsonLines(breakpointEntries);
    const nextManifest = jsonLines(manifestEntries);
    const nextWartPoints = jsonLines(wartPointEntries);
    const uploads: Array<Promise<unknown>> = [];
    if (new TextDecoder().decode(nextBreakpoints) !== (existingBreakpointsText || '')) {
      uploads.push(upsertDriveFile('breakpoints.jsonl', exportFolderId, nextBreakpoints, 'application/jsonl'));
    }
    if (new TextDecoder().decode(nextManifest) !== (existingManifestText || '')) {
      uploads.push(upsertDriveFile('manifest.jsonl', exportFolderId, nextManifest, 'application/jsonl'));
    }
    if (new TextDecoder().decode(nextWartPoints) !== (existingWartPointsText || '')) {
      uploads.push(upsertDriveFile('wart-points.jsonl', exportFolderId, nextWartPoints, 'application/jsonl'));
    }
    await Promise.all(uploads);
  }

  return {
    driveFolderId: exportFolderId,
    driveFolderUrl: `https://drive.google.com/drive/folders/${exportFolderId}`,
    exported: manifestEntries.length,
    updated,
    skipped,
    errors,
  };
}

export async function createProjectExportArchive(projectId: string, includeVersions = false) {
  const data = await loadProjectExport(projectId);
  if (!data) return null;
  const zip = new JSZip();
  const masks = zip.folder('masks');
  const annotations = zip.folder('annotations');
  const images = zip.folder('images');
  const usedNames = new Set<string>();
  const manifestEntries: ManifestEntry[] = [];
  const breakpointEntries: BreakpointEntry[] = [];
  const wartPointEntries: BreakpointEntry[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  const cocoImages: Array<{ id: number; file_name: string; width: number; height: number; external_key: string; status: string }> = [];
  const cocoAnnotations: ReturnType<typeof cocoInstance>[] = [];

  for (const row of data.rows) {
    try {
      const parsed = parseRow(row);
      const stem = safeFilename(row.external_key);
      if (usedNames.has(stem)) throw new Error(`Duplicate export filename: ${stem}`);
      usedNames.add(stem);
      const [maskBytes, imageBytes] = await Promise.all([
        parsed.segmentation.maskStorageKey ? readStoredMask(parsed.segmentation.maskStorageKey) : loadMask(row, parsed.segmentation),
        fetchDatasetAsset(row.image_ref),
      ]);
      const width = Number(row.width); const height = Number(row.height);
      const [maskMetadata, imageMetadata] = await Promise.all([sharp(maskBytes).metadata(), sharp(imageBytes).metadata()]);
      if (maskMetadata.width !== width || maskMetadata.height !== height || imageMetadata.width !== width || imageMetadata.height !== height) {
        throw new Error('Image/mask dimensions differ from saved annotation coordinate space');
      }
      // Never invent geometry from the raster during download, including UNTOUCHED/ACCEPTED.
      let maskOperations = parsed.segmentation.maskOperations;
      let sourcePrelabel: Record<string, unknown> | undefined;
      if (row.annotation_status === 'UNSTARTED' && row.prelabel_ref) {
        sourcePrelabel = JSON.parse(new TextDecoder().decode(await fetchDatasetAsset(row.prelabel_ref)));
        maskOperations = sourcePrelabel?.maskOperations as MaskOperation[] | undefined;
      }
      const extension = imageMetadata.format === 'jpeg' ? 'jpg' : imageMetadata.format || 'png';
      const imagePath = `images/${stem}.${extension}`;
      const annotation = {
        schemaVersion: 'bitter-melon-prelabel-1.1', imageId: row.external_key, datasetFileId: row.file_id, coordinateSpace: 'image_pixels',
        width, height, maskOperations: maskOperations ?? [], revision: Number(row.revision), version: Number(row.latest_version_number),
        status: row.annotation_status, segmentation: parsed.segmentation, breakpoints: JSON.parse(row.breakpoints_json),
        wartPoints: parsed.segmentation.wartPoints, lastEditedBy: row.last_edited_by, updatedAt: row.updated_at,
        image: `../${imagePath}`, mask: `../masks/${stem}.png`,
        sourcePrelabel,
        maskSource: parsed.segmentation.maskStorageKey ? 'saved_raster' : parsed.segmentation.humanAction === 'MODIFIED' ? 'rendered_from_saved_vectors' : 'source_prediction',
      };
      masks?.file(parsed.maskFilename, maskBytes);
      annotations?.file(`${stem}.json`, JSON.stringify(annotation));
      // Raw JSON strings and image/mask bytes are retained for exact restoration.
      zip.file(`saved/${stem}/segmentation.json`, row.segmentation_json);
      zip.file(`saved/${stem}/breakpoints.json`, row.breakpoints_json);
      images?.file(`${stem}.${extension}`, imageBytes);
      await addPolygonFiles(zip, `polygons/${stem}`, maskOperations ?? [], width, height, `../../${imagePath}`);
      const imageId = cocoImages.length + 1;
      cocoImages.push({ id: imageId, file_name: imagePath, width, height, external_key: row.external_key, status: row.annotation_status });
      const localCoco = JSON.parse(await zip.file(`polygons/${stem}/coco.json`)!.async('string'));
      for (const instance of localCoco.annotations) cocoAnnotations.push({ ...instance, id: cocoAnnotations.length + 1, image_id: imageId });
      await addPixelAudit(zip, `pixel-audit/${stem}`, maskOperations ?? [], width, height, maskBytes);
      zip.file(`boundaries/${stem}.svg`, annotationSvg(maskOperations ?? [], width, height));
      zip.file(`overlays/${stem}.svg`, annotationSvg(maskOperations ?? [], width, height,
        `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${Buffer.from(imageBytes).toString('base64')}`));
      parsed.manifest.annotation = `annotations/${stem}.json`;
      parsed.manifest.image = imagePath;
      parsed.manifest.mask_sha256 = sha256(maskBytes);
      manifestEntries.push(parsed.manifest);
      breakpointEntries.push(parsed.breakpoint);
      wartPointEntries.push(parsed.wartPoints);
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  zip.file('manifest.jsonl', jsonLines(manifestEntries));
  zip.file('coco.json', JSON.stringify({ info: { description: 'Independent current polygon masks, COCO column-major RLE. Original saved raster is retained separately in masks/.' },
    images: cocoImages, annotations: cocoAnnotations, categories: cocoCategories }));
  zip.file('breakpoints.jsonl', jsonLines(breakpointEntries));
  zip.file('wart-points.jsonl', jsonLines(wartPointEntries));
  zip.file('POLYGON_EXPORT_README.txt', 'polygons/<ảnh>/: mỗi polygon có JSON, PNG và SVG riêng; index.json giữ ID và nhãn. PNG dùng nguyên kích thước ảnh, giữ độc lập cả khi polygon chồng lên nhau.\npixel-audit/<ảnh>/: vector-mask.png dựng bổ sung từ polygon, difference.png so sánh với raster đã lưu, audit.json đếm pixel sai khác. Đỏ: có trong polygon nhưng thiếu ở raster; xanh: chỉ có ở raster. Dữ liệu gốc không bị sửa.\nversions/: toàn bộ lịch sử dành cho ADMIN. Muốn tải từng polygon của một version, dùng nút Tải version trong cửa sổ lịch sử.\n');
  if (includeVersions) {
    const db = await getDb();
    const versions = await db.prepare(`SELECT v.*, df.external_key, df.image_drive_file_id, df.prediction_drive_file_id, df.width, df.height
      FROM annotation_versions v JOIN dataset_files df ON df.id = v.dataset_file_id
      JOIN datasets d ON d.id = df.dataset_id WHERE d.project_id = ? ORDER BY df.external_key, v.version_number`).all(projectId);
    for (const version of versions) {
      const assets = version.asset_snapshot_json ? JSON.parse(String(version.asset_snapshot_json)) : {
        image: version.image_drive_file_id, prediction: version.prediction_drive_file_id, width: version.width, height: version.height,
      };
      const segmentation = JSON.parse(String(version.segmentation_json));
      const folder = `versions/${safeFilename(String(version.external_key))}/v${version.version_number}`;
      // Include each historical crop: its coordinate system may differ from the active image.
      const imageBytes = await fetchDatasetAsset(assets.image);
      const format = (await sharp(imageBytes).metadata()).format;
      const extension = format === 'jpeg' ? 'jpg' : format || 'png';
      zip.file(`${folder}/image.${extension}`, imageBytes);
      zip.file(`${folder}/annotation.json`, JSON.stringify({ id: version.id, versionNumber: version.version_number,
        label: version.version_label, width: assets.width, height: assets.height, coordinateSpace: 'image_pixels',
        segmentation, maskOperations: segmentation.maskOperations ?? [], breakpoints: JSON.parse(String(version.breakpoints_json)),
        createdBy: version.created_by, createdAt: version.created_at, assetSnapshot: assets }));
      zip.file(`${folder}/segmentation.json`, String(version.segmentation_json));
      zip.file(`${folder}/breakpoints.json`, String(version.breakpoints_json));
      zip.file(`${folder}/boundary.svg`, annotationSvg(segmentation.maskOperations ?? [], Number(assets.width), Number(assets.height)));
      await addPolygonFiles(zip, `${folder}/polygons`, segmentation.maskOperations ?? [], Number(assets.width), Number(assets.height), `../image.${extension}`);
      if (segmentation.maskStorageKey) zip.file(`${folder}/mask.png`, await readStoredMask(segmentation.maskStorageKey));
      else zip.file(`${folder}/mask.png`, await loadMask({ width: Number(assets.width), height: Number(assets.height), prediction_ref: assets.prediction } as ExportRow, segmentation));
    }
  }
  // A successful download must contain every image, not a partial archive with hidden failures.
  if (errors.length) throw new Error(`Không thể xuất đủ dữ liệu: ${errors.map((error) => `${error.id}: ${error.message}`).join('; ')}`);
  zip.file('README.txt', 'annotations/: dữ liệu polygon, boundary (nodes/holes), label và metadata nguyên vẹn.\nsaved/: chuỗi JSON gốc trên server để khôi phục. images/: byte ảnh gốc, không resize/crop/encode lại.\nmasks/: raster đã lưu; chỉ render vector nếu chưa có raster. boundaries/ và overlays/: SVG giữ tọa độ vector, zoom không vỡ hình.\nKhông tự vectorize mask hay đổi nhãn khi tải về. Dữ liệu chưa lưu ở trình duyệt cần bấm Lưu trước khi tải ZIP.\n');

  return {
    bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    filename: `${safeFilename(data.project.name)}-ground-truth.zip`,
    exported: manifestEntries.length,
    errors,
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
