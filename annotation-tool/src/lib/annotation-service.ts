import { type AppDatabase, generateId, getDb, hashToken, nowISO } from './db';

interface SaveResult { revision: number; savedAt: string; versionNumber: number }
interface ConflictResult { conflict: true; serverRevision: number }

export const SAVE_VERSION_LABEL = 'Bản lưu';
export const DONE_VERSION_LABEL = 'Hoàn tất';

/**
 * Mỗi lần lưu thành công trở thành version mới nhất (đầu danh sách, là bản chính).
 * Cùng một người lưu tiếp liền mạch — version mới nhất là "Bản lưu" của họ và vẫn đúng bằng dữ
 * liệu trước lần lưu này — thì cập nhật tại chỗ để không sinh hàng trăm version giống nhau.
 */
async function recordVersion(
  tx: AppDatabase,
  file: Record<string, unknown>,
  previousSegmentationJson: string | undefined,
  userId: string,
  baseRevision: number,
  segJson: string,
  bpJson: string,
  now: string,
  label: string,
): Promise<number> {
  const assetJson = JSON.stringify({ image: file.image_drive_file_id, prediction: file.prediction_drive_file_id, width: file.width, height: file.height });
  const latest = await tx.prepare(`SELECT id, version_number, version_label, created_by, segmentation_json
    FROM annotation_versions WHERE dataset_file_id = ? ORDER BY version_number DESC LIMIT 1`).get(file.id);
  const continuing = Boolean(latest && previousSegmentationJson !== undefined
    && latest.version_label === SAVE_VERSION_LABEL && latest.created_by === userId
    && latest.segmentation_json === previousSegmentationJson);
  if (continuing) {
    await tx.prepare(`UPDATE annotation_versions SET base_revision = ?, segmentation_json = ?, breakpoints_json = ?,
      created_at = ?, asset_snapshot_json = ?, version_label = ? WHERE id = ?`)
      .run(baseRevision, segJson, bpJson, now, assetJson, label, latest!.id);
    return Number(latest!.version_number);
  }
  const versionNumber = Number(file.latest_version_number) + 1;
  await tx.prepare(`INSERT INTO annotation_versions
    (id, dataset_file_id, version_number, base_revision, segmentation_json, breakpoints_json, created_by, created_at, asset_snapshot_json, version_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    generateId(), file.id, versionNumber, baseRevision, segJson, bpJson, userId, now, assetJson, label,
  );
  return versionNumber;
}

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
    const versionNumber = await recordVersion(tx, file, current?.segmentation_json, userId, baseRevision, segJson, bpJson, now, SAVE_VERSION_LABEL);
    await tx.prepare(`UPDATE dataset_files SET latest_revision = ?, latest_version_number = ?, annotation_state = 'DRAFT', updated_at = ? WHERE id = ?`)
      .run(newRevision, Math.max(versionNumber, Number(file.latest_version_number)), now, fileId);
    await tx.prepare('UPDATE annotation_sessions SET last_activity_at = ? WHERE id = ?')
      .run(now, lock!.session_id);
    return { revision: newRevision, savedAt: now, versionNumber };
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
    // Hoàn tất ngay sau "Bản lưu" của chính người đó: đổi version đó thành "Hoàn tất" thay vì tạo bản trùng.
    const newVersionNumber = await recordVersion(tx, file, current?.segmentation_json, userId, baseRevision, segJson, bpJson, now, DONE_VERSION_LABEL);
    await tx.prepare(`UPDATE dataset_files SET latest_revision = ?, latest_version_number = ?,
      annotation_state = 'DONE', updated_at = ? WHERE id = ?`)
      .run(newRevision, Math.max(newVersionNumber, Number(file.latest_version_number)), now, fileId);
    await tx.prepare(`UPDATE annotation_sessions SET closed_at = ?, close_reason = 'DONE'
      WHERE id = ? AND closed_at IS NULL`).run(now, lock!.session_id);
    await tx.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);

    return { revision: newRevision, versionNumber: newVersionNumber, annotationState: 'DONE', lockState: 'AVAILABLE' };
  });
}

/** Dòng bảng annotations -> DTO. Tách riêng để nơi khác lấy kèm bằng JOIN cũng dùng được. */
export function mapAnnotationRow(row: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!row || row.segmentation_json == null) return null;
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

export async function getAnnotation(fileId: string): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  return mapAnnotationRow(await db.prepare('SELECT * FROM annotations WHERE dataset_file_id = ?').get(fileId));
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
  const { maskUploadRef: _uploadRef, ...submitted } = segmentation;
  void _uploadRef;
  return {
    ...previous,
    ...submitted,
    wartPoints: segmentation.wartPoints ?? previous.wartPoints,
    sourcePredictionDriveFileId: file.prediction_drive_file_id,
    humanAction: segmentation.humanAction,
    maskStorageKey: undefined,
    // New operations without an uploaded PNG describe the mask themselves: an older stored PNG is
    // stale and must not be served as the current mask (reopening would show the old drawing).
    ...(segmentation.humanAction === 'MODIFIED'
      && (segmentation.maskUploadRef || (!Array.isArray(segmentation.maskOperations) && previous.maskStorageKey))
      ? { maskStorageKey: segmentation.maskUploadRef || previous.maskStorageKey }
      : {}),
    ...(maskOperations
      ? { maskOperations }
      : {}),
  };
}
