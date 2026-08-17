import 'server-only';

import { createDriveFolder, fetchDriveAsset, uploadDriveFile } from './drive-service';
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

export async function exportProjectAnnotations(projectId: string) {
  const db = await getDb();
  const project = await db.prepare<{ id: string; name: string; export_drive_folder_id: string }>(
    'SELECT id, name, export_drive_folder_id FROM projects WHERE id = ?',
  ).get(projectId);
  if (!project) return null;

  const destination = project.export_drive_folder_id || process.env.GOOGLE_DRIVE_EXPORT_FOLDER_ID;
  if (!destination) {
    throw new Error('Chưa cấu hình thư mục Drive đích để xuất ground truth.');
  }

  const rows = await db.prepare<ExportRow>(`
    SELECT df.id AS file_id, df.external_key, df.prediction_drive_file_id AS prediction_ref,
      a.segmentation_json, a.breakpoints_json, a.revision, df.latest_version_number
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    JOIN annotations a ON a.dataset_file_id = df.id
    WHERE d.project_id = ? AND df.annotation_state = 'DONE'
    ORDER BY df.external_key
  `).all(projectId);

  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const exportName = `export_${stamp}`;
  const exportFolderId = await createDriveFolder(exportName, destination);
  const masksFolderId = await createDriveFolder('masks', exportFolderId);
  const breakpointLines: string[] = [];
  const manifestLines: string[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const row of rows) {
    try {
      const segmentation = JSON.parse(row.segmentation_json) as { humanAction: string; maskStorageKey?: string };
      const breakpoints = JSON.parse(row.breakpoints_json) as { state: string; points: Array<{ x: number; y: number }> };
      const mask = segmentation.maskStorageKey
        ? await readStoredMask(segmentation.maskStorageKey)
        : await fetchDriveAsset(row.prediction_ref);
      const maskFilename = `${safeFilename(row.external_key)}.png`;
      await uploadDriveFile(maskFilename, masksFolderId, mask, 'image/png');
      breakpointLines.push(JSON.stringify({
        image_id: row.external_key,
        state: breakpoints.state,
        points: breakpoints.points,
      }));
      manifestLines.push(JSON.stringify({
        image_id: row.external_key,
        mask: `masks/${maskFilename}`,
        human_action: segmentation.humanAction,
        revision: Number(row.revision),
        version: Number(row.latest_version_number),
      }));
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const encoder = new TextEncoder();
  await Promise.all([
    uploadDriveFile(
      'breakpoints.jsonl',
      exportFolderId,
      encoder.encode(breakpointLines.length ? `${breakpointLines.join('\n')}\n` : ''),
      'application/jsonl',
    ),
    uploadDriveFile(
      'manifest.jsonl',
      exportFolderId,
      encoder.encode(manifestLines.length ? `${manifestLines.join('\n')}\n` : ''),
      'application/jsonl',
    ),
  ]);

  return {
    exportName,
    driveFolderId: exportFolderId,
    driveFolderUrl: `https://drive.google.com/drive/folders/${exportFolderId}`,
    exported: manifestLines.length,
    errors,
  };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
