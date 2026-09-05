/**
 * SQLite connection.
 *
 * better-sqlite3 is synchronous. Every DB function in this codebase keeps an
 * `async` signature so callers did not have to change when we moved off
 * Postgres, but the bodies are plain synchronous statement calls. We do not
 * wrap statements in promises beyond that — a fake promise around a sync call
 * buys nothing and hides where the blocking actually happens.
 *
 * Single writer. See src/queue/worker.ts and the note in README.md about what
 * horizontal scaling would require.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export type Db = Database.Database;

let db: Db | null = null;

export function openDatabase(filePath: string): Db {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const handle = new Database(filePath);

  // Order matters: journal_mode must be set before heavy use, and
  // foreign_keys must be set on EVERY connection or REFERENCES is ignored.
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('synchronous = NORMAL');

  return handle;
}

export function getDb(): Db {
  if (!db) db = openDatabase(config.databasePath);
  return db;
}

/** Test seam: point the process at an in-memory database. */
export function setDb(handle: Db | null): void {
  db = handle;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/**
 * `BEGIN IMMEDIATE` — takes the write lock up front instead of upgrading a
 * deferred read transaction mid-flight (which is what produces SQLITE_BUSY
 * under contention). The worker's claim runs inside one of these.
 */
export function immediateTransaction<T>(handle: Db, fn: () => T): T {
  const run = handle.transaction(fn);
  return run.immediate();
}

/** ISO-8601 UTC. The only timestamp format written anywhere. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function fromIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  // datetime('now') defaults produce 'YYYY-MM-DD HH:MM:SS' with no zone.
  // Everything we write is UTC, so say so explicitly rather than letting the
  // Date constructor guess local time.
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? s.replace(' ', 'T') + 'Z'
    : s;
  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Non-null variant for columns declared NOT NULL. */
export function fromIsoRequired(s: string): Date {
  const d = fromIso(s);
  if (!d) throw new Error(`Invalid timestamp in database: ${String(s)}`);
  return d;
}

/* --- JSON columns ------------------------------------------------------ *
 * Postgres jsonb became TEXT. Encoding and decoding happens here and nowhere
 * else — a JSON.parse at a call site is a bug waiting to happen the first time
 * a column is null.
 * ---------------------------------------------------------------------- */

export function encodeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function decodeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const boolToInt = (b: boolean): number => (b ? 1 : 0);
export const intToBool = (n: number): boolean => n === 1;

export function newId(): string {
  return crypto.randomUUID();
}
