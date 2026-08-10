/**
 * Annotation service — draft saves and Done versioning per spec 03 §9, §12.
 */

import { getDb, generateId, nowISO } from './db';

interface SaveResult {
  revision: number;
  savedAt: string;
}

interface ConflictResult {
  conflict: true;
  serverRevision: number;
}

export function saveDraft(
  fileId: string,
  userId: string,
  baseRevision: number,
  segmentation: Record<string, unknown>,
  breakpoints: Record<string, unknown>,
): SaveResult | ConflictResult | null {
  const db = getDb();

  return db.transaction(() => {
    const file = db.prepare('SELECT * FROM dataset_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
    if (!file) return null;

    // Revision check
    if ((file.latest_revision as number) !== baseRevision) {
      return { conflict: true, serverRevision: file.latest_revision as number } as ConflictResult;
    }

    const now = nowISO();
    const newRevision = (file.latest_revision as number) + 1;
    const currentAnnotation = db.prepare('SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?')
      .get(fileId) as { segmentation_json: string } | undefined;
    const previousSegmentation = currentAnnotation
      ? JSON.parse(currentAnnotation.segmentation_json) as Record<string, unknown>
      : {};
    const normalizedSegmentation = {
      sourcePredictionDriveFileId: file.prediction_drive_file_id,
      humanAction: segmentation.humanAction,
      ...(segmentation.maskUploadRef || previousSegmentation.maskStorageKey
        ? { maskStorageKey: segmentation.maskUploadRef || previousSegmentation.maskStorageKey }
        : {}),
      ...(Array.isArray(segmentation.maskOperations) ? { maskOperations: segmentation.maskOperations } : {}),
    };
    const segJson = JSON.stringify(normalizedSegmentation);
    const bpJson = JSON.stringify(breakpoints);

    // Upsert annotation
    const existing = db.prepare('SELECT 1 FROM annotations WHERE dataset_file_id = ?').get(fileId);
    if (existing) {
      db.prepare(`
        UPDATE annotations SET revision = ?, segmentation_json = ?, breakpoints_json = ?,
        last_edited_by = ?, updated_at = ?, status = 'DRAFT'
        WHERE dataset_file_id = ?
      `).run(newRevision, segJson, bpJson, userId, now, fileId);
    } else {
      db.prepare(`
        INSERT INTO annotations (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by, updated_at)
        VALUES (?, ?, 'DRAFT', ?, ?, ?, ?)
      `).run(fileId, newRevision, segJson, bpJson, userId, now);
    }

    // Update file metadata
    db.prepare(`
      UPDATE dataset_files SET latest_revision = ?, annotation_state = 'DRAFT', updated_at = ?
      WHERE id = ?
    `).run(newRevision, now, fileId);

    // Update session activity
    const lock = db.prepare('SELECT session_id FROM file_locks WHERE dataset_file_id = ?').get(fileId) as Record<string, unknown> | undefined;
    if (lock) {
      db.prepare('UPDATE annotation_sessions SET last_activity_at = ? WHERE id = ?')
        .run(now, lock.session_id as string);
    }

    return { revision: newRevision, savedAt: now } as SaveResult;
  })();
}

export function submitDone(
  fileId: string,
  userId: string,
  baseRevision: number,
  segmentation: Record<string, unknown>,
  breakpoints: Record<string, unknown>,
): { revision: number; versionNumber: number; annotationState: string; lockState: string } | ConflictResult | null {
  const db = getDb();

  return db.transaction(() => {
    const file = db.prepare('SELECT * FROM dataset_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
    if (!file) return null;

    if ((file.latest_revision as number) !== baseRevision) {
      return { conflict: true, serverRevision: file.latest_revision as number } as ConflictResult;
    }

    const now = nowISO();
    const newRevision = (file.latest_revision as number) + 1;
    const newVersionNumber = (file.latest_version_number as number) + 1;
    const currentAnnotation = db.prepare('SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?')
      .get(fileId) as { segmentation_json: string } | undefined;
    const previousSegmentation = currentAnnotation
      ? JSON.parse(currentAnnotation.segmentation_json) as Record<string, unknown>
      : {};
    const normalizedSegmentation = {
      sourcePredictionDriveFileId: file.prediction_drive_file_id,
      humanAction: segmentation.humanAction,
      ...(segmentation.maskUploadRef || previousSegmentation.maskStorageKey
        ? { maskStorageKey: segmentation.maskUploadRef || previousSegmentation.maskStorageKey }
        : {}),
    };
    const segJson = JSON.stringify(normalizedSegmentation);
    const bpJson = JSON.stringify(breakpoints);

    // Persist annotation
    const existing = db.prepare('SELECT 1 FROM annotations WHERE dataset_file_id = ?').get(fileId);
    if (existing) {
      db.prepare(`
        UPDATE annotations SET revision = ?, segmentation_json = ?, breakpoints_json = ?,
        last_edited_by = ?, updated_at = ?, status = 'DONE'
        WHERE dataset_file_id = ?
      `).run(newRevision, segJson, bpJson, userId, now, fileId);
    } else {
      db.prepare(`
        INSERT INTO annotations (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by, updated_at)
        VALUES (?, ?, 'DONE', ?, ?, ?, ?)
      `).run(fileId, newRevision, segJson, bpJson, userId, now);
    }

    // Create immutable version
    db.prepare(`
      INSERT INTO annotation_versions (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), fileId, newVersionNumber, baseRevision, segJson, bpJson, userId, now);

    // Update file state
    db.prepare(`
      UPDATE dataset_files SET latest_revision = ?, latest_version_number = ?,
      annotation_state = 'DONE', updated_at = ?
      WHERE id = ?
    `).run(newRevision, newVersionNumber, now, fileId);

    // Release lock and close session
    const lock = db.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ?').get(fileId) as Record<string, unknown> | undefined;
    if (lock) {
      db.prepare('UPDATE annotation_sessions SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL')
        .run(now, 'DONE', lock.session_id as string);
      db.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);
    }

    return {
      revision: newRevision,
      versionNumber: newVersionNumber,
      annotationState: 'DONE',
      lockState: 'AVAILABLE',
    };
  })();
}

export function getAnnotation(fileId: string): Record<string, unknown> | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM annotations WHERE dataset_file_id = ?').get(fileId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    datasetFileId: row.dataset_file_id,
    revision: row.revision,
    segmentation: JSON.parse(row.segmentation_json as string),
    breakpoints: JSON.parse(row.breakpoints_json as string),
    lastEditedBy: row.last_edited_by,
    updatedAt: row.updated_at,
    status: row.status,
  };
}
