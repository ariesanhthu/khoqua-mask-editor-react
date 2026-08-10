/**
 * SQLite database layer using better-sqlite3.
 * Server-side only — imported in API routes.
 */

import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import { mkdirSync } from 'fs';
import 'server-only';

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(process.cwd(), 'data', 'annotation.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initTables(_db);
  }
  return _db;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT,
      hashed_password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ANNOTATOR',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      drive_folder_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      dataset_version TEXT,
      algorithm_version TEXT,
      manifest_drive_file_id TEXT,
      last_drive_sync_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dataset_files (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id),
      external_key TEXT NOT NULL,
      image_drive_file_id TEXT NOT NULL,
      prediction_drive_file_id TEXT NOT NULL,
      image_filename TEXT NOT NULL,
      prediction_filename TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      asset_state TEXT NOT NULL DEFAULT 'READY',
      annotation_state TEXT NOT NULL DEFAULT 'UNSTARTED',
      latest_revision INTEGER NOT NULL DEFAULT 0,
      latest_version_number INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dataset_id, external_key)
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      assigned_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_locks (
      dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      session_id TEXT NOT NULL,
      lock_token_hash TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS annotations (
      dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      segmentation_json TEXT NOT NULL DEFAULT '{}',
      breakpoints_json TEXT NOT NULL DEFAULT '{}',
      last_edited_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS annotation_versions (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      version_number INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      segmentation_json TEXT NOT NULL,
      breakpoints_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(dataset_file_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS annotation_sessions (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      base_revision INTEGER NOT NULL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id);
    CREATE INDEX IF NOT EXISTS idx_files_dataset_state ON dataset_files(dataset_id, annotation_state);
    CREATE INDEX IF NOT EXISTS idx_assignments_file_user ON assignments(dataset_file_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_versions_file ON annotation_versions(dataset_file_id, version_number);
  `);

  const fileColumns = db.prepare('PRAGMA table_info(dataset_files)').all() as Array<{ name: string }>;
  if (!fileColumns.some((column) => column.name === 'asset_state')) {
    db.exec("ALTER TABLE dataset_files ADD COLUMN asset_state TEXT NOT NULL DEFAULT 'READY'");
  }

  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapPassword && bootstrapPassword.length >= 8) {
    const userCount = (db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }).total;
    if (userCount === 0) {
      db.prepare(`INSERT INTO users (id, display_name, email, hashed_password, role)
        VALUES (?, ?, ?, ?, 'ADMIN')`)
        .run(generateId(), process.env.BOOTSTRAP_ADMIN_NAME || 'Admin',
          process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@local', hashPassword(bootstrapPassword));
    }
  }
}

// ─── Auth helpers ───────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210_000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const modern = stored.split('$');
  let salt: string;
  let hash: string;
  let iterations: number;
  if (modern.length === 4) {
    salt = modern[2];
    hash = modern[3];
    iterations = Number(modern[1]);
  } else {
    [salt = '', hash = ''] = stored.split(':');
    iterations = 1000;
  }
  if (!salt || !hash || !Number.isSafeInteger(iterations) || iterations <= 0) return false;
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function nowISO(): string {
  return new Date().toISOString();
}
