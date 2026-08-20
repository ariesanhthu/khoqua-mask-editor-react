import 'server-only';

import { access, readFile } from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { importPKCS8, SignJWT } from 'jose';
import { get as getBlob } from '@vercel/blob';
import { getDb, generateId, nowISO } from './db';
import { getGoogleOAuthAccessToken } from './google-oauth';

interface ManifestItem {
  id: string;
  image: string;
  prediction: string;
  prelabel?: string;
  width?: number;
  height?: number;
}

interface DatasetManifest {
  dataset_version?: string;
  algorithm_version?: string;
  items: ManifestItem[];
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

export function normalizeDriveFolderId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] || trimmed;
}

async function serviceAccountConfig(): Promise<ServiceAccount> {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON chưa được cấu hình.');
  let json: string;
  if (raw.trim().startsWith('{')) {
    json = raw;
  } else {
    try {
      json = await readFile(path.resolve(raw), 'utf8');
    } catch {
      throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON phải là chuỗi JSON hoặc đường dẫn tới file JSON tồn tại.');
    }
  }
  const account = JSON.parse(json) as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new Error('Service account Google Drive thiếu client_email hoặc private_key.');
  }
  return account as ServiceAccount;
}

export async function getDriveAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }
  const account = await serviceAccountConfig();
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(account.private_key, 'RS256');
  const assertion = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/drive',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setAudience(account.token_uri || 'https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Không thể xác thực Google Drive (${response.status}).`);
  const payload = await response.json() as { access_token: string; expires_in?: number };
  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
  };
  return payload.access_token;
}

class DriveHttpError extends Error {
  constructor(readonly status: number, readonly reason?: string, message?: string) {
    super(message || `Google Drive trả về lỗi ${status}.`);
  }
}

async function driveHttpError(response: Response): Promise<DriveHttpError> {
  let reason: string | undefined;
  let message: string | undefined;
  try {
    const payload = await response.json() as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    reason = payload.error?.errors?.[0]?.reason;
    message = payload.error?.message;
  } catch {
    // Google occasionally returns a non-JSON proxy error.
  }
  return new DriveHttpError(response.status, reason, message);
}

async function driveRequestWithToken<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await driveHttpError(response);
  return response.json() as Promise<T>;
}

async function listDriveChildrenWithToken(
  folderId: string,
  accessToken: string,
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const files: Array<{ id: string; name: string; mimeType: string }> = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await driveRequestWithToken<{
      nextPageToken?: string;
      files: Array<{ id: string; name: string; mimeType: string }>;
    }>(`https://www.googleapis.com/drive/v3/files?${query}`, accessToken);
    files.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function listDriveChildren(folderId: string) {
  return listDriveChildrenWithToken(folderId, await getDriveAccessToken());
}

async function downloadDriveFileWithToken(fileId: string, accessToken: string): Promise<Uint8Array> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw await driveHttpError(response);
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadDriveFile(fileId: string): Promise<Uint8Array> {
  return downloadDriveFileWithToken(fileId, await getDriveAccessToken());
}

export async function fetchDriveAsset(fileId: string): Promise<Uint8Array> {
  return downloadDriveFile(fileId);
}

