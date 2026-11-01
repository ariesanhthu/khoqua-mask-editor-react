import 'server-only';

import { get as getVercelBlob, put as putVercelBlob } from '@vercel/blob';
import { AwsClient } from 'aws4fetch';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

/**
 * Object storage behind one interface. Backends:
 * - `r2`: Cloudflare R2 over the S3 API (STORAGE_BACKEND=r2).
 * - `blob`: Vercel Blob (private).
 * - `filesystem`: local development only.
 *
 * With STORAGE_BACKEND unset the choice is the historical one (Blob on Vercel or when a
 * Blob token exists, otherwise filesystem), so deployments that do not opt in are unchanged.
 */

export type StorageBackend = 'r2' | 'blob' | 'filesystem';

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

type Env = Record<string, string | undefined>;

export function hasVercelBlob(env: Env = process.env): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
}

export function readR2Config(env: Env = process.env): R2Config | null {
  const endpoint = env.R2_ENDPOINT?.trim().replace(/\/+$/, '');
  const bucket = env.R2_BUCKET?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

export function resolveBackend(env: Env = process.env): StorageBackend {
  const requested = env.STORAGE_BACKEND?.trim().toLowerCase();
  if (requested === 'r2') {
    if (!readR2Config(env)) {
      throw new Error('STORAGE_BACKEND=r2 requires R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
    }
    return 'r2';
  }
  if (requested === 'blob') return 'blob';
  if (requested === 'filesystem') return 'filesystem';
  if (requested) throw new Error(`Unknown STORAGE_BACKEND "${requested}". Use r2, blob or filesystem.`);
  return env.VERCEL || hasVercelBlob(env) ? 'blob' : 'filesystem';
}

function assertSafeKey(key: string): string {
  const normalized = key.replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Invalid storage key');
  }
  return normalized;
}

function storageRoot(): string {
  return path.resolve(
    /* turbopackIgnore: true */
    process.env.ANNOTATION_STORAGE_PATH || path.join(process.cwd(), 'annotation-storage'),
  );
}

function safeStoragePath(key: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage key');
  return resolved;
}

function r2Url(config: R2Config, key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encoded}`;
}

function r2Client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    retries: 2,
  });
}

async function putR2(config: R2Config, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const response = await r2Client(config).fetch(r2Url(config, key), {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: Buffer.from(bytes),
  });
  if (!response.ok) throw new Error(`R2 upload failed (${response.status}).`);
}

/** Null when the object does not exist; throws for any other failure. */
async function getR2(config: R2Config, key: string): Promise<Buffer | null> {
  const response = await r2Client(config).fetch(r2Url(config, key), { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function getBlobObject(key: string): Promise<Buffer | null> {
  const result = await getVercelBlob(key, { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

/** Writes a new object. Keys are unique per write, so overwriting is never expected. */
export async function putObject(rawKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const key = assertSafeKey(rawKey);
  const backend = resolveBackend();
  if (backend === 'r2') return putR2(readR2Config()!, key, bytes, contentType);
  if (backend === 'blob') {
    if (!hasVercelBlob()) throw new Error('A Vercel Blob store is not connected to this project.');
    await putVercelBlob(key, Buffer.from(bytes), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType,
    });
    return;
  }
  const target = safeStoragePath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(/* turbopackIgnore: true */ target, bytes, { flag: 'wx' });
}

/**
 * Reads an object written through putObject. On R2, a missing object falls back to Vercel
 * Blob when a Blob store is still configured, so existing data keeps working until it has
 * been copied with scripts/migrate-blob-to-r2.mjs.
 */
export async function getObject(rawKey: string): Promise<Buffer | null> {
  const key = assertSafeKey(rawKey);
  const backend = resolveBackend();
  if (backend === 'filesystem') {
    try {
      return await readFile(/* turbopackIgnore: true */ safeStoragePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  if (backend === 'r2') {
    const found = await getR2(readR2Config()!, key);
    if (found || !hasVercelBlob()) return found;
  }
  return getBlobObject(key);
}

/**
 * Dataset reference for an object written with putObject (uploaded datasets). On R2/Blob it is
 * `blob:<key>`, read back through getDatasetObject. On the local filesystem backend it is the
 * absolute path, which fetchDatasetAsset and the asset route already read directly, so
 * getDatasetObject keeps never touching the local disk.
 */
export function datasetObjectReference(rawKey: string): string {
  const key = assertSafeKey(rawKey);
  return resolveBackend() === 'filesystem' ? safeStoragePath(key) : `blob:${key}`;
}

/**
 * Reads a dataset asset (`blob:<key>` references). Unlike masks this never uses the local
 * filesystem: datasets live in Blob or R2 only.
 */
export async function getDatasetObject(rawKey: string): Promise<Buffer | null> {
  const key = assertSafeKey(rawKey);
  if (resolveBackend() === 'r2') {
    const found = await getR2(readR2Config()!, key);
    if (found || !hasVercelBlob()) return found;
  }
  return getBlobObject(key);
}
