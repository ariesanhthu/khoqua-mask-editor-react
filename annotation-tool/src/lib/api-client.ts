/**
 * API client for the annotation tool.
 * Client-side only — used in React components.
 */

import type {
  FileListItem, PaginatedResponse, LockAcquireResponse,
  HeartbeatResponse, EditorBootstrap, SaveDraftRequest,
  SaveDraftResponse, DoneRequest, DoneResponse, ApiError, CurrentUser, ProjectSummary,
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

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const token = getLockToken(url.match(/\/api\/files\/([^/]+)/)?.[1] || '');
  if (token) headers['X-Annotation-Lock-Token'] = token;

  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });

  if (!res.ok) {
    const error: ApiError = await res.json().catch(() => ({
      code: 'UNKNOWN' as const,
      message: `HTTP ${res.status}`,
    }));
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
  if (!response.ok) throw await response.json();
  return response.json() as Promise<{ maskUploadRef: string }>;
}

// ─── Annotation ─────────────────────────────────────────

export async function saveDraft(fileId: string, data: SaveDraftRequest) {
  return apiFetch<SaveDraftResponse>(`/api/files/${fileId}/annotation`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function submitDone(fileId: string, data: DoneRequest) {
  const result = await apiFetch<DoneResponse>(`/api/files/${fileId}/done`, {
    method: 'POST',
    body: JSON.stringify(data),
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
