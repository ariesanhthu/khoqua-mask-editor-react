import { gunzipSync } from 'node:zlib';
import { getDb } from './db';

/** Client sets this header when it gzipped a large JSON body (see api-client jsonBody). */
export const BODY_ENCODING_HEADER = 'x-body-encoding';
/** Set instead of a body when the gzipped JSON was uploaded in parts via /upload-chunks. */
export const BODY_UPLOAD_HEADER = 'x-body-upload';
export const BODY_CHUNKS_HEADER = 'x-body-chunks';
export const MAX_CHUNKS = 16;
export const MAX_CHUNK_BYTES = 4_000_000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const CHUNK_TTL_MS = 60 * 60 * 1000;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads a JSON request body, transparently gunzipping it when the client compressed it.
 * Vercel rejects request bodies over ~4.5 MB with HTTP 413; annotation JSON with thousands of
 * polygon nodes compresses roughly tenfold. The output cap guards against decompression bombs.
 */
export async function readJsonBody(request: Request, maxBytes = MAX_JSON_BYTES): ReturnType<Request['json']> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const text = request.headers.get(BODY_ENCODING_HEADER) === 'gzip'
    ? gunzipSync(bytes, { maxOutputLength: maxBytes }).toString('utf8')
    : bytes.toString('utf8');
  return JSON.parse(text);
}

/** Stores one part of a gzipped body. Parts are bound to the file and user that uploaded them. */
export async function storeBodyChunk(fileId: string, userId: string, uploadId: string, index: number, bytes: Buffer) {
  if (!UPLOAD_ID.test(uploadId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS
      || bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error('Invalid upload chunk');
  }
  const db = await getDb();
  const now = new Date();
  // Abandoned uploads (closed tab, failed save) must not accumulate.
  await db.prepare('DELETE FROM upload_chunks WHERE created_at < ?').run(new Date(now.getTime() - CHUNK_TTL_MS).toISOString());
  const result = await db.prepare(`INSERT INTO upload_chunks (upload_id, chunk_index, dataset_file_id, user_id, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (upload_id, chunk_index) DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at
    WHERE upload_chunks.dataset_file_id = EXCLUDED.dataset_file_id AND upload_chunks.user_id = EXCLUDED.user_id`)
    .run(uploadId, index, fileId, userId, bytes.toString('base64'), now.toISOString());
  if (!result.changes) throw new Error('Upload id belongs to another file or user');
}

/**
 * Annotation save bodies: plain, gzipped, or gzipped and pre-uploaded in parts. Assembled parts
 * are consumed (deleted) so an upload id cannot be replayed.
 */
export async function readAnnotationBody(request: Request, fileId: string, userId: string, maxBytes = MAX_JSON_BYTES): ReturnType<Request['json']> {
  const uploadId = request.headers.get(BODY_UPLOAD_HEADER);
  if (!uploadId) return readJsonBody(request, maxBytes);
  const count = Number(request.headers.get(BODY_CHUNKS_HEADER));
  if (!UPLOAD_ID.test(uploadId) || !Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
    throw new Error('Invalid chunked upload');
  }
  const db = await getDb();
  const rows = await db.prepare<{ chunk_index: number; data: string }>(`SELECT chunk_index, data FROM upload_chunks
    WHERE upload_id = ? AND dataset_file_id = ? AND user_id = ? ORDER BY chunk_index`).all(uploadId, fileId, userId);
  if (rows.length !== count || rows.some((row, index) => Number(row.chunk_index) !== index)) {
    throw new Error('Upload chunks are missing');
  }
  await db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(uploadId);
  const bytes = Buffer.concat(rows.map((row) => Buffer.from(row.data, 'base64')));
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: maxBytes }).toString('utf8'));
}
