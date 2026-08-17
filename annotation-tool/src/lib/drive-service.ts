import 'server-only';

import { access, readFile } from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { importPKCS8, SignJWT } from 'jose';
import { getDb, generateId, nowISO } from './db';

interface ManifestItem {
  id: string;
  image: string;
  prediction: string;
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

async function driveRequest<T>(url: string): Promise<T> {
  const token = await getDriveAccessToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Google Drive trả về lỗi ${response.status}.`);
  return response.json() as Promise<T>;
}

async function listDriveChildren(folderId: string): Promise<Array<{ id: string; name: string; mimeType: string }>> {
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
    const result = await driveRequest<{
      nextPageToken?: string;
      files: Array<{ id: string; name: string; mimeType: string }>;
    }>(`https://www.googleapis.com/drive/v3/files?${query}`);
    files.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);
  return files;
}

async function downloadDriveFile(fileId: string): Promise<Uint8Array> {
  const token = await getDriveAccessToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Không tải được tệp Google Drive (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchDriveAsset(fileId: string): Promise<Uint8Array> {
  return downloadDriveFile(fileId);
}

export async function createDriveFolder(name: string, parentFolderId: string): Promise<string> {
  const token = await getDriveAccessToken();
  const response = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [normalizeDriveFolderId(parentFolderId)],
    }),
  });
  if (!response.ok) throw new Error(`Không tạo được thư mục Drive (${response.status}).`);
  return ((await response.json()) as { id: string }).id;
}

export async function uploadDriveFile(
  name: string,
  parentFolderId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const token = await getDriveAccessToken();
  const boundary = `annotation-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const metadata = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ name, parents: [normalizeDriveFolderId(parentFolderId)] })}\r\n` +
    `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(metadata.length + bytes.length + suffix.length);
  body.set(metadata, 0);
  body.set(bytes, metadata.length);
  body.set(suffix, metadata.length + bytes.length);
  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!response.ok) throw new Error(`Không tải được kết quả lên Drive (${response.status}).`);
  return ((await response.json()) as { id: string }).id;
}

async function loadManifest(folderValue: string): Promise<{
  manifest: DatasetManifest;
  manifestRef: string;
  resolve: (relativePath: string) => Promise<string>;
}> {
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
      const [imageRef, predictionRef] = await Promise.all([resolve(item.image), resolve(item.prediction)]);
      const existing = await db.prepare<{ id: string }>('SELECT id FROM dataset_files WHERE dataset_id = ? AND external_key = ?')
        .get(dataset.id, item.id);
      if (existing) {
        await db.prepare(`UPDATE dataset_files SET image_drive_file_id = ?, prediction_drive_file_id = ?,
          image_filename = ?, prediction_filename = ?, width = COALESCE(?, width), height = COALESCE(?, height), asset_state = 'READY', updated_at = ?
          WHERE id = ?`)
          .run(imageRef, predictionRef, path.basename(item.image), path.basename(item.prediction),
            item.width || null, item.height || null, now, existing.id);
        updated += 1;
      } else {
        await db.prepare(`INSERT INTO dataset_files
          (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id,
           image_filename, prediction_filename, width, height, annotation_state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNSTARTED', ?, ?)`)
          .run(generateId(), dataset.id, item.id, imageRef, predictionRef,
            path.basename(item.image), path.basename(item.prediction), item.width || null, item.height || null, now, now);
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
