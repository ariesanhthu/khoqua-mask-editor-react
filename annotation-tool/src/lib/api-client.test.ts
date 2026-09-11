import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Khoá sửa file là độc quyền: máy chủ chỉ cấp lại đúng phiên cũ khi client gửi
 * kèm token cũ, không có token thì chính chủ cũng chỉ được xem cho tới khi khoá
 * hết hạn (xem lock-service.acquireLock). Vì vậy token phải sống qua F5 của
 * chính tab đó, nhưng tuyệt đối không lộ sang tab khác.
 */

interface FetchCall { url: string; token: string | undefined; method: string | undefined }

let calls: FetchCall[] = [];
let store: Record<string, string> = {};
let nextToken = 1;
let lockDenied = false;

function installBrowserStubs() {
  calls = [];
  store = {};
  nextToken = 1;
  lockDenied = false;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
  });
  vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
    const headers = (options.headers || {}) as Record<string, string>;
    calls.push({ url, token: headers['X-Annotation-Lock-Token'], method: options.method });
    if (url.endsWith('/lock') && options.method === 'POST') {
      if (lockDenied && !headers['X-Annotation-Lock-Token']) {
        return { ok: false, json: async () => ({ code: 'FILE_LOCKED', message: 'locked' }) };
      }
      const lockToken = headers['X-Annotation-Lock-Token'] || `token-${nextToken++}`;
      return { ok: true, json: async () => ({ sessionId: 's', lockToken, expiresAt: 'later', baseRevision: 0 }) };
    }
    return { ok: true, json: async () => ({ released: true, revision: 1 }) };
  });
}

/** Nạp lại module = tải lại trang: bộ nhớ trong module mất, sessionStorage còn. */
async function loadClient() {
  vi.resetModules();
  return import('./api-client');
}

beforeEach(installBrowserStubs);
afterEach(() => vi.unstubAllGlobals());

describe('lock token persistence', () => {
  it('sends the lock token on every write call for that file', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    calls = [];
    await client.saveDraft('file-1', { baseRevision: 0, segmentation: { humanAction: 'ACCEPTED' }, breakpoints: { state: 'NOT_ANNOTATED', points: [] } });
    await client.sendHeartbeat('file-1');
    await client.uploadMask('file-1', new Blob());
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.token === 'token-1')).toBe(true);
  });

  it('keeps the same tab editing after a reload', async () => {
    const first = await loadClient();
    await first.acquireLock('file-1');
    expect(store['annotation-lock-token:file-1']).toBe('token-1');

    // F5: module mới, sessionStorage của tab giữ nguyên.
    const reloaded = await loadClient();
    const result = await reloaded.acquireLock('file-1');
    const reacquire = calls.filter((call) => call.url.endsWith('/lock') && call.method === 'POST').at(-1);
    expect(reacquire?.token).toBe('token-1');
    expect(result.lockToken).toBe('token-1');
  });

  it('does not hand the token to a second tab, so that tab stays read-only', async () => {
    const firstTab = await loadClient();
    await firstTab.acquireLock('file-1');
    lockDenied = true;

    // Tab thứ hai: sessionStorage riêng, rỗng.
    store = {};
    const secondTab = await loadClient();
    await expect(secondTab.acquireLock('file-1')).rejects.toMatchObject({ code: 'FILE_LOCKED' });
    expect(calls.at(-1)?.token).toBeUndefined();
  });

  it('drops a token the server refuses so it is not retried forever', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    lockDenied = true;
    store['annotation-lock-token:file-1'] = 'stale';
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      const headers = (options.headers || {}) as Record<string, string>;
      calls.push({ url, token: headers['X-Annotation-Lock-Token'], method: options.method });
      return { ok: false, json: async () => ({ code: 'FILE_LOCKED', message: 'locked' }) };
    });
    const reloaded = await loadClient();
    await expect(reloaded.acquireLock('file-1')).rejects.toMatchObject({ code: 'FILE_LOCKED' });
    expect(store['annotation-lock-token:file-1']).toBeUndefined();
  });

  it('clears the token when the lock is released or the file is submitted', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    await client.releaseLock('file-1');
    expect(store['annotation-lock-token:file-1']).toBeUndefined();

    await client.acquireLock('file-2');
    await client.submitDone('file-2', { baseRevision: 0, annotation: { segmentation: { humanAction: 'ACCEPTED' }, breakpoints: { state: 'NOT_ANNOTATED', points: [] } } });
    expect(store['annotation-lock-token:file-2']).toBeUndefined();
  });

  it('keeps tokens of different files apart', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    await client.acquireLock('file-2');
    calls = [];
    await client.sendHeartbeat('file-2');
    expect(calls.at(-1)?.token).toBe('token-2');
  });
});
