/**
 * Forward-only migration runner. Each `NNN_name.sql` file in ./migrations is
 * applied once, in filename order, inside a transaction, and recorded in
 * schema_migrations.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './driver.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  name: string;
  file: string;
}

export interface MigrateResult {
  applied: Migration[];
  alreadyAtVersion: number;
}

export function discoverMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const found = readdirSync(dir)
    .filter((f) => FILENAME.test(f))
    .sort()
    .map((file) => {
      const [, version, name] = FILENAME.exec(file)!;
      return { version: Number(version), name: name!, file: join(dir, file) };
    });

  const seen = new Set<number>();
  for (const m of found) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} in ${dir}`);
    }
    seen.add(m.version);
  }
  return found;
}

function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function currentVersion(db: Db): number {
  ensureMigrationTable(db);
  const row = db.get<{ v: number | null }>(
    'SELECT MAX(version) AS v FROM schema_migrations',
  );
  return row?.v ?? 0;
}

export function migrate(db: Db, dir = MIGRATIONS_DIR): MigrateResult {
  ensureMigrationTable(db);
  const at = currentVersion(db);
  const pending = discoverMigrations(dir).filter((m) => m.version > at);
  const applied: Migration[] = [];

  for (const m of pending) {
    const sql = readFileSync(m.file, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    applied.push(m);
  }

  return { applied, alreadyAtVersion: at };
}
