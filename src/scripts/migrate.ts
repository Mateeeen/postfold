/**
 * Migration runner.
 *
 * Applies db/*.sql in filename order and records what it applied in a
 * `migrations` table. Idempotent: running it twice is a no-op, so it is safe
 * on every boot and in CI.
 *
 * Each file runs inside a transaction. A migration that fails leaves the
 * database exactly as it was and is not recorded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { openDatabase, nowIso } from '../db/index.js';
import type { Db } from '../db/index.js';

const MIGRATIONS_DIR = path.resolve('db');

export function ensureMigrationsTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
}

export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): string[] {
  ensureMigrationsTable(db);

  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const ran: string[] = [];
  for (const file of migrationFiles(dir)) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');

    // Foreign keys go off around each migration: SQLite cannot ALTER a CHECK
    // constraint, so table rebuilds (create/copy/drop/rename) are unavoidable,
    // and with FK enforcement on, DROP TABLE either fails or leaves dangling
    // references behind. The pragma is a no-op inside a transaction, so it has
    // to be set out here.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');

    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
          file,
          nowIso(),
        );
      })();

      // A rebuild that orphaned a row is a silent data bug; catch it here
      // rather than at read time.
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `${file} left ${violations.length} foreign key violation(s): ` +
            JSON.stringify(violations.slice(0, 3)),
        );
      }
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }

    ran.push(file);
  }
  return ran;
}

function main(): void {
  const db = openDatabase(config.databasePath);

  // COUNT(*) FILTER (WHERE ...) needs SQLite 3.30+; the claim query's
  // UPDATE ... RETURNING needs 3.35+. Fail loudly at migrate time rather than
  // at 2am in the worker.
  const version = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  const [major = 0, minor = 0] = version.v.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 35)) {
    throw new Error(
      `SQLite ${version.v} is too old. PostFold needs 3.35+ for UPDATE ... RETURNING.`,
    );
  }

  const ran = migrate(db);
  console.log(`SQLite ${version.v} at ${config.databasePath}`);
  console.log(ran.length === 0 ? 'No new migrations.' : `Applied: ${ran.join(', ')}`);
  db.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
