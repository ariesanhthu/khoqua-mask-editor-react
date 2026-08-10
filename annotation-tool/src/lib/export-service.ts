import 'server-only';

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { annotationStorageRoot, readStoredMask } from './storage';
import { fetchDriveAsset } from './drive-service';
import { getDb } from './db';

interface ExportRow {
  file_id: string;
  external_key: string;
  prediction_ref: string;
  segmentation_json: string;
  breakpoints_json: string;
  revision: number;
  latest_version_number: number;
}

export async function exportProjectAnnotations(projectId: string) {
  const db = getDb();
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
  if (!project) return null;
  const rows = db.prepare(`
    SELECT df.id AS file_id, df.external_key, df.prediction_drive_file_id AS prediction_ref,
      a.segmentation_json, a.breakpoints_json, a.revision, df.latest_version_number
    FROM dataset_files df
    JOIN datasets d ON d.id = df.dataset_id
    JOIN annotations a ON a.dataset_file_id = df.id
    WHERE d.project_id = ? AND df.annotation_state = 'DONE'
    ORDER BY df.external_key
  `).all(projectId) as ExportRow[];

  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const exportName = `export_${stamp}`;
  const exportRoot = path.join(annotationStorageRoot(), 'exports', projectId, exportName);
  const masksRoot = path.join(exportRoot, 'masks');
  await mkdir(/* turbopackIgnore: true */ masksRoot, { recursive: true });
  const breakpointLines: string[] = [];
  const manifestLines: string[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const row of rows) {
    try {
      const segmentation = JSON.parse(row.segmentation_json) as { humanAction: string; maskStorageKey?: string };
      const breakpoints = JSON.parse(row.breakpoints_json) as { state: string; points: Array<{ x: number; y: number }> };
      let mask: Uint8Array;
      if (segmentation.maskStorageKey) {
        mask = await readStoredMask(segmentation.maskStorageKey);
      } else {
        try {
          const localPath = path.isAbsolute(row.prediction_ref)
            ? row.prediction_ref
            : path.join(process.cwd(), 'data', row.prediction_ref);
          mask = await readFile(/* turbopackIgnore: true */ localPath);
        } catch {
          mask = await fetchDriveAsset(row.prediction_ref);
        }
      }
      const maskFilename = `${safeFilename(row.external_key)}.png`;
      await writeFile(/* turbopackIgnore: true */ path.join(masksRoot, maskFilename), mask);
      breakpointLines.push(JSON.stringify({ image_id: row.external_key, state: breakpoints.state, points: breakpoints.points }));
      manifestLines.push(JSON.stringify({
        image_id: row.external_key,
        mask: `masks/${maskFilename}`,
        human_action: segmentation.humanAction,
        revision: row.revision,
        version: row.latest_version_number,
      }));
    } catch (error) {
      errors.push({ id: row.external_key, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await Promise.all([
    writeFile(/* turbopackIgnore: true */ path.join(exportRoot, 'breakpoints.jsonl'), breakpointLines.length ? `${breakpointLines.join('\n')}\n` : ''),
    writeFile(/* turbopackIgnore: true */ path.join(exportRoot, 'manifest.jsonl'), manifestLines.length ? `${manifestLines.join('\n')}\n` : ''),
  ]);
  return { exportName, outputPath: exportRoot, exported: manifestLines.length, errors };
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
