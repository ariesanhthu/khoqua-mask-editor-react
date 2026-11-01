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

  it('gzips large save bodies so they stay under the platform request limit', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    let sent: { headers: Record<string, string>; body: BodyInit | null | undefined } | undefined;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      sent = { headers: (options.headers || {}) as Record<string, string>, body: options.body };
      return { ok: true, json: async () => ({ revision: 1 }) };
    });
    const nodes = Array.from({ length: 20_000 }, (_, i) => ({ id: `mask-g1-r7-w3-0-outer-${i}`, x: i % 997, y: i % 613 }));
    const data = {
      baseRevision: 0,
      segmentation: { humanAction: 'MODIFIED' as const, maskOperations: [{ type: 'POLYGON_SET' as const, polygons: [{ id: 'p', label: 'w1', nodes }] }] },
      breakpoints: { state: 'NOT_ANNOTATED' as const, points: [] },
    };
    await client.saveDraft('file-1', data);
    expect(sent?.headers['X-Body-Encoding']).toBe('gzip');
    expect(sent?.headers['X-Annotation-Lock-Token']).toBe('token-1');
    const raw = JSON.stringify(data);
    const compressed = sent!.body as ArrayBuffer;
    expect(compressed.byteLength).toBeLessThan(raw.length / 4);
    const inflated = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(JSON.parse(inflated)).toEqual(data);
  });

  it('uploads a body that is still too large after gzip in parts, then saves by upload id', async () => {
    const client = await loadClient();
    await client.acquireLock('file-1');
    const sent: Array<{ url: string; headers: Record<string, string>; bytes: number }> = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      const body = options.body;
      sent.push({ url, headers: (options.headers || {}) as Record<string, string>, bytes: body instanceof ArrayBuffer ? body.byteLength : String(body ?? '').length });
      return { ok: true, json: async () => ({ received: true, revision: 1 }) };
    });
    // Random labels barely compress, forcing the gzipped body over the single-request limit.
    // ~10 MB of random base36 gzips to ~6 MB: more than one 4.4 MB request, so it must be split.
    const noise = Array.from({ length: 6_000 }, () => ({ id: crypto.randomUUID(), label: Array.from({ length: 150 }, () => Math.random().toString(36).slice(2)).join(''), nodes: [] }));
    await client.saveDraft('file-1', {
      baseRevision: 0,
      segmentation: { humanAction: 'MODIFIED', maskOperations: [{ type: 'POLYGON_SET', polygons: noise }] },
      breakpoints: { state: 'NOT_ANNOTATED', points: [] },
    });
    const parts = sent.filter((call) => call.url.includes('/upload-chunks'));
    const save = sent.at(-1)!;
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((part) => part.bytes <= 4_000_000 && part.headers['X-Annotation-Lock-Token'] === 'token-1')).toBe(true);
    expect(save.url).toBe('/api/files/file-1/annotation');
    expect(save.bytes).toBe(0);
    expect(save.headers['X-Body-Chunks']).toBe(String(parts.length));
    expect(parts.every((part) => part.url.includes(`uploadId=${save.headers['X-Body-Upload']}`))).toBe(true);
    // Sinh ~10 MB dữ liệu ngẫu nhiên rồi gzip: ~1s khi chạy riêng, 3–4s khi cả bộ test chạy song song,
    // sát ngưỡng mặc định 5s. Thời hạn riêng để test không phụ thuộc số file chạy cùng lúc.
  }, 20_000);

  it('turns a plain-text 413 from the platform into a readable error', async () => {
    const client = await loadClient();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 413, json: async () => { throw new SyntaxError('not json'); } }));
    await expect(client.sendHeartbeat('file-1')).rejects.toMatchObject({ message: expect.stringContaining('413') });
  });

  it('sends dataset imports as multipart without a JSON content type and reports 413 readably', async () => {
    const client = await loadClient();
    const sent: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      sent.push({ url, options });
      return sent.length === 1
        ? { ok: true, json: async () => ({ fileId: 'f', externalKey: 'a', groupId: 'g', groupName: 'A', created: true }) }
        : { ok: false, status: 413, json: async () => { throw new SyntaxError('not json'); } };
    });
    const form = new FormData();
    form.set('meta', JSON.stringify({ externalKey: 'a', group: 'A' }));
    expect(await client.importDatasetItem('project 1', form)).toMatchObject({ created: true });
    expect(sent[0].url).toBe('/api/projects/project%201/import');
    expect(sent[0].options.body).toBe(form);
    expect(sent[0].options.headers).toBeUndefined();
    await expect(client.importDatasetItem('project 1', form)).rejects.toMatchObject({ code: 'UNKNOWN', message: expect.stringContaining('413') });
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
