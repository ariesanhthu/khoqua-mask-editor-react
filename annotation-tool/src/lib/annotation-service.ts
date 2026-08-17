import { generateId, getDb, hashToken, nowISO } from './db';

interface SaveResult { revision: number; savedAt: string }
interface ConflictResult { conflict: true; serverRevision: number }

export async function saveDraft(
  fileId: string,
  userId: string,
  lockToken: string,
  baseRevision: number,
  segmentation: Record<string, unknown>,
  breakpoints: Record<string, unknown>,
): Promise<SaveResult | ConflictResult | null | 'LOCK_LOST'> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const file = await tx.prepare('SELECT * FROM dataset_files WHERE id = ? FOR UPDATE').get(fileId);
    if (!file) return null;
    const lock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);
    if (!validOwnedLock(lock, userId, lockToken)) return 'LOCK_LOST';
    if (Number(file.latest_revision) !== baseRevision) {
      return { conflict: true, serverRevision: Number(file.latest_revision) };
    }

    const now = nowISO();
    const newRevision = Number(file.latest_revision) + 1;
    const current = await tx.prepare<{ segmentation_json: string }>(
      'SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?',
    ).get(fileId);
    const previous = current ? JSON.parse(current.segmentation_json) as Record<string, unknown> : {};
    const normalized = normalizeSegmentation(file, segmentation, previous);
    const segJson = JSON.stringify(normalized);
    const bpJson = JSON.stringify(breakpoints);

    await tx.prepare(`INSERT INTO annotations
      (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by, updated_at)
      VALUES (?, ?, 'DRAFT', ?, ?, ?, ?)
      ON CONFLICT (dataset_file_id) DO UPDATE SET revision = EXCLUDED.revision,
        status = 'DRAFT', segmentation_json = EXCLUDED.segmentation_json,
        breakpoints_json = EXCLUDED.breakpoints_json, last_edited_by = EXCLUDED.last_edited_by,
        updated_at = EXCLUDED.updated_at`).run(fileId, newRevision, segJson, bpJson, userId, now);
    await tx.prepare(`UPDATE dataset_files SET latest_revision = ?, annotation_state = 'DRAFT', updated_at = ? WHERE id = ?`)
      .run(newRevision, now, fileId);
    await tx.prepare('UPDATE annotation_sessions SET last_activity_at = ? WHERE id = ?')
      .run(now, lock!.session_id);
    return { revision: newRevision, savedAt: now };
  });
}

export async function submitDone(
  fileId: string,
  userId: string,
  lockToken: string,
  baseRevision: number,
  segmentation: Record<string, unknown>,
  breakpoints: Record<string, unknown>,
): Promise<{ revision: number; versionNumber: number; annotationState: string; lockState: string } | ConflictResult | null | 'LOCK_LOST'> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const file = await tx.prepare('SELECT * FROM dataset_files WHERE id = ? FOR UPDATE').get(fileId);
    if (!file) return null;
    const lock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);
    if (!validOwnedLock(lock, userId, lockToken)) return 'LOCK_LOST';
    if (Number(file.latest_revision) !== baseRevision) {
      return { conflict: true, serverRevision: Number(file.latest_revision) };
    }

    const now = nowISO();
    const newRevision = Number(file.latest_revision) + 1;
    const newVersionNumber = Number(file.latest_version_number) + 1;
    const current = await tx.prepare<{ segmentation_json: string }>(
      'SELECT segmentation_json FROM annotations WHERE dataset_file_id = ?',
    ).get(fileId);
    const previous = current ? JSON.parse(current.segmentation_json) as Record<string, unknown> : {};
    const segJson = JSON.stringify(normalizeSegmentation(file, segmentation, previous));
    const bpJson = JSON.stringify(breakpoints);

    await tx.prepare(`INSERT INTO annotations
      (dataset_file_id, revision, status, segmentation_json, breakpoints_json, last_edited_by, updated_at)
      VALUES (?, ?, 'DONE', ?, ?, ?, ?)
      ON CONFLICT (dataset_file_id) DO UPDATE SET revision = EXCLUDED.revision,
        status = 'DONE', segmentation_json = EXCLUDED.segmentation_json,
        breakpoints_json = EXCLUDED.breakpoints_json, last_edited_by = EXCLUDED.last_edited_by,
        updated_at = EXCLUDED.updated_at`).run(fileId, newRevision, segJson, bpJson, userId, now);
    await tx.prepare(`INSERT INTO annotation_versions
      (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generateId(), fileId, newVersionNumber, baseRevision, segJson, bpJson, userId, now,
    );
    await tx.prepare(`UPDATE dataset_files SET latest_revision = ?, latest_version_number = ?,
      annotation_state = 'DONE', updated_at = ? WHERE id = ?`)
      .run(newRevision, newVersionNumber, now, fileId);
    await tx.prepare(`UPDATE annotation_sessions SET closed_at = ?, close_reason = 'DONE'
      WHERE id = ? AND closed_at IS NULL`).run(now, lock!.session_id);
    await tx.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);

    return { revision: newRevision, versionNumber: newVersionNumber, annotationState: 'DONE', lockState: 'AVAILABLE' };
  });
}

export async function getAnnotation(fileId: string): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const row = await db.prepare('SELECT * FROM annotations WHERE dataset_file_id = ?').get(fileId);
  if (!row) return null;
  return {
    datasetFileId: row.dataset_file_id,
    revision: Number(row.revision),
    segmentation: JSON.parse(row.segmentation_json as string),
    breakpoints: JSON.parse(row.breakpoints_json as string),
    lastEditedBy: row.last_edited_by,
    updatedAt: row.updated_at,
    status: row.status,
  };
}

function validOwnedLock(lock: Record<string, unknown> | undefined, userId: string, token: string): boolean {
  return Boolean(lock && lock.user_id === userId && lock.lock_token_hash === hashToken(token) &&
    new Date(lock.expires_at as string) > new Date());
}

function normalizeSegmentation(
  file: Record<string, unknown>,
  segmentation: Record<string, unknown>,
  previous: Record<string, unknown>,
) {
  const maskOperations = Array.isArray(segmentation.maskOperations)
    ? segmentation.maskOperations
    : Array.isArray(previous.maskOperations)
      ? previous.maskOperations
      : undefined;
  return {
    sourcePredictionDriveFileId: file.prediction_drive_file_id,
    humanAction: segmentation.humanAction,
    ...(segmentation.maskUploadRef || previous.maskStorageKey
      ? { maskStorageKey: segmentation.maskUploadRef || previous.maskStorageKey }
      : {}),
    ...(maskOperations
      ? { maskOperations }
      : {}),
  };
}
