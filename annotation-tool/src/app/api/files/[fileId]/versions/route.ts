import { getDb } from '@/lib/db';
import { requireVersionAdmin, versionAssets } from '@/lib/version-service';

export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    await requireVersionAdmin(request);
    const { fileId } = await params;
    const db = await getDb();
    const file = await db.prepare(`SELECT df.id, df.image_drive_file_id, df.prediction_drive_file_id, df.width, df.height, df.latest_revision,
      fl.expires_at AS lock_expires_at, lu.display_name AS lock_holder
      FROM dataset_files df LEFT JOIN file_locks fl ON fl.dataset_file_id = df.id LEFT JOIN users lu ON lu.id = fl.user_id
      WHERE df.id = ?`).get(fileId);
    if (!file) return Response.json({ message: 'Không tìm thấy ảnh.' }, { status: 404 });
    const rows = await db.prepare(`SELECT v.id, v.version_number AS "versionNumber", v.version_label AS label,
      v.created_at AS "createdAt", u.display_name AS "createdBy", v.asset_snapshot_json,
      (a.dataset_file_id IS NOT NULL AND v.segmentation_json = a.segmentation_json AND v.breakpoints_json = a.breakpoints_json) AS same_data
      FROM annotation_versions v LEFT JOIN users u ON u.id = v.created_by
      LEFT JOIN annotations a ON a.dataset_file_id = v.dataset_file_id
      WHERE v.dataset_file_id = ? ORDER BY v.version_number DESC`).all(fileId);
    // Ban chinh = version moi nhat trung ca du lieu lan crop anh voi ban moi nguoi dang thay.
    // Sua tiep sau khi dat version thi khong con version nao trung: ban chinh la ban dang chinh sua.
    const active = rows.find((row) => {
      if (!row.same_data) return false;
      const assets = versionAssets({ ...file, asset_snapshot_json: row.asset_snapshot_json });
      return assets.image === file.image_drive_file_id && assets.prediction === file.prediction_drive_file_id;
    });
    const locked = Boolean(file.lock_expires_at) && new Date(String(file.lock_expires_at)) > new Date();
    return Response.json({
      versions: rows.map((row) => ({
        id: row.id, versionNumber: row.versionNumber, label: row.label, createdAt: row.createdAt, createdBy: row.createdBy,
        active: row.id === active?.id,
      })),
      current: { revision: Number(file.latest_revision), lockedBy: locked ? String(file.lock_holder || 'người khác') : null },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
