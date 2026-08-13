/**
 * Candle ingest.
 *
 * Persists candles with their provenance intact. Re-ingesting the same bar from
 * a higher-fidelity source upgrades it; re-ingesting from a lower-fidelity one
 * leaves the better data in place. That ordering rule is what stops a delayed
 * backfill from quietly overwriting real-time bars.
 */

import type { Db } from '../db/driver.ts';
import type { Candle, Timeframe } from '../market/types.ts';
import type { Fidelity } from '../sources/types.ts';

const FIDELITY_RANK: Record<Fidelity, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNAVAILABLE: 0,
};

export interface IngestStats {
  inserted: number;
  upgraded: number;
  skipped: number;
}

export function ingestCandles(db: Db, candles: readonly Candle[]): IngestStats {
  const stats: IngestStats = { inserted: 0, upgraded: 0, skipped: 0 };

  db.transaction(() => {
    for (const c of candles) {
      const existing = db.get<{ fidelity: Fidelity }>(
        'SELECT fidelity FROM candles WHERE symbol = ? AND tf = ? AND ts = ?',
        c.symbol,
        c.timeframe,
        c.ts,
      );

      if (existing) {
        const incoming = FIDELITY_RANK[c.provenance.fidelity] ?? 0;
        const current = FIDELITY_RANK[existing.fidelity] ?? 0;
        if (incoming <= current) {
          stats.skipped++;
          continue;
        }
        stats.upgraded++;
      } else {
        stats.inserted++;
      }

      db.run(
        `INSERT INTO candles
           (symbol, tf, ts, open, high, low, close, volume, vwap,
            source_id, latency_class, fidelity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, tf, ts) DO UPDATE SET
           open = excluded.open, high = excluded.high, low = excluded.low,
           close = excluded.close, volume = excluded.volume, vwap = excluded.vwap,
           source_id = excluded.source_id, latency_class = excluded.latency_class,
           fidelity = excluded.fidelity`,
        c.symbol,
        c.timeframe,
        c.ts,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
        c.vwap,
        c.provenance.sourceId,
        c.provenance.latencyClass,
        c.provenance.fidelity,
      );
    }
  });

  return stats;
}

export function readCandles(
  db: Db,
  symbol: string,
  timeframe: Timeframe,
  range?: { from?: string; to?: string },
): Candle[] {
  const clauses = ['symbol = ?', 'tf = ?'];
  const params: (string | number)[] = [symbol.toUpperCase(), timeframe];
  if (range?.from) {
    clauses.push('ts >= ?');
    params.push(range.from);
  }
  if (range?.to) {
    clauses.push('ts <= ?');
    params.push(range.to);
  }

  return db
    .all<{
      symbol: string; tf: Timeframe; ts: string;
      open: number; high: number; low: number; close: number;
      volume: number | null; vwap: number | null;
      source_id: string; latency_class: string; fidelity: string;
    }>(
      `SELECT * FROM candles WHERE ${clauses.join(' AND ')} ORDER BY ts`,
      ...params,
    )
    .map((r) => ({
      symbol: r.symbol,
      timeframe: r.tf,
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      vwap: r.vwap,
      provenance: {
        sourceId: r.source_id,
        latencyClass: r.latency_class as Candle['provenance']['latencyClass'],
        fidelity: r.fidelity as Fidelity,
      },
    }));
}

/**
 * Gaps in a daily series, as ISO dates present in the reference calendar but
 * missing for this symbol. Used to detect an incomplete backfill before it
 * silently distorts an indicator.
 */
export function findGaps(candles: readonly Candle[], tradingDays: readonly string[]): string[] {
  const have = new Set(candles.map((c) => c.ts));
  const first = candles[0]?.ts;
  const last = candles[candles.length - 1]?.ts;
  if (!first || !last) return [];
  return tradingDays.filter((d) => d >= first && d <= last && !have.has(d));
}
