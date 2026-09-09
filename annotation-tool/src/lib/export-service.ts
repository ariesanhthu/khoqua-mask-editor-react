import 'server-only';

import crypto from 'crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { MaskOperation } from '@/types';
import { ensureDriveFolder, fetchDatasetAsset, normalizeDriveFolderId, readDriveTextFile, upsertDriveFile } from './drive-service';
import { getDb } from './db';
import { readStoredMask } from './storage';

interface ExportRow extends Record<string, unknown> {
  file_id: string;
  external_key: string;
  prediction_ref: string;
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
    SELECT df.id AS file_id, df.external_key, df.prediction_drive_file_id AS prediction_ref,
      a.segmentation_json, a.breakpoints_json, a.revision, df.latest_version_number, a.status AS annotation_status, df.width, df.height
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    JOIN annotations a ON a.dataset_file_id = df.id
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
    const polygons = operation.polygons.map((polygon) => {
      if (!polygon.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) throw new Error('Invalid polygon coordinates.');
      return `<polygon points="${polygon.nodes.map((node) => `${node.x},${node.y}`).join(' ')}" fill="white"/>`;
    }).join('');
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Number(row.width)}" height="${Number(row.height)}"><rect width="100%" height="100%" fill="black"/>${polygons}</svg>`))
      .greyscale().threshold(127).removeAlpha().png().toBuffer();
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

export async function createProjectExportArchive(projectId: string) {
  const data = await loadProjectExport(projectId);
  if (!data) return null;
  const zip = new JSZip();
  const masks = zip.folder('masks');
  const manifestEntries: ManifestEntry[] = [];
  const breakpointEntries: BreakpointEntry[] = [];
  const wartPointEntries: BreakpointEntry[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const row of data.rows) {
    try {
      const parsed = parseRow(row);
      masks?.file(parsed.maskFilename, await loadMask(row, parsed.segmentation));
      manifestEntries.push(parsed.manifest);
      breakpointEntries.push(parsed.breakpoint);
      wartPointEntries.push(parsed.wartPoints);
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  zip.file('manifest.jsonl', jsonLines(manifestEntries));
  zip.file('breakpoints.jsonl', jsonLines(breakpointEntries));
  zip.file('wart-points.jsonl', jsonLines(wartPointEntries));
  if (errors.length) zip.file('export-errors.json', JSON.stringify(errors, null, 2));
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