export async function fetchDatasetAsset(reference: string): Promise<Uint8Array> {
  if (reference.startsWith('blob:')) {
    const pathname = reference.slice('blob:'.length).replace(/^\/+/, '');
    if (!pathname || pathname.includes('..')) throw new Error('Blob reference không hợp lệ.');
    const result = await getBlob(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) throw new Error('Không tải được private Blob asset.');
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }
  if (/^https:\/\//i.test(reference)) {
    const response = await fetch(reference, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Không tải được asset nguồn (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (path.isAbsolute(reference)) return new Uint8Array(await readFile(reference));
  return downloadDriveFile(reference);
}

function destinationError(error: unknown): Error {
  if (error instanceof DriveHttpError && error.reason === 'accessNotConfigured') {
    return new Error('Google Drive API chưa được bật trong Google Cloud project của OAuth. Hãy bật Drive API rồi thử lại sau vài phút.');
  }
  if (error instanceof DriveHttpError && error.status === 403) {
    const detail = error.reason ? ` (${error.reason})` : '';
    return new Error(`Tài khoản Google đã kết nối không có quyền ghi vào thư mục Drive đích${detail}.`);
  }
  if (error instanceof DriveHttpError && error.status === 404) {
    return new Error('Không tìm thấy thư mục Drive đích hoặc tài khoản hiện tại không có quyền truy cập.');
  }
  return error instanceof Error ? error : new Error('Thao tác Google Drive không thành công.');
}

export async function inspectDriveDestination(folderValue: string): Promise<{
  scopeIncludesDrive: boolean;
  scopes: string[];
  folder: {
    id: string;
    name: string;
    mimeType: string;
    capabilities?: { canEdit?: boolean; canAddChildren?: boolean };
  };
}> {
  const accessToken = await getGoogleOAuthAccessToken();
  const tokenInfoResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    { cache: 'no-store' },
  );
  const tokenInfo = tokenInfoResponse.ok
    ? await tokenInfoResponse.json() as { scope?: string }
    : {};
  const scopes = tokenInfo.scope?.split(/\s+/).filter(Boolean) || [];
  const folderId = normalizeDriveFolderId(folderValue);
  const query = new URLSearchParams({
    fields: 'id,name,mimeType,capabilities(canEdit,canAddChildren)',
    supportsAllDrives: 'true',
  });
  const folder = await driveRequestWithToken<{
    id: string;
    name: string;
    mimeType: string;
    capabilities?: { canEdit?: boolean; canAddChildren?: boolean };
  }>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${query}`, accessToken);
  return {
    scopeIncludesDrive: scopes.includes('https://www.googleapis.com/auth/drive'),
    scopes,
    folder,
  };
}

async function createDriveFolderWithToken(
  name: string,
  parentFolderId: string,
  accessToken: string,
): Promise<string> {
  const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [normalizeDriveFolderId(parentFolderId)],
    }),
  });
  if (!response.ok) throw await driveHttpError(response);
  return ((await response.json()) as { id: string }).id;
}

export async function createDriveFolder(name: string, parentFolderId: string): Promise<string> {
  try {
    return await createDriveFolderWithToken(name, parentFolderId, await getGoogleOAuthAccessToken());
  } catch (error) {
    throw destinationError(error);
  }
}

export async function ensureDriveFolder(name: string, parentFolderId: string): Promise<string> {
  try {
    const token = await getGoogleOAuthAccessToken();
    const normalizedParentId = normalizeDriveFolderId(parentFolderId);
    const existing = (await listDriveChildrenWithToken(normalizedParentId, token)).find((entry) => (
      entry.name === name && entry.mimeType === 'application/vnd.google-apps.folder'
    ));
    return existing?.id || createDriveFolderWithToken(name, normalizedParentId, token);
  } catch (error) {
    throw destinationError(error);
  }
}

export async function readDriveTextFile(name: string, parentFolderId: string): Promise<string | null> {
  try {
    const token = await getGoogleOAuthAccessToken();
    const existing = (await listDriveChildrenWithToken(normalizeDriveFolderId(parentFolderId), token)).find((entry) => (
      entry.name === name && entry.mimeType !== 'application/vnd.google-apps.folder'
    ));
    return existing ? new TextDecoder().decode(await downloadDriveFileWithToken(existing.id, token)) : null;
  } catch (error) {
    throw destinationError(error);
  }
}

async function uploadDriveMultipartWithToken(
  name: string,
  parentFolderId: string,
  bytes: Uint8Array,
  contentType: string,
  accessToken: string,
  existingFileId?: string,
): Promise<string> {
  const boundary = `annotation-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const metadataValue = existingFileId
    ? { name }
    : { name, parents: [normalizeDriveFolderId(parentFolderId)] };
  const metadata = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadataValue)}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(metadata.length + bytes.length + suffix.length);
  body.set(metadata, 0);
  body.set(bytes, metadata.length);
  body.set(suffix, metadata.length + bytes.length);
  const endpoint = existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=multipart&supportsAllDrives=true`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';
  const response = await fetch(endpoint, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) throw await driveHttpError(response);
  return ((await response.json()) as { id: string }).id;
}

export async function uploadDriveFile(
  name: string,
  parentFolderId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  try {
    return await uploadDriveMultipartWithToken(
      name, parentFolderId, bytes, contentType, await getGoogleOAuthAccessToken(),
    );
  } catch (error) {
    throw destinationError(error);
  }
}

export async function upsertDriveFile(
  name: string,
  parentFolderId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ id: string; created: boolean }> {
  try {
    const token = await getGoogleOAuthAccessToken();
    const normalizedParentId = normalizeDriveFolderId(parentFolderId);
    const existing = (await listDriveChildrenWithToken(normalizedParentId, token)).find((entry) => (
      entry.name === name && entry.mimeType !== 'application/vnd.google-apps.folder'
    ));
    return {
      id: await uploadDriveMultipartWithToken(name, normalizedParentId, bytes, contentType, token, existing?.id),
      created: !existing,
    };
  } catch (error) {
    throw destinationError(error);
  }
}

async function loadManifest(folderValue: string): Promise<{
  manifest: DatasetManifest;
  manifestRef: string;
  resolve: (relativePath: string) => Promise<string>;
}> {
  if (folderValue.startsWith('blob:')) {
    const manifestPath = folderValue.slice('blob:'.length).replace(/^\/+/, '');
    if (!manifestPath.endsWith('/manifest.json') || manifestPath.includes('..')) {
      throw new Error('Nguồn private Blob phải là reference blob:.../manifest.json hợp lệ.');
    }
    const manifest = JSON.parse(new TextDecoder().decode(await fetchDatasetAsset(folderValue))) as DatasetManifest;
    const basePath = manifestPath.slice(0, -'manifest.json'.length);
    return {
      manifest,
      manifestRef: folderValue,
      resolve: async (relativePath) => {
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
          throw new Error(`Đường dẫn asset không hợp lệ: ${relativePath}`);
        }
        return `blob:${basePath}${relativePath}`;
      },
    };
  }

  if (/^https:\/\//i.test(folderValue)) {
    const manifestUrl = new URL(folderValue);
    if (!manifestUrl.pathname.endsWith('/manifest.json')) {
      throw new Error('Nguồn Vercel Blob phải là URL đầy đủ tới manifest.json.');
    }
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Không tải được manifest từ Vercel Blob (${response.status}).`);
    const manifest = await response.json() as DatasetManifest;
    const baseUrl = new URL('.', manifestUrl);
    return {
      manifest,
      manifestRef: manifestUrl.toString(),
      resolve: async (relativePath) => {
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
          throw new Error(`Đường dẫn asset không hợp lệ: ${relativePath}`);
        }
        const resolved = new URL(relativePath, baseUrl);
        if (resolved.origin !== baseUrl.origin || !resolved.pathname.startsWith(baseUrl.pathname)) {
          throw new Error(`Asset nằm ngoài dataset Blob: ${relativePath}`);
        }
        return resolved.toString();
      },
    };
  }

  const localRoot = path.resolve(folderValue);
  try {
    await access(localRoot);
    const manifestPath = path.join(localRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatasetManifest;
    return {
      manifest,
      manifestRef: manifestPath,
      resolve: async (relativePath) => {
        const resolved = path.resolve(localRoot, ...relativePath.split('/'));
        if (resolved !== localRoot && !resolved.startsWith(`${localRoot}${path.sep}`)) {
          throw new Error(`Đường dẫn asset nằm ngoài thư mục dữ liệu: ${relativePath}`);
        }
        await access(resolved);
        return resolved;
      },
    };
  } catch {
    // A non-local value is treated as a Drive folder ID.
  }

  const folderId = normalizeDriveFolderId(folderValue);
  const rootChildren = await listDriveChildren(folderId);
  const manifestFile = rootChildren.find((entry) => entry.name === 'manifest.json');
  if (!manifestFile) throw new Error('Không tìm thấy manifest.json trong thư mục Drive.');
  const manifestBytes = await downloadDriveFile(manifestFile.id);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DatasetManifest;
  const folderCache = new Map<string, string>([['', folderId]]);
  const fileCache = new Map<string, string>();
  const childrenCache = new Map<string, Array<{ id: string; name: string; mimeType: string }>>([[folderId, rootChildren]]);
  const childrenOf = async (id: string) => {
    const cached = childrenCache.get(id);
    if (cached) return cached;
    const children = await listDriveChildren(id);
    childrenCache.set(id, children);
    return children;
  };

  const resolve = async (relativePath: string): Promise<string> => {
    if (fileCache.has(relativePath)) return fileCache.get(relativePath)!;
    const segments = relativePath.split('/').filter(Boolean);
    const filename = segments.pop();
    if (!filename) throw new Error(`Đường dẫn asset không hợp lệ: ${relativePath}`);
    let currentKey = '';
    let currentFolder = folderId;
    for (const segment of segments) {
      currentKey = currentKey ? `${currentKey}/${segment}` : segment;
      const known = folderCache.get(currentKey);
      if (known) {
        currentFolder = known;
        continue;
      }
      const children = await childrenOf(currentFolder);
      const child = children.find((entry) => entry.name === segment && entry.mimeType === 'application/vnd.google-apps.folder');
      if (!child) throw new Error(`Không tìm thấy thư mục ${currentKey}.`);
      folderCache.set(currentKey, child.id);
      currentFolder = child.id;
    }
    const children = await childrenOf(currentFolder);
    const file = children.find((entry) => entry.name === filename);
    if (!file) throw new Error(`Không tìm thấy asset ${relativePath}.`);
    fileCache.set(relativePath, file.id);
    return file.id;
  };

  return { manifest, manifestRef: manifestFile.id, resolve };
}

