import {
  type AppDatabase,
  generateId,
  generateToken,
  getDb,
  hashToken,
  nowISO,
} from './db';

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

export async function acquireLock(fileId: string, userId: string): Promise<LockResult | LockDenied | null> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const file = await tx.prepare('SELECT * FROM dataset_files WHERE id = ? FOR UPDATE').get(fileId);
    if (!file) return null;

    const now = new Date();
    const nowStr = now.toISOString();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
    const existingLock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);

    if (existingLock) {
      const lockExpiry = new Date(existingLock.expires_at as string);
      if (lockExpiry > now && existingLock.user_id !== userId) {
        const lockedUser = await tx.prepare('SELECT display_name FROM users WHERE id = ?').get(existingLock.user_id);
        return {
          denied: true,
          lockedBy: {
            userId: existingLock.user_id as string,
            displayName: (lockedUser?.display_name as string) || 'Unknown',
          },
          expiresAt: existingLock.expires_at as string,
        };
      }

      await closeOpenSessions(
        tx,
        fileId,
        existingLock.user_id as string,
        nowStr,
        lockExpiry <= now ? 'LOCK_EXPIRED' : 'REOPENED',
      );
      await tx.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);
    }

    const token = generateToken();
    const sessionId = generateId();
    await tx.prepare(`INSERT INTO file_locks
      (dataset_file_id, user_id, session_id, lock_token_hash, acquired_at, last_heartbeat_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      fileId, userId, sessionId, hashToken(token), nowStr, nowStr, expiresAt,
    );
    await tx.prepare(`INSERT INTO annotation_sessions
      (id, dataset_file_id, user_id, base_revision, opened_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      sessionId, fileId, userId, file.latest_revision, nowStr, nowStr,
    );

    return {
      denied: false,
      sessionId,
      lockToken: token,
      expiresAt,
      baseRevision: Number(file.latest_revision),
    };
  });
}

export async function validateLockToken(fileId: string, token: string) {
  const db = await getDb();
  const lock = await db.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ?').get(fileId);
  if (!lock || new Date(lock.expires_at as string) <= new Date()) return null;
  return lock.lock_token_hash === hashToken(token) ? lock : null;
}

export async function heartbeat(fileId: string, token: string, userId?: string): Promise<string | null> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);
    if (!isValidLock(lock, token, userId)) return null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
    const nowStr = now.toISOString();
    await tx.prepare('UPDATE file_locks SET last_heartbeat_at = ?, expires_at = ? WHERE dataset_file_id = ?')
      .run(nowStr, expiresAt, fileId);
    await tx.prepare('UPDATE annotation_sessions SET last_activity_at = ? WHERE id = ?')
      .run(nowStr, lock!.session_id);
    return expiresAt;
  });
}

export async function releaseLock(fileId: string, token: string, reason = 'EXPLICIT_RELEASE'): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const lock = await tx.prepare('SELECT * FROM file_locks WHERE dataset_file_id = ? FOR UPDATE').get(fileId);
    if (!isValidLock(lock, token)) return false;
    const nowStr = nowISO();
    await tx.prepare('UPDATE annotation_sessions SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL')
      .run(nowStr, reason, lock!.session_id);
    await tx.prepare('DELETE FROM file_locks WHERE dataset_file_id = ?').run(fileId);
    return true;
  });
}

function isValidLock(lock: Record<string, unknown> | undefined, token: string, userId?: string): boolean {
  return Boolean(
    lock &&
    new Date(lock.expires_at as string) > new Date() &&
    lock.lock_token_hash === hashToken(token) &&
    (!userId || lock.user_id === userId),
  );
}

async function closeOpenSessions(
  db: AppDatabase,
  fileId: string,
  userId: string,
  nowStr: string,
  reason: string,
) {
  await db.prepare(`UPDATE annotation_sessions SET closed_at = ?, close_reason = ?
    WHERE dataset_file_id = ? AND user_id = ? AND closed_at IS NULL`)
    .run(nowStr, reason, fileId, userId);
}
