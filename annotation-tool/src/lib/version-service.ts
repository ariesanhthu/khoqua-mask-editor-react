import { requireAuth } from './auth';
import { generateId, getDb, nowISO } from './db';

export async function requireVersionAdmin(request: Request) {
  const user = await requireAuth(request);
  const db = await getDb();
  const account = await db.prepare('SELECT role FROM users WHERE id = ?').get(user.userId);
  if (account?.role !== 'ADMIN') throw Response.json({ message: 'Chỉ ADMIN được quản lý version.' }, { status: 403 });
  return user;
}

export async function findVersion(fileId: string, versionId: string) {
  const db = await getDb();
  return db.prepare(`SELECT v.*, df.image_drive_file_id, df.prediction_drive_file_id, df.width, df.height, df.latest_revision
    FROM annotation_versions v JOIN dataset_files df ON df.id = v.dataset_file_id
    WHERE v.dataset_file_id = ? AND v.id = ?`).get(fileId, versionId);
}

export async function activateVersion(fileId: string, versionId: string, userId: string, baseRevision: number) {
  const db = await getDb();
  return db.transaction(async tx => {
    const file = await tx.prepare('SELECT * FROM dataset_files WHERE id = ? FOR UPDATE').get(fileId);
    const version = await tx.prepare('SELECT * FROM annotation_versions WHERE dataset_file_id = ? AND id = ?').get(fileId, versionId);
    if (!file || !version) throw Response.json({ message: 'Không tìm thấy version.' }, { status: 404 });
    if (Number(file.latest_revision) !== baseRevision) throw Response.json({ message: 'Bản hiện tại vừa thay đổi. Danh sách đã được tải lại, hãy thử lại.' }, { status: 409 });
    const now = nowISO();
    const lock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);
    if (lock && new Date(String(lock.expires_at)) > new Date() && lock.user_id !== userId) {
      const holder = await tx.prepare('SELECT display_name FROM users WHERE id = ?').get(lock.user_id);
      throw Response.json({
        message: `Ảnh đang được ${String(holder?.display_name || 'người khác')} mở trong editor. Chờ họ đóng editor rồi đặt lại version.`,
      }, { status: 409 });
    }
    if (lock) {
      // Khoa het han, hoac khoa cua chinh ADMIN (vd. editor o tab khac): nha khoa. Tab do se gap
      // LOCK_LOST/xung dot revision o lan luu sau va giu ban nhap local, khong ghi de version vua chon.
      await tx.prepare('UPDATE annotation_sessions SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL')
        .run(now, 'EXPLICIT_RELEASE', lock.session_id);
      await tx.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);
    }
    const current = await tx.prepare('SELECT * FROM annotations WHERE dataset_file_id = ?').get(fileId);
    const assets = versionAssets({ ...file, ...version });
    let number = Number(file.latest_version_number);
    let previousVersionNumber: number | null = null;
    // Chi luu ban dang dung thanh version moi; version duoc chon giu nguyen so cua no de danh sach
    // danh dau dung "dang dung" (khong tao ban sao trung noi dung).
    if (current) {
      number += 1;
      previousVersionNumber = number;
      await tx.prepare(`INSERT INTO annotation_versions (id,dataset_file_id,version_number,base_revision,segmentation_json,breakpoints_json,created_by,created_at,asset_snapshot_json,version_label)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(generateId(), fileId, number, baseRevision, String(current.segmentation_json), String(current.breakpoints_json), userId, now,
        JSON.stringify({ image: file.image_drive_file_id, prediction: file.prediction_drive_file_id, width: file.width, height: file.height }),
        `Bản chính trước khi đặt v${version.version_number}`);
    }
    await tx.prepare(`INSERT INTO annotations (dataset_file_id,revision,status,segmentation_json,breakpoints_json,last_edited_by,updated_at)
      VALUES (?,?,'DRAFT',?,?,?,?) ON CONFLICT(dataset_file_id) DO UPDATE SET revision=excluded.revision,status='DRAFT',segmentation_json=excluded.segmentation_json,
      breakpoints_json=excluded.breakpoints_json,last_edited_by=excluded.last_edited_by,updated_at=excluded.updated_at`)
      .run(fileId,baseRevision+1,String(version.segmentation_json),String(version.breakpoints_json),userId,now);
    await tx.prepare(`UPDATE dataset_files SET latest_revision=?,latest_version_number=?,annotation_state='DRAFT',image_drive_file_id=?,prediction_drive_file_id=?,
      width=?,height=?,image_filename=?,prediction_filename=?,updated_at=? WHERE id=?`)
      .run(baseRevision+1,number,assets.image,assets.prediction,assets.width,assets.height,assets.image.split('/').at(-1),assets.prediction.split('/').at(-1),now,fileId);
    return { revision: baseRevision+1, versionNumber: number, previousVersionNumber };
  });
}

export function versionAssets(row: Record<string, unknown>) {
  return (row.asset_snapshot_json ? JSON.parse(String(row.asset_snapshot_json)) : {
    image: row.image_drive_file_id, prediction: row.prediction_drive_file_id, width: row.width, height: row.height,
  }) as { image: string; prediction: string; width: number; height: number };
}

export async function deleteVersion(fileId: string, versionId: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const file = await tx.prepare('SELECT id FROM dataset_files WHERE id = ? FOR UPDATE').get(fileId);
    if (!file) return false;
    // Only delete the history record; shared assets and the working annotation remain intact.
    const result = await tx.prepare('DELETE FROM annotation_versions WHERE dataset_file_id = ? AND id = ?').run(fileId, versionId);
    // Keep the monotonically increasing counter so deleted version numbers are never reused.
    return result.changes > 0;
  });
}
