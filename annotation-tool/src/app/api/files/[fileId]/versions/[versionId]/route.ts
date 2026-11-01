import { activateVersion, deleteVersion, findVersion, requireVersionAdmin, versionAssets } from '@/lib/version-service';

type Context = { params: Promise<{ fileId: string; versionId: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    await requireVersionAdmin(request);
    const { fileId, versionId } = await params;
    const row = await findVersion(fileId, versionId);
    if (!row) return Response.json({ message: 'Không tìm thấy version.' }, { status: 404 });
    const assets = versionAssets(row);
    return Response.json({ id: row.id, versionNumber: row.version_number, label: row.version_label, currentRevision: Number(row.latest_revision),
      width: assets.width, height: assets.height, segmentation: JSON.parse(String(row.segmentation_json)),
      breakpoints: JSON.parse(String(row.breakpoints_json)),
      imageUrl: `/api/files/${fileId}/versions/${versionId}/assets/image`,
      maskUrl: `/api/files/${fileId}/versions/${versionId}/assets/mask`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const user = await requireVersionAdmin(request);
    const { fileId, versionId } = await params;
    const body = await request.json();
    if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) return Response.json({ message: 'Thiếu revision hiện tại.' }, { status: 400 });
    return Response.json(await activateVersion(fileId, versionId, user.userId, body.baseRevision));
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    await requireVersionAdmin(request);
    const { fileId, versionId } = await params;
    const deleted = await deleteVersion(fileId, versionId);
    return Response.json(deleted ? { deleted: true } : { message: 'Không tìm thấy version.' }, { status: deleted ? 200 : 404 });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}
