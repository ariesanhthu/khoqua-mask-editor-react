/**
 * Lock service — atomic lock acquisition per spec 03.
 * Server-side only, uses better-sqlite3 transactions.
 */

import { getDb, hashToken, generateToken, generateId, nowISO } from './db';

const LOCK_TTL_MS = (Number(process.env.LOCK_TTL_SECONDS) || 300) * 1000;

interface LockResult {
  denied: false;
  sessionId: string;
  lockToken: string;
  expiresAt: string;
  baseRevision: number;
}

interface LockDenied {
  denied: true;
  lockedBy: { userId: string; displayName: string };
  expiresAt: string;
}

export function acquireLock(fileId: string, userId: string): LockResult | LockDenied | null {
  const db = getDb();

  // Use a transaction for atomicity — spec 03 §15
  const result = db.transaction(() => {
    const file = db.prepare('SELECT * FROM dataset_files WHERE id = ?').get(fileId) as Record<string, unknown> | undefined;
    if (!file) return null;

    const now = new Date();
    const nowStr = now.toISOString();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();

    const existingLock = db.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ?').get(fileId) as Record<string, unknown> | undefined;

    if (existingLock) {
      const lockExpiry = new Date(existingLock.expires_at as string);

      if (lockExpiry > now && existingLock.user_id !== userId) {
        // Locked by another active user
        const lockedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(existingLock.user_id as string) as Record<string, unknown> | undefined;
        return {
          denied: true,
          lockedBy: {
            userId: existingLock.user_id as string,
            displayName: (lockedUser?.display_name as string) || 'Unknown',
          },
          expiresAt: existingLock.expires_at as string,
        } as LockDenied;
      }

      // Expired or same user — close stale sessions then replace lock
      closeOpenSessions(db, fileId, existingLock.user_id as string, nowStr, lockExpiry <= now ? 'LOCK_EXPIRED' : 'UNKNOWN');
      db.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);
    }

    // Create new lock
    const token = generateToken();
    const sessionId = generateId();

    db.prepare(`
      INSERT INTO file_locks (dataset_file_id, user_id, session_id, lock_token_hash, acquired_at, last_heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, userId, sessionId, hashToken(token), nowStr, nowStr, expiresAt);

    // Create session
    db.prepare(`
      INSERT INTO annotation_sessions (id, dataset_file_id, user_id, base_revision, opened_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, fileId, userId, file.latest_revision as number, nowStr, nowStr);

    return {
      denied: false,
      sessionId,
      lockToken: token,
      expiresAt,
      baseRevision: file.latest_revision as number,
    } as LockResult;
  })();

  return result as LockResult | LockDenied | null;
}

export function validateLockToken(fileId: string, token: string): Record<string, unknown> | null {
  const db = getDb();
  const lock = db.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ?').get(fileId) as Record<string, unknown> | undefined;
  if (!lock) return null;

  const now = new Date();
  if (new Date(lock.expires_at as string) <= now) return null;
  if ((lock.lock_token_hash as string) !== hashToken(token)) return null;

  return lock;
}

export function heartbeat(fileId: string, token: string, userId?: string): string | null {
  const db = getDb();

  return db.transaction(() => {
    const lock = validateLockToken(fileId, token);
    if (!lock || (userId && lock.user_id !== userId)) return null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
    const nowStr = now.toISOString();

    db.prepare('UPDATE file_locks SET last_heartbeat_at = ?, expires_at = ? WHERE dataset_file_id = ?')
      .run(nowStr, expiresAt, fileId);

    db.prepare('UPDATE annotation_sessions SET last_activity_at = ? WHERE id = ?')
      .run(nowStr, lock.session_id as string);

    return expiresAt;
  })();
}

export function releaseLock(fileId: string, token: string, reason: string = 'EXPLICIT_RELEASE'): boolean {
  const db = getDb();

  return db.transaction(() => {
    const lock = validateLockToken(fileId, token);
    if (!lock) return false;

    const nowStr = nowISO();

    // Close session
    db.prepare('UPDATE annotation_sessions SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL')
      .run(nowStr, reason, lock.session_id as string);

    // Delete lock
    db.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);

    return true;
  })();
}

function closeOpenSessions(db: ReturnType<typeof getDb>, fileId: string, userId: string, nowStr: string, reason: string) {
  db.prepare(
    'UPDATE annotation_sessions SET closed_at = ?, close_reason = ? WHERE dataset_file_id = ? AND user_id = ? AND closed_at IS NULL'
  ).run(nowStr, reason, fileId, userId);
}
