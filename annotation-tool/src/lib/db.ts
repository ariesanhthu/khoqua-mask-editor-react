import crypto from 'crypto';
import path from 'path';
import postgres from 'postgres';
import { PGlite } from '@electric-sql/pglite';
import 'server-only';

export type DbRow = Record<string, unknown>;

interface QueryResult<T> {
  rows: T[];
  affectedRows?: number;
}

interface QueryEngine {
  query<T>(query: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(callback: (tx: QueryEngine) => Promise<T>): Promise<T>;
}

export interface PreparedStatement<T extends DbRow = DbRow> {
  get(...params: unknown[]): Promise<T | undefined>;
  all(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ changes: number }>;
}

export interface AppDatabase {
  prepare<T extends DbRow = DbRow>(query: string): PreparedStatement<T>;
  transaction<T>(callback: (db: AppDatabase) => Promise<T>): Promise<T>;
}

class DatabaseAdapter implements AppDatabase {
  constructor(private readonly engine: QueryEngine) {}

  prepare<T extends DbRow = DbRow>(query: string): PreparedStatement<T> {
    const sql = sqlitePlaceholdersToPostgres(query);
    return {
      get: async (...params) => (await this.engine.query<T>(sql, params)).rows[0],
      all: async (...params) => (await this.engine.query<T>(sql, params)).rows,
      run: async (...params) => {
        const result = await this.engine.query<T>(sql, params);
        return { changes: result.affectedRows ?? result.rows.length };
      },
    };
  }

  transaction<T>(callback: (db: AppDatabase) => Promise<T>): Promise<T> {
    return this.engine.transaction((tx) => callback(new DatabaseAdapter(tx)));
  }
}

let databasePromise: Promise<AppDatabase> | null = null;

export function getDb(): Promise<AppDatabase> {
  if (!databasePromise) databasePromise = initializeDatabase();
  return databasePromise;
}

async function initializeDatabase(): Promise<AppDatabase> {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;

  let engine: QueryEngine;
  if (connectionString) {
    const sql = postgres(connectionString, {
      max: 5,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 15,
    });
    engine = {
      query: async <T>(query: string, params: unknown[] = []) => {
        const rows = await sql.unsafe<T[]>(query, params as never[]);
        return { rows: Array.from(rows), affectedRows: rows.count };
      },
      transaction: async <T>(callback: (tx: QueryEngine) => Promise<T>) => {
        const result = await sql.begin(async (transactionSql) => callback({
          query: async <R>(query: string, params: unknown[] = []) => {
            const rows = await transactionSql.unsafe<R[]>(query, params as never[]);
            return { rows: Array.from(rows), affectedRows: rows.count };
          },
          transaction: async <R>(nested: (tx: QueryEngine) => Promise<R>) => nested(engine),
        }));
        return result as T;
      },
    };
  } else {
    if (process.env.VERCEL) {
      throw new Error('DATABASE_URL is required on Vercel. Connect a serverless Postgres database.');
    }
    const dataPath = process.env.PGLITE_DATA_PATH || path.join(process.cwd(), 'data', 'pglite');
    const pglite = new PGlite(dataPath);
    engine = pglite as unknown as QueryEngine;
  }

  const database = new DatabaseAdapter(engine);
  await initializeSchema(database);
  await bootstrapAdmin(database);
  return database;
}

async function initializeSchema(db: AppDatabase): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT UNIQUE,
      hashed_password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ANNOTATOR',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      drive_folder_id TEXT NOT NULL DEFAULT '',
      export_drive_folder_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`,
    `CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      dataset_version TEXT,
      algorithm_version TEXT,
      manifest_drive_file_id TEXT,
      last_drive_sync_at TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`,
    `CREATE TABLE IF NOT EXISTS dataset_files (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id),
      external_key TEXT NOT NULL,
      image_drive_file_id TEXT NOT NULL,
      prediction_drive_file_id TEXT NOT NULL,
      prelabel_storage_ref TEXT,
      image_filename TEXT NOT NULL,
      prediction_filename TEXT NOT NULL,
      prelabel_filename TEXT,
      width INTEGER,
      height INTEGER,
      asset_state TEXT NOT NULL DEFAULT 'READY',
      annotation_state TEXT NOT NULL DEFAULT 'UNSTARTED',
      latest_revision INTEGER NOT NULL DEFAULT 0,
      latest_version_number INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(dataset_id, external_key)
    )`,
    `CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      assigned_by TEXT,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`,
    `CREATE TABLE IF NOT EXISTS file_locks (
      dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      session_id TEXT NOT NULL,
      lock_token_hash TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      last_heartbeat_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS annotations (
      dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id),
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      segmentation_json TEXT NOT NULL DEFAULT '{}',
      breakpoints_json TEXT NOT NULL DEFAULT '{}',
      last_edited_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )`,
    `CREATE TABLE IF NOT EXISTS annotation_versions (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      version_number INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      segmentation_json TEXT NOT NULL,
      breakpoints_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      UNIQUE(dataset_file_id, version_number)
    )`,
    `CREATE TABLE IF NOT EXISTS annotation_sessions (
      id TEXT PRIMARY KEY,
      dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      base_revision INTEGER NOT NULL,
      opened_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      last_activity_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
      closed_at TEXT,
      close_reason TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_files_dataset_state ON dataset_files(dataset_id, annotation_state)',
    'CREATE INDEX IF NOT EXISTS idx_assignments_file_user ON assignments(dataset_file_id, user_id)',
    'CREATE INDEX IF NOT EXISTS idx_versions_file ON annotation_versions(dataset_file_id, version_number)',
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS export_drive_folder_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE dataset_files ADD COLUMN IF NOT EXISTS prelabel_storage_ref TEXT`,
    `ALTER TABLE dataset_files ADD COLUMN IF NOT EXISTS prelabel_filename TEXT`,
  ];

  for (const statement of statements) await db.prepare(statement).run();
}

async function bootstrapAdmin(db: AppDatabase): Promise<void> {
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!bootstrapPassword || bootstrapPassword.length < 8) return;
  const row = await db.prepare<{ total: number | string }>('SELECT COUNT(*) AS total FROM users').get();
  if (Number(row?.total || 0) > 0) return;
  await db.prepare(`INSERT INTO users (id, display_name, email, hashed_password, role)
    VALUES (?, ?, ?, ?, 'ADMIN')`).run(
    generateId(),
    process.env.BOOTSTRAP_ADMIN_NAME || 'Admin',
    process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@local',
    hashPassword(bootstrapPassword),
  );
}

function sqlitePlaceholdersToPostgres(query: string): string {
  let index = 0;
  return query.replace(/\?/g, () => `$${++index}`);
}

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
