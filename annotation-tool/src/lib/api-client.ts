/**
 * API client for the annotation tool.
 * Client-side only — used in React components.
 */

import type {
  FileListItem, PaginatedResponse, LockAcquireResponse,
  HeartbeatResponse, EditorBootstrap, SaveDraftRequest,
  SaveDraftResponse, DoneRequest, DoneResponse, ApiError, CurrentUser, ProjectSummary,
  DatasetImportResult, FileGroupList, FileGroupSummary, UserSummary,
} from '@/types';

/**
 * Token khoá phải sống sót qua F5 của chính tab đang sửa: máy chủ chỉ cấp lại
 * đúng phiên cũ khi nhận được token cũ (lock-service.acquireLock), không có
 * token thì chính chủ cũng bị từ chối cho tới khi khoá hết hạn.
 *
 * sessionStorage đúng phạm vi cần: sống qua reload, nhưng tab mới có kho riêng
 * nên vẫn không lấy được quyền sửa — không cho hai tab chỉnh sửa chung.
 */
const LOCK_TOKEN_KEY = 'annotation-lock-token:';
const lockTokens = new Map<string, string>();
const lockRequests = new Map<string, Promise<LockAcquireResponse>>();

function getLockToken(fileId: string) {
  const cached = lockTokens.get(fileId);
  if (cached || !fileId || typeof window === 'undefined') return cached;
  try {
    const stored = sessionStorage.getItem(LOCK_TOKEN_KEY + fileId) || undefined;
    if (stored) lockTokens.set(fileId, stored);
    return stored;
  } catch {
    return undefined;
  }
}

function rememberLockToken(fileId: string, token: string) {
  lockTokens.set(fileId, token);
  try { sessionStorage.setItem(LOCK_TOKEN_KEY + fileId, token); } catch { /* chế độ riêng tư */ }
}

function forgetLockToken(fileId: string) {
  lockTokens.delete(fileId);
  try { sessionStorage.removeItem(LOCK_TOKEN_KEY + fileId); } catch { /* chế độ riêng tư */ }
}

/** Platform errors (e.g. Vercel's 413) come back as plain text, not our JSON error shape. */
function httpError(status: number): ApiError {
  return {
    code: 'UNKNOWN',
    message: status === 413
      ? 'Dữ liệu gửi lên vượt giới hạn kích thước của máy chủ (HTTP 413). Bản vẽ vẫn được giữ trên thiết bị.'
      : `HTTP ${status}`,
  };
}

// Vercel rejects request bodies over ~4.5 MB; keep a margin for headers.
const MAX_REQUEST_BYTES = 4_400_000;
const COMPRESS_FROM_BYTES = 256_000;
// Must match MAX_CHUNK_BYTES / MAX_CHUNKS in request-body.ts.
const CHUNK_BYTES = 4_000_000;
const MAX_CHUNKS = 16;

/**
 * Annotation JSON (polygons with thousands of nodes and repeated ids) compresses roughly tenfold,
 * so large save bodies are gzipped in the browser and inflated on the server. If the gzipped body
 * is still over the platform limit it is uploaded in parts first and the save request only names
 * the upload (readAnnotationBody assembles it).
 */
