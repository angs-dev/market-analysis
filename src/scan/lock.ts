/**
 * Scan lock.
 *
 * Prevents overlapping scans — a scheduled cycle running long while the user
 * presses SCAN NOW, or two processes sharing one database file. Held in SQLite
 * rather than in memory so it works across processes, and expiring rather than
 * permanent so a crashed scan cannot wedge the scanner forever.
 */

import type { Db } from '../db/driver.ts';

export interface LockState {
  lockedAt: string | null;
  lockedBy: string | null;
  expiresAt: string | null;
}

export interface AcquireResult {
  acquired: boolean;
  /** Present when the lock was refused. */
  heldBy?: string;
  expiresAt?: string;
}

export const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

export function readLock(db: Db): LockState {
  const row = db.get<{ locked_at: string | null; locked_by: string | null; expires_at: string | null }>(
    'SELECT locked_at, locked_by, expires_at FROM scan_lock WHERE id = 1',
  );
  return {
    lockedAt: row?.locked_at ?? null,
    lockedBy: row?.locked_by ?? null,
    expiresAt: row?.expires_at ?? null,
  };
}

/**
 * Attempts to take the lock.
 *
 * The conditional UPDATE is the whole mechanism: it only succeeds when the
 * lock is free or expired, and SQLite serialises it, so two racing callers
 * cannot both win.
 */
export function acquireLock(
  db: Db,
  owner: string,
  now: Date = new Date(),
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): AcquireResult {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  const result = db.run(
    `UPDATE scan_lock
        SET locked_at = ?, locked_by = ?, expires_at = ?
      WHERE id = 1
        AND (locked_at IS NULL OR expires_at IS NULL OR expires_at <= ?)`,
    nowIso, owner, expiresAt, nowIso,
  );

  if (result.changes === 1) return { acquired: true, expiresAt };

  const held = readLock(db);
  const refusal: AcquireResult = { acquired: false };
  if (held.lockedBy) refusal.heldBy = held.lockedBy;
  if (held.expiresAt) refusal.expiresAt = held.expiresAt;
  return refusal;
}

/** Releases the lock, but only if this owner still holds it. */
export function releaseLock(db: Db, owner: string): boolean {
  return (
    db.run(
      'UPDATE scan_lock SET locked_at = NULL, locked_by = NULL, expires_at = NULL WHERE id = 1 AND locked_by = ?',
      owner,
    ).changes === 1
  );
}

/** Runs `fn` under the lock. Returns null when the lock could not be taken. */
export async function withLock<T>(
  db: Db,
  owner: string,
  fn: () => Promise<T>,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<T | null> {
  const acquired = acquireLock(db, owner, opts.now, opts.ttlMs);
  if (!acquired.acquired) return null;
  try {
    return await fn();
  } finally {
    releaseLock(db, owner);
  }
}
