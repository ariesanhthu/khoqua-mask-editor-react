import { NextResponse } from 'next/server';
import { requireAdminAccount } from '@/lib/access-service';
import { DatasetImportError, importDatasetItem } from '@/lib/dataset-import-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/projects/[projectId]/import — nhập một ảnh của thư mục admin tải lên (chỉ ADMIN).
 * multipart/form-data: `meta` = JSON { externalKey, group }, `image`, `prediction` (PNG, tùy chọn),
 * `prelabel` (JSON hoặc JSON gzip, tùy chọn). Trình duyệt đã đọc manifest/COCO và gửi từng ảnh.
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    await requireAdminAccount(request);
    const { projectId } = await params;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ code: 'INVALID_DATASET', message: 'Request phải là multipart/form-data.' }, { status: 400 });
    }
    let meta: { externalKey?: unknown; group?: unknown };
    try {
      meta = JSON.parse(String(form.get('meta') ?? '')) as typeof meta;
    } catch {
      return NextResponse.json({ code: 'INVALID_DATASET', message: 'Thiếu thông tin ảnh (meta).' }, { status: 400 });
    }
    const image = form.get('image');
    if (!(image instanceof Blob) || typeof meta?.externalKey !== 'string' || typeof meta.group !== 'string') {
      return NextResponse.json({ code: 'INVALID_DATASET', message: 'Thiếu ảnh, tên ảnh hoặc tên nhóm.' }, { status: 400 });
    }
    const bytesOf = async (value: FormDataEntryValue | null) => (
      value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : undefined
    );
    const result = await importDatasetItem(projectId, {
      externalKey: meta.externalKey,
      groupName: meta.group,
      image: new Uint8Array(await image.arrayBuffer()),
      prediction: await bytesOf(form.get('prediction')),
      prelabel: await bytesOf(form.get('prelabel')),
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof DatasetImportError) {
      return NextResponse.json({ code: error.status === 404 ? 'FILE_NOT_FOUND' : 'INVALID_DATASET', message: error.message }, { status: error.status });
    }
    throw error;
  }
}
