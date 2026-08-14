/**
 * Stage 1 — the light screener.
 *
 * Runs over the whole universe every cycle and answers one cheap question per
 * symbol: is there any reason to look harder? Deep analysis costs indicator
 * computation, structure detection and scoring on hundreds of bars; running it
 * on 500 symbols every minute would be both wasteful and, against rate-limited
 * sources, impossible.
 *
 * Everything here reads from SQLite only. No network calls happen in stage 1.
 */

import type { Db } from '../db/driver.ts';
import type { TriggerConfig } from '../config/index.ts';
import type { ScreenHit, TriggerReason } from './types.ts';

export interface ScreenOptions {
  triggers: TriggerConfig;
  /** Events detected at or after this instant count as new. */
  since: string;
  /** Cap on how many symbols are promoted. */
  maxDeep: number;
  /** Symbols always promoted, e.g. those with open paper positions. */
  alwaysInclude?: readonly string[];
  maxEventAgeMinutes: number;
  now?: Date;
}

interface ScreenRow {
  symbol: string;
  last_close: number | null;
  prev_close: number | null;
  volume: number | null;
  avg_volume_20: number | null;
  is_tradeable: number;
}

/**
 * Screens the tradeable universe.
 *
 * A symbol can be promoted by any one of four signals. They are additive:
 * a symbol with both a fresh event and unusual volume outranks one with only
 * volume, because agreement between independent signals is itself information.
 */
export function screen(db: Db, opts: ScreenOptions): ScreenHit[] {
  const hits = new Map<string, ScreenHit>();

  const add = (symbol: string, reason: TriggerReason, weight: number, detail: string): void => {
    const existing = hits.get(symbol);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.priority += weight;
      existing.detail.push(detail);
    } else {
      hits.set(symbol, { symbol, reasons: [reason], priority: weight, detail: [detail] });
    }
  };

  // ── 1. New material events ────────────────────────────────────────────────
  const events = db.all<{
    symbol: string; event_type: string | null; materiality: number | null;
    headline: string; filed_at: string | null; detected_at: string | null;
  }>(
    `SELECT symbol, event_type, materiality, headline, filed_at, detected_at
       FROM events
      WHERE symbol IS NOT NULL
        AND COALESCE(detected_at, filed_at) >= ?
      ORDER BY COALESCE(detected_at, filed_at) DESC`,
    opts.since,
  );

  const nowMs = (opts.now ?? new Date()).getTime();
  for (const event of events) {
    const stamp = event.filed_at ?? event.detected_at;
    if (stamp) {
      const ageMin = (nowMs - Date.parse(stamp)) / 60_000;
      // A filing from three days ago is not a live catalyst.
      if (Number.isFinite(ageMin) && ageMin > opts.maxEventAgeMinutes) continue;
    }
    const materiality = event.materiality ?? 0;
    if (materiality < opts.triggers.materiality) continue;

    add(
      event.symbol,
      'NEW_EVENT',
      100 + materiality * 50,
      `${event.event_type ?? 'event'} (materiality ${materiality.toFixed(2)}): ${event.headline.slice(0, 80)}`,
    );
  }

  // ── 2-4. Price, volume and structure, from the most recent two bars ───────
  const rows = db.all<ScreenRow>(
    `WITH latest AS (
       SELECT symbol, MAX(ts) AS ts FROM candles WHERE tf = '1d' GROUP BY symbol
     )
     SELECT i.symbol,
            c.close  AS last_close,
            c.volume AS volume,
            (SELECT close FROM candles p
              WHERE p.symbol = i.symbol AND p.tf = '1d' AND p.ts < c.ts
              ORDER BY p.ts DESC LIMIT 1) AS prev_close,
            (SELECT AVG(v.volume) FROM (
               SELECT volume FROM candles a
                WHERE a.symbol = i.symbol AND a.tf = '1d' AND a.ts < c.ts
                ORDER BY a.ts DESC LIMIT 20
             ) v) AS avg_volume_20,
            i.is_tradeable
       FROM instruments i
       JOIN latest l ON l.symbol = i.symbol
       JOIN candles c ON c.symbol = i.symbol AND c.tf = '1d' AND c.ts = l.ts
      WHERE i.is_tradeable = 1`,
  );

  for (const row of rows) {
    if (row.last_close === null) continue;

    if (row.prev_close !== null && row.prev_close > 0) {
      const changePct = ((row.last_close - row.prev_close) / row.prev_close) * 100;
      if (Math.abs(changePct) >= opts.triggers.priceMovePct) {
        add(
          row.symbol, 'PRICE_MOVE', 40 + Math.min(30, Math.abs(changePct)),
          `moved ${changePct.toFixed(2)}% on the session`,
        );
      }
    }

    if (row.volume !== null && row.avg_volume_20 !== null && row.avg_volume_20 > 0) {
      const ratio = row.volume / row.avg_volume_20;
      if (ratio >= opts.triggers.volumeRatio) {
        add(
          row.symbol, 'UNUSUAL_VOLUME', 40 + Math.min(40, ratio * 5),
          `volume ${ratio.toFixed(1)}x its 20-day average`,
        );
      }
    }
  }

  // ── Open positions are always re-evaluated ────────────────────────────────
  for (const symbol of opts.alwaysInclude ?? []) {
    add(symbol, 'OPEN_POSITION', 200, 'has an open paper position requiring monitoring');
  }

  return [...hits.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, opts.maxDeep);
}

/** Symbols with an unresolved paper position. */
export function symbolsWithOpenPositions(db: Db): string[] {
  return db
    .all<{ symbol: string }>(
      `SELECT DISTINCT c.symbol
         FROM paper_trades p
         JOIN candidates c ON c.id = p.candidate_id
        WHERE p.result = 'OPEN' OR p.exit_ts IS NULL`,
    )
    .map((r) => r.symbol);
}
