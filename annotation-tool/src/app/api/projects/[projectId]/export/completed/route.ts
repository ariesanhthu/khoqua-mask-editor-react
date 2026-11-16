import { Readable } from 'node:stream';
import { requireAuth } from '@/lib/auth';
import { createCompletedProjectExportArchive } from '@/lib/completed-export-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireAuth(request);
    const { projectId } = await params;
    const result = await createCompletedProjectExportArchive(projectId, user.userId);
    if (!result) return Response.json({ code: 'FILE_NOT_FOUND', message: 'Không tìm thấy dự án hoặc bạn chưa được giao nhóm.' }, { status: 404 });
    // Stream the archive: original images can exceed Vercel's buffered response size limit.
    const stream = Readable.toWeb(new Readable().wrap(result.archive.generateNodeStream({ streamFiles: true, compression: 'DEFLATE',
      compressionOptions: { level: 6 } }))) as ReadableStream<Uint8Array>;
    return new Response(stream, { headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ code: 'UNKNOWN', message: error instanceof Error ? error.message : 'Không thể tải ảnh hoàn tất.' }, { status: 502 });
  }
}
