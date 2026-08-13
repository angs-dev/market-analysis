import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file's location (src/paths.ts → ..). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_DIR = join(ROOT, 'config');
export const DATA_DIR = join(ROOT, 'data');
export const REPORTS_DIR = join(ROOT, 'reports');

export const SOURCES_CONFIG = join(CONFIG_DIR, 'sources.json');

/** SWING10_DB overrides the database location (used by tests and replays). */
export function dbPath(): string {
  return process.env['SWING10_DB'] ?? join(DATA_DIR, 'swing10.db');
}
