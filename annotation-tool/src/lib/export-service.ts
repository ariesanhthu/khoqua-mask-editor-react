import 'server-only';

import crypto from 'crypto';
import JSZip from 'jszip';
import { ensureDriveFolder, fetchDriveAsset, normalizeDriveFolderId, readDriveTextFile, upsertDriveFile } from './drive-service';
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
}

interface ManifestEntry {
  image_id: string;
  mask: string;
  human_action: string;
  revision: number;
  version: number;
  mask_sha256?: string;
  breakpoints_sha256?: string;
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
      a.segmentation_json, a.breakpoints_json, a.revision, df.latest_version_number
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    JOIN annotations a ON a.dataset_file_id = df.id
    WHERE d.project_id = ? AND df.annotation_state = 'DONE'
    ORDER BY df.external_key
  `).all(projectId);
  return { project, rows };
}

function parseRow(row: ExportRow) {
  const segmentation = JSON.parse(row.segmentation_json) as { humanAction: string; maskStorageKey?: string };
  const breakpoints = JSON.parse(row.breakpoints_json) as { state: string; points: Array<{ x: number; y: number }> };
  const maskFilename = `${safeFilename(row.external_key)}.png`;
  const manifest: ManifestEntry = {
    image_id: row.external_key,
    mask: `masks/${maskFilename}`,
    human_action: segmentation.humanAction,
    revision: Number(row.revision),
    version: Number(row.latest_version_number),
  };
  return {
    segmentation,
    breakpoint: { image_id: row.external_key, state: breakpoints.state, points: breakpoints.points },
    manifest,
    maskFilename,
  };
}

async function loadMask(row: ExportRow, maskStorageKey?: string): Promise<Uint8Array> {
  return maskStorageKey ? readStoredMask(maskStorageKey) : fetchDriveAsset(row.prediction_ref);
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
  const [masksFolderId, existingManifestText, existingBreakpointsText] = await Promise.all([
    ensureDriveFolder('masks', exportFolderId),
    readDriveTextFile('manifest.jsonl', exportFolderId),
    readDriveTextFile('breakpoints.jsonl', exportFolderId),
  ]);
  const previousManifest = parseManifestLog(existingManifestText);
  const manifestEntries: ManifestEntry[] = [];
  const breakpointEntries: BreakpointEntry[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  let updated = 0;
  let skipped = 0;

  for (const row of data.rows) {
    try {
      const parsed = parseRow(row);
      manifestEntries.push(parsed.manifest);
      breakpointEntries.push(parsed.breakpoint);
      const previous = previousManifest.get(row.external_key);
      const metadataChanged = !previous
        || Number(previous.revision) !== parsed.manifest.revision
        || Number(previous.version) !== parsed.manifest.version
        || previous.mask !== parsed.manifest.mask
        || previous.human_action !== parsed.manifest.human_action;
      if (!metadataChanged && previous?.mask_sha256 && previous.breakpoints_sha256) {
        parsed.manifest.mask_sha256 = previous.mask_sha256;
        parsed.manifest.breakpoints_sha256 = previous.breakpoints_sha256;
        skipped += 1;
        continue;
      }
      const mask = await loadMask(row, parsed.segmentation.maskStorageKey);
      parsed.manifest.mask_sha256 = sha256(mask);
      parsed.manifest.breakpoints_sha256 = sha256(jsonLines([parsed.breakpoint]));
      if (parsed.manifest.mask_sha256 !== previous?.mask_sha256) {
        await upsertDriveFile(parsed.maskFilename, masksFolderId, mask, 'image/png');
        updated += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (errors.length === 0) {
    const nextBreakpoints = jsonLines(breakpointEntries);
    const nextManifest = jsonLines(manifestEntries);
    const uploads: Array<Promise<unknown>> = [];
    if (new TextDecoder().decode(nextBreakpoints) !== (existingBreakpointsText || '')) {
      uploads.push(upsertDriveFile('breakpoints.jsonl', exportFolderId, nextBreakpoints, 'application/jsonl'));
    }
    if (new TextDecoder().decode(nextManifest) !== (existingManifestText || '')) {
      uploads.push(upsertDriveFile('manifest.jsonl', exportFolderId, nextManifest, 'application/jsonl'));
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
  const errors: Array<{ id: string; message: string }> = [];

  for (const row of data.rows) {
    try {
      const parsed = parseRow(row);
      masks?.file(parsed.maskFilename, await loadMask(row, parsed.segmentation.maskStorageKey));
      manifestEntries.push(parsed.manifest);
      breakpointEntries.push(parsed.breakpoint);
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  zip.file('manifest.jsonl', jsonLines(manifestEntries));
  zip.file('breakpoints.jsonl', jsonLines(breakpointEntries));
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
