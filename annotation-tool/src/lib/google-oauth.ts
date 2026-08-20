import 'server-only';

import crypto from 'crypto';
import { decodeJwt } from 'jose';
import { getDb, nowISO } from './db';

const PROVIDER = 'google-drive-export';
const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive'];

let cachedOAuthToken: { value: string; expiresAt: number } | null = null;

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface StoredCredential extends Record<string, unknown> {
  encrypted_refresh_token: string;
  account_email: string | null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID
    && process.env.GOOGLE_OAUTH_CLIENT_SECRET
    && process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

function oauthConfig(): OAuthConfig {
  if (!googleOAuthConfigured()) throw new Error('Google OAuth chưa được cấu hình đầy đủ.');
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
  };
}

function encryptionKey(): Buffer {
  const secret = process.env.SECRET_KEY;
  if (!secret) throw new Error('SECRET_KEY chưa được cấu hình.');
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptRefreshToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptRefreshToken(value: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(':');
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Thông tin kết nối Google Drive không hợp lệ. Hãy kết nối lại.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Không thể giải mã kết nối Google Drive. Hãy kết nối lại.');
  }
}

async function storedCredential(): Promise<StoredCredential | undefined> {
  const db = await getDb();
  return db.prepare<StoredCredential>(
    'SELECT encrypted_refresh_token, account_email FROM oauth_credentials WHERE provider = ?',
  ).get(PROVIDER);
}

async function tokenRequest(body: URLSearchParams): Promise<{ response: Response; payload: TokenResponse }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json() as TokenResponse;
  return { response, payload };
}

export function buildGoogleAuthorizationUrl(state: string): string {
  const config = oauthConfig();
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode(code: string): Promise<void> {
  const config = oauthConfig();
  const current = await storedCredential();
  const { response, payload } = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  }));
  if (!response.ok || !payload.access_token) throw new Error('Không thể hoàn tất kết nối Google Drive.');
  const refreshToken = payload.refresh_token
    || (current ? decryptRefreshToken(current.encrypted_refresh_token) : undefined);
  if (!refreshToken) throw new Error('Google không trả refresh token. Hãy kết nối lại và cấp quyền truy cập.');

  let accountEmail: string | null = current?.account_email || null;
  if (payload.id_token) {
    try {
      const decoded = decodeJwt(payload.id_token);
      accountEmail = typeof decoded.email === 'string' ? decoded.email : accountEmail;
    } catch {
      // Email is informational; token storage must still succeed.
    }
  }
  const now = nowISO();
  const db = await getDb();
  await db.prepare(`INSERT INTO oauth_credentials
    (provider, encrypted_refresh_token, account_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (provider) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
      account_email = EXCLUDED.account_email, updated_at = EXCLUDED.updated_at`)
    .run(PROVIDER, encryptRefreshToken(refreshToken), accountEmail, now, now);
  cachedOAuthToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
  };
}

export async function getGoogleOAuthAccessToken(): Promise<string> {
  if (cachedOAuthToken && cachedOAuthToken.expiresAt > Date.now() + 60_000) return cachedOAuthToken.value;
  const credential = await storedCredential();
  if (!credential) {
    throw new Error('Chưa kết nối Google Drive.\nHãy đăng nhập bằng tài khoản Google trước khi xuất dữ liệu.');
  }
  const config = oauthConfig();
  const { response, payload } = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: decryptRefreshToken(credential.encrypted_refresh_token),
    grant_type: 'refresh_token',
  }));
  if (!response.ok || !payload.access_token) {
    cachedOAuthToken = null;
    if (response.status === 401 || payload.error === 'invalid_grant') {
      throw new Error('Kết nối Google Drive đã hết hạn hoặc bị thu hồi.\nHãy kết nối lại.');
    }
    throw new Error(`Không thể làm mới kết nối Google Drive (${response.status}).`);
  }
  cachedOAuthToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
  };
  return cachedOAuthToken.value;
}

export async function isGoogleDriveConnected(): Promise<boolean> {
  return Boolean(await storedCredential());
}

export async function getGoogleDriveAccountEmail(): Promise<string | null> {
  return (await storedCredential())?.account_email || null;
}

export async function disconnectGoogleDrive(): Promise<void> {
  const db = await getDb();
  await db.prepare('DELETE FROM oauth_credentials WHERE provider = ?').run(PROVIDER);
  cachedOAuthToken = null;
}