async function jsonBody(fileId: string, data: unknown): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  const json = JSON.stringify(data);
  if (json.length < COMPRESS_FROM_BYTES || typeof CompressionStream === 'undefined') {
    return { body: json, headers: {} };
  }
  const compressed = await new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer();
  if (compressed.byteLength <= MAX_REQUEST_BYTES) {
    return { body: compressed, headers: { 'Content-Type': 'application/octet-stream', 'X-Body-Encoding': 'gzip' } };
  }
  const chunks = Math.ceil(compressed.byteLength / CHUNK_BYTES);
  if (chunks > MAX_CHUNKS) {
    throw {
      code: 'INVALID_ANNOTATION',
      message: `Dữ liệu polygon quá lớn để lưu (${(compressed.byteLength / 1_048_576).toFixed(1)} MB sau khi nén). Hãy gộp hoặc xóa bớt vùng nhỏ rồi lưu lại; bản vẽ vẫn được giữ trên thiết bị.`,
    } satisfies ApiError;
  }
  const uploadId = crypto.randomUUID();
  const lockToken = getLockToken(fileId);
  for (let index = 0; index < chunks; index += 1) {
    const response = await fetch(`/api/files/${fileId}/upload-chunks?uploadId=${uploadId}&index=${index}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', ...(lockToken ? { 'X-Annotation-Lock-Token': lockToken } : {}) },
      body: compressed.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
    });
    if (!response.ok) throw await response.json().catch(() => httpError(response.status));
  }
  return { body: '', headers: { 'X-Body-Encoding': 'gzip', 'X-Body-Upload': uploadId, 'X-Body-Chunks': String(chunks) } };
}

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const token = getLockToken(url.match(/\/api\/files\/([^/]+)/)?.[1] || '');
  if (token) headers['X-Annotation-Lock-Token'] = token;

  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });

  if (!res.ok) {
    const error: ApiError = await res.json().catch(() => httpError(res.status));
    throw error;
  }

  return res.json();
}

// ─── Auth ───────────────────────────────────────────────

export async function login(username: string, password: string) {
  return apiFetch<{ user: CurrentUser }>(
    '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }
  );
}

export async function getMe() {
  return apiFetch<CurrentUser>('/api/auth/me');
}

export async function logout() {
  return apiFetch<{ loggedOut: true }>('/api/auth/logout', { method: 'POST' });
}

// ─── Projects ───────────────────────────────────────────

export async function getProjects() {
  return apiFetch<ProjectSummary[]>('/api/projects');
}

export async function createProject(name: string, driveFolderId: string, exportDriveFolderId: string) {
  return apiFetch<ProjectSummary>('/api/projects', {
    method: 'POST', body: JSON.stringify({ name, driveFolderId, exportDriveFolderId }),
  });
}

/** Dự án nhận dữ liệu bằng cách tải thư mục lên, không có nguồn manifest để đồng bộ. */
export async function createUploadProject(name: string) {
  return apiFetch<ProjectSummary>('/api/projects', {
    method: 'POST', body: JSON.stringify({ name, source: 'upload' }),
  });
}

/** Một ảnh mỗi request (multipart) để nằm dưới giới hạn body ~4.5 MB của Vercel. */
export async function importDatasetItem(projectId: string, form: FormData) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/import`, {
    method: 'POST', body: form, credentials: 'same-origin',
  });
  if (!response.ok) throw await response.json().catch(() => httpError(response.status));
  return response.json() as Promise<DatasetImportResult>;
}

// ─── Groups ─────────────────────────────────────────────

export async function getGroups(projectId: string) {
  return apiFetch<FileGroupList>(`/api/projects/${encodeURIComponent(projectId)}/groups`);
}

export async function setGroupAssignees(projectId: string, groupId: string, userIds: string[]) {
  return apiFetch<{ assignees: FileGroupSummary['assignees'] }>(
    `/api/projects/${encodeURIComponent(projectId)}/groups/${encodeURIComponent(groupId)}/assignees`,
    { method: 'PUT', body: JSON.stringify({ userIds }) },
  );
}

export async function autoGroupProject(projectId: string) {
  return apiFetch<{ groupsCreated: number; filesGrouped: number; skipped: number }>(
    `/api/projects/${encodeURIComponent(projectId)}/groups/auto`, { method: 'POST' },
  );
}

export async function getUsers() {
  return apiFetch<UserSummary[]>('/api/users');
}

export async function syncProject(projectId: string) {
  return apiFetch<{ added: number; updated: number; missing: number; errors: Array<{ id: string; message: string }> }>(
    `/api/projects/${projectId}/sync-drive`, { method: 'POST' },
  );
}

