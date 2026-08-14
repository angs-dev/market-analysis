/**
 * Portable state snapshot for ephemeral runners.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HONEST POSITION ON GITHUB ACTIONS PERSISTENCE
 *
 * Reliable persistence CANNOT be fully achieved for free on ephemeral runners.
 * Every zero-cost option has a real failure mode:
 *
 *   actions/cache      evicted after 7 days without access, and concurrent
 *                      runs can race, so a write may be lost
 *   commit to git      a commit every five minutes, thousands per month, and
 *                      a binary database that bloats the repository
 *   run artifacts      retained per-run; finding "the latest" needs extra API
 *                      calls and is fragile across failed runs
 *   repo variables     48KB cap and needs a personal access token
 *
 * So the design does not pretend. It makes state loss cheap instead:
 *
 *   1. Only ALERT state travels — signal states and recently alerted symbols.
 *      Never candles, never features, never scores.
 *   2. Losing it costs one duplicate alert. It cannot corrupt history, because
 *      GitHub Actions mode never claims to own history.
 *   3. LOCAL MODE IS AUTHORITATIVE. The full SQLite database on the laptop is
 *      the record; the workflow is a notifier that happens to run in the cloud.
 *
 * The snapshot is JSON, typically a few kilobytes, and safe to cache.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from '../db/driver.ts';

export const SNAPSHOT_VERSION = 1;

export interface SignalSnapshot {
  symbol: string;
  action: string;
  swing10Score: number | null;
  eventQuality: number | null;
  tradeQuality: number | null;
  firstSeenAt: string;
  updatedAt: string;
  invalidationReason: string | null;
}

export interface AlertSnapshot {
  symbol: string | null;
  transition: string;
  ts: string;
}

export interface StateSnapshot {
  version: number;
  exportedAt: string;
  /** Dedupe keys of events already ingested, so they are not re-processed. */
  processedEventKeys: string[];
  signals: SignalSnapshot[];
  /** Recently sent alerts, for cooldown enforcement across runs. */
  recentAlerts: AlertSnapshot[];
}

export interface ExportOptions {
  /** Alerts newer than this many hours are carried. Older ones cannot matter. */
  alertWindowHours?: number;
  /** Cap on event keys carried, newest first. */
  maxEventKeys?: number;
  now?: Date;
}

export function exportState(db: Db, opts: ExportOptions = {}): StateSnapshot {
  const now = opts.now ?? new Date();
  const windowHours = opts.alertWindowHours ?? 24;
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000).toISOString();

  const signals = db
    .all<{
      symbol: string; action: string; swing10_score: number | null;
      event_quality: number | null; trade_quality: number | null;
      first_seen_at: string; updated_at: string; invalidation_reason: string | null;
    }>('SELECT * FROM signal_state ORDER BY symbol')
    .map((r) => ({
      symbol: r.symbol,
      action: r.action,
      swing10Score: r.swing10_score,
      eventQuality: r.event_quality,
      tradeQuality: r.trade_quality,
      firstSeenAt: r.first_seen_at,
      updatedAt: r.updated_at,
      invalidationReason: r.invalidation_reason,
    }));

  const recentAlerts = db
    .all<{ symbol: string | null; transition: string; ts: string }>(
      'SELECT symbol, transition, ts FROM alert_log WHERE sent = 1 AND ts >= ? ORDER BY ts DESC',
      cutoff,
    );

  const processedEventKeys = db
    .all<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM events WHERE dedupe_key IS NOT NULL ORDER BY id DESC LIMIT ?',
      opts.maxEventKeys ?? 2000,
    )
    .map((r) => r.dedupe_key);

  return {
    version: SNAPSHOT_VERSION,
    exportedAt: now.toISOString(),
    processedEventKeys,
    signals,
    recentAlerts,
  };
}

export interface ImportResult {
  signalsRestored: number;
  alertsRestored: number;
  eventKeysSeen: number;
  /** Set when the snapshot was unusable; the run proceeds without state. */
  warning: string | null;
}

/**
 * Restores a snapshot into a database.
 *
 * A malformed or version-mismatched snapshot is a warning, never a failure —
 * the scan must still run. The worst consequence of ignoring state is a
 * duplicate alert, which is far better than a skipped scan.
 */
export function importState(db: Db, snapshot: unknown): ImportResult {
  const empty: ImportResult = {
    signalsRestored: 0, alertsRestored: 0, eventKeysSeen: 0, warning: null,
  };

  if (snapshot === null || typeof snapshot !== 'object') {
    return { ...empty, warning: 'snapshot is not an object; continuing without prior state' };
  }

  const state = snapshot as Partial<StateSnapshot>;
  if (state.version !== SNAPSHOT_VERSION) {
    return {
      ...empty,
      warning: `snapshot version ${String(state.version)} does not match ${SNAPSHOT_VERSION}; ignoring`,
    };
  }

  let signalsRestored = 0;
  let alertsRestored = 0;

  db.transaction(() => {
    for (const signal of state.signals ?? []) {
      if (!signal?.symbol || !signal.action) continue;
      db.run(
        `INSERT INTO signal_state
           (symbol, action, swing10_score, event_quality, trade_quality,
            first_seen_at, updated_at, invalidation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           action = excluded.action, swing10_score = excluded.swing10_score,
           event_quality = excluded.event_quality, trade_quality = excluded.trade_quality,
           updated_at = excluded.updated_at,
           invalidation_reason = excluded.invalidation_reason`,
        signal.symbol, signal.action, signal.swing10Score ?? null,
        signal.eventQuality ?? null, signal.tradeQuality ?? null,
        signal.firstSeenAt ?? signal.updatedAt ?? new Date().toISOString(),
        signal.updatedAt ?? new Date().toISOString(),
        signal.invalidationReason ?? null,
      );
      signalsRestored++;
    }

    // Alerts are restored as sent=1 so the cooldown carries across runs.
    for (const alert of state.recentAlerts ?? []) {
      if (!alert?.transition || !alert.ts) continue;
      db.run(
        `INSERT INTO alert_log (ts, symbol, transition, channel, sent, suppressed_reason)
         VALUES (?, ?, ?, 'restored', 1, NULL)`,
        alert.ts, alert.symbol ?? null, alert.transition,
      );
      alertsRestored++;
    }
  });

  return {
    signalsRestored,
    alertsRestored,
    eventKeysSeen: state.processedEventKeys?.length ?? 0,
    warning: null,
  };
}

export function writeSnapshot(path: string, snapshot: StateSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8');
}

/** Reads a snapshot. Returns null when absent or unparseable, never throws. */
export function readSnapshot(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
