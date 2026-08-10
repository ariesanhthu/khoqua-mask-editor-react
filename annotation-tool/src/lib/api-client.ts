/**
 * API client for the annotation tool.
 * Client-side only — used in React components.
 */

import type {
  FileListItem, PaginatedResponse, LockAcquireResponse,
  HeartbeatResponse, EditorBootstrap, SaveDraftRequest,
  SaveDraftResponse, DoneRequest, DoneResponse, ApiError, CurrentUser, ProjectSummary,
} from '@/types';

let _lockToken: string | null = null;

export function setLockToken(token: string) { _lockToken = token; }
export function getLockToken() { return _lockToken; }

async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (_lockToken) headers['X-Annotation-Lock-Token'] = _lockToken;

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

export async function createProject(name: string, driveFolderId: string) {
  return apiFetch<ProjectSummary>('/api/projects', {
    method: 'POST', body: JSON.stringify({ name, driveFolderId }),
  });
}

export async function syncProject(projectId: string) {
  return apiFetch<{ added: number; updated: number; missing: number; errors: Array<{ id: string; message: string }> }>(
    `/api/projects/${projectId}/sync-drive`, { method: 'POST' },
  );
}

export async function exportProject(projectId: string) {
  return apiFetch<{ exportName: string; outputPath: string; exported: number; errors: Array<{ id: string; message: string }> }>(
    `/api/projects/${projectId}/export`, { method: 'POST' },
  );
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
  const result = await apiFetch<LockAcquireResponse>(`/api/files/${fileId}/lock`, { method: 'POST' });
  setLockToken(result.lockToken);
  return result;
}

export async function sendHeartbeat(fileId: string) {
  return apiFetch<HeartbeatResponse>(`/api/files/${fileId}/lock/heartbeat`, { method: 'POST' });
}

export async function releaseLock(fileId: string) {
  try {
    await apiFetch<{ released: boolean }>(`/api/files/${fileId}/lock`, { method: 'DELETE' });
  } finally {
    _lockToken = null;
  }
}

// ─── Editor ─────────────────────────────────────────────

export async function getEditorData(fileId: string) {
  return apiFetch<EditorBootstrap>(`/api/files/${fileId}/editor`);
}

export async function uploadMask(fileId: string, mask: Blob) {
  const headers: Record<string, string> = {};
  if (_lockToken) headers['X-Annotation-Lock-Token'] = _lockToken;
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
  return apiFetch<DoneResponse>(`/api/files/${fileId}/done`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ─── Seed ───────────────────────────────────────────────

export async function seedDatabase() {
  return apiFetch<{ message: string; users: number; files: number; projectId: string }>(
    '/api/seed', { method: 'POST' }
  );
}