export async function syncProjectFromDrive(projectId: string) {
  const db = await getDb();
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  if (!project.drive_folder_id) throw new Error('Dự án chưa có thư mục dữ liệu.');

  const { manifest, manifestRef, resolve } = await loadManifest(project.drive_folder_id as string);
  if (!Array.isArray(manifest.items)) throw new Error('manifest.json thiếu danh sách items.');
  const now = nowISO();
  let dataset = await db.prepare('SELECT * FROM datasets WHERE project_id = ? ORDER BY created_at LIMIT 1')
    .get(projectId);
  if (!dataset) {
    const datasetId = generateId();
    await db.prepare(`INSERT INTO datasets
      (id, project_id, name, dataset_version, algorithm_version, manifest_drive_file_id, last_drive_sync_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(datasetId, projectId, `${project.name} Dataset`, manifest.dataset_version || null,
        manifest.algorithm_version || null, manifestRef, now, now, now);
    dataset = { id: datasetId };
  }

  let added = 0;
  let updated = 0;
  const errors: Array<{ id: string; message: string }> = [];
  for (const item of manifest.items) {
    try {
      if (!item.id || !item.image || !item.prediction) throw new Error('Thiếu id, image hoặc prediction.');
      const [imageRef, predictionRef, prelabelRef] = await Promise.all([
        resolve(item.image),
        resolve(item.prediction),
        item.prelabel ? resolve(item.prelabel) : Promise.resolve(null),
      ]);
      const existing = await db.prepare<{ id: string }>('SELECT id FROM dataset_files WHERE dataset_id = ? AND external_key = ?')
        .get(dataset.id, item.id);
      if (existing) {
        await db.prepare(`UPDATE dataset_files SET image_drive_file_id = ?, prediction_drive_file_id = ?, prelabel_storage_ref = ?,
          image_filename = ?, prediction_filename = ?, prelabel_filename = ?, width = COALESCE(?, width), height = COALESCE(?, height), asset_state = 'READY', updated_at = ?
          WHERE id = ?`)
          .run(imageRef, predictionRef, prelabelRef, path.basename(item.image), path.basename(item.prediction),
            item.prelabel ? path.basename(item.prelabel) : null, item.width || null, item.height || null, now, existing.id);
        updated += 1;
      } else {
        await db.prepare(`INSERT INTO dataset_files
          (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id, prelabel_storage_ref,
           image_filename, prediction_filename, prelabel_filename, width, height, annotation_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNSTARTED', ?, ?)`)
          .run(generateId(), dataset.id, item.id, imageRef, predictionRef, prelabelRef,
            path.basename(item.image), path.basename(item.prediction), item.prelabel ? path.basename(item.prelabel) : null,
            item.width || null, item.height || null, now, now);
        added += 1;
      }
    } catch (error) {
      errors.push({ id: item.id || '(unknown)', message: error instanceof Error ? error.message : String(error) });
      if (item.id) {
        await db.prepare(`UPDATE dataset_files SET asset_state = 'ERROR', updated_at = ?
          WHERE dataset_id = ? AND external_key = ?`).run(now, dataset.id, item.id);
      }
    }
  }
  await db.prepare(`UPDATE datasets SET dataset_version = ?, algorithm_version = ?, manifest_drive_file_id = ?,
    last_drive_sync_at = ?, updated_at = ? WHERE id = ?`)
    .run(manifest.dataset_version || null, manifest.algorithm_version || null, manifestRef, now, now, dataset.id);
  await db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
  return { added, updated, missing: errors.length, errors };
}
