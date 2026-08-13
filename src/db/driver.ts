/**
 * Thin adapter over the SQLite driver.
 *
 * The project uses Node's built-in `node:sqlite` so there are zero runtime
 * dependencies and no native compilation. That API is still marked
 * experimental, so every call site goes through this file — swapping to
 * `better-sqlite3` is a change to this module only.
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;

export interface Db {
  /** Statement returning no rows (DDL, INSERT, UPDATE). */
  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number };
  /** All matching rows. */
  all<T = Row>(sql: string, ...params: Param[]): T[];
  /** First matching row, or undefined. */
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  /** Multiple statements at once. No parameters — migrations only. */
  exec(sql: string): void;
  /** Runs `fn` in a transaction, rolling back on throw. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** Path to the database file, or ':memory:' for a throwaway database. */
  path: string;
  /** WAL improves concurrent reads. Disabled automatically for :memory:. */
  wal?: boolean;
}

export function openDb(opts: OpenOptions): Db {
  const inMemory = opts.path === ':memory:';
  if (!inMemory) mkdirSync(dirname(opts.path), { recursive: true });

  const handle = new DatabaseSync(opts.path);

  handle.exec('PRAGMA foreign_keys = ON');
  if (!inMemory && opts.wal !== false) handle.exec('PRAGMA journal_mode = WAL');

  let depth = 0;

  return {
    run(sql, ...params) {
      const result = handle.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },

    all<T>(sql: string, ...params: Param[]): T[] {
      return handle.prepare(sql).all(...params) as T[];
    },

    get<T>(sql: string, ...params: Param[]): T | undefined {
      return handle.prepare(sql).get(...params) as T | undefined;
    },

    exec(sql) {
      handle.exec(sql);
    },

    // Savepoints rather than BEGIN/COMMIT so nesting is safe.
    transaction<T>(fn: () => T): T {
      const name = `sp_${depth++}`;
      handle.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        handle.exec(`RELEASE ${name}`);
        return out;
      } catch (err) {
        handle.exec(`ROLLBACK TO ${name}`);
        handle.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    },

    close() {
      handle.close();
    },
  };
}