export async function exportProject(projectId: string) {
  return apiFetch<{ driveFolderId: string; driveFolderUrl: string; exported: number; updated: number; skipped: number; errors: Array<{ id: string; message: string }> }>(
    `/api/projects/${projectId}/export`, { method: 'POST' },
  );
}

export function projectExportDownloadUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/export`;
}

export interface GoogleDriveConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountEmail?: string | null;
}

export function getGoogleDriveConnectionStatus() {
  return apiFetch<GoogleDriveConnectionStatus>('/api/google/status');
}

export async function disconnectGoogleDrive(): Promise<void> {
  await apiFetch<{ connected: false }>('/api/google/status', { method: 'DELETE' });
}

export async function createUser(data: { displayName: string; email?: string; password: string; role: string }) {
  return apiFetch<CurrentUser>('/api/users', { method: 'POST', body: JSON.stringify(data) });
}

// ─── Files ──────────────────────────────────────────────

export async function getFiles(projectId: string, params?: Record<string, string>) {
  const query = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch<PaginatedResponse<FileListItem>>(`/api/projects/${projectId}/files${query}`);
}

// ─── Lock ───────────────────────────────────────────────

export async function acquireLock(fileId: string) {
  const pending = lockRequests.get(fileId);
  if (pending) return pending;
  const request = apiFetch<LockAcquireResponse>(`/api/files/${fileId}/lock`, { method: 'POST' })
    .then((result) => { rememberLockToken(fileId, result.lockToken); return result; })
    .catch((error: ApiError) => {
      // Token cũ đã vô nghĩa (khoá thuộc người khác hoặc đã hết hạn rồi bị lấy mất).
      if (error?.code === 'FILE_LOCKED') forgetLockToken(fileId);
      throw error;
    })
    .finally(() => lockRequests.delete(fileId));
  lockRequests.set(fileId, request);
  return request;
}

export async function sendHeartbeat(fileId: string) {
  return apiFetch<HeartbeatResponse>(`/api/files/${fileId}/lock/heartbeat`, { method: 'POST' });
}

export async function releaseLock(fileId: string) {
  try {
    await apiFetch<{ released: boolean }>(`/api/files/${fileId}/lock`, { method: 'DELETE' });
  } finally {
    forgetLockToken(fileId);
  }
}

// ─── Editor ─────────────────────────────────────────────

export async function getEditorData(fileId: string) {
  return apiFetch<EditorBootstrap>(`/api/files/${fileId}/editor`);
}

export async function uploadMask(fileId: string, mask: Blob) {
  const headers: Record<string, string> = {};
  const token = getLockToken(fileId);
  if (token) headers['X-Annotation-Lock-Token'] = token;
  const response = await fetch(`/api/files/${fileId}/mask`, {
    method: 'POST', body: mask, headers, credentials: 'same-origin',
  });
  if (!response.ok) throw await response.json().catch(() => httpError(response.status));
  return response.json() as Promise<{ maskUploadRef: string }>;
}

// ─── Annotation ─────────────────────────────────────────

export async function saveDraft(fileId: string, data: SaveDraftRequest) {
  const { body, headers } = await jsonBody(fileId, data);
  return apiFetch<SaveDraftResponse>(`/api/files/${fileId}/annotation`, {
    method: 'PATCH',
    body,
    headers,
  });
}

export async function submitDone(fileId: string, data: DoneRequest) {
  const { body, headers } = await jsonBody(fileId, data);
  const result = await apiFetch<DoneResponse>(`/api/files/${fileId}/done`, {
    method: 'POST',
    body,
    headers,
  });
  forgetLockToken(fileId);
  return result;
}

// ─── Seed ───────────────────────────────────────────────

export async function seedDatabase() {
  return apiFetch<{ message: string; users: number; files: number; projectId: string }>(
    '/api/seed', { method: 'POST' }
  );
}
