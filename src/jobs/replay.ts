/**
 * Historical replay.
 *
 * Walks forward through trading dates and decides as of each one, using only
 * the bars that existed at that moment.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO LOOKAHEAD. This is the property the entire validation loop rests on.
 *
 * Every slice passed downstream ends at the as-of bar. If a future bar leaked
 * into feature construction, the replay would manufacture an edge that does
 * not exist and every metric downstream would be a lie. The slicing is done in
 * exactly one place, here, and asserted by test.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { Db } from '../db/driver.ts';
import { readCandles } from '../ingest/candles.ts';
import { saveCandidate } from '../ingest/candidates.ts';
import { buildFeatures } from '../scoring/build-features.ts';
import { latestFundamentals, toFeatureFundamentals } from '../ingest/fundamentals.ts';
import { decide, type Decision, type DecideConfig } from '../scoring/decide.ts';
import { assessRegime } from '../regime/market.ts';
import type { Candle } from '../market/types.ts';

export interface ReplayOptions {
  from: string;
  to: string;
  symbols?: string[];
  benchmarkSymbol?: string;
  config?: DecideConfig;
  /** Bars of history required before a symbol is evaluated at all. */
  minHistoryBars?: number;
  /** Only decide on dates where an event was filed for that symbol. */
  eventDrivenOnly?: boolean;
  /** Persist candidates. Off for dry runs. */
  persist?: boolean;
}

export interface ReplayResult {
  datesEvaluated: number;
  decisionsMade: number;
  byAction: Record<string, number>;
  skipped: { symbol: string; reason: string }[];
  decisions: Decision[];
}

interface EventRow {
  id: number;
  symbol: string;
  event_type: string | null;
  source_tier: string | null;
  sentiment: string | null;
  materiality: number | null;
  filed_at: string | null;
  detected_at: string | null;
  detection_lag_sec: number | null;
}

function dateKey(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Bars up to and including `asOf`. The only place history is truncated.
 * Returns an empty array when the symbol had no bar on or before that date.
 */
export function barsAsOf(candles: readonly Candle[], asOf: string): Candle[] {
  const key = dateKey(asOf);
  const out: Candle[] = [];
  for (const candle of candles) {
    if (dateKey(candle.ts) > key) break;
    out.push(candle);
  }
  return out;
}

export function runReplay(db: Db, opts: ReplayOptions): ReplayResult {
  const benchmarkSymbol = opts.benchmarkSymbol ?? 'NIFTY_50';
  const minHistory = opts.minHistoryBars ?? 50;
  const persist = opts.persist ?? true;

  const allBenchmark = readCandles(db, benchmarkSymbol, '1d');

  const symbols =
    opts.symbols && opts.symbols.length > 0
      ? opts.symbols
      : db
          .all<{ symbol: string }>('SELECT symbol FROM instruments ORDER BY symbol')
          .map((r) => r.symbol);

  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    candlesBySymbol.set(symbol, readCandles(db, symbol, '1d'));
  }

  const instruments = new Map(
    db
      .all<{ symbol: string; avg_turnover_20d: number | null; is_tradeable: number; exclusion_reason: string | null }>(
        'SELECT symbol, avg_turnover_20d, is_tradeable, exclusion_reason FROM instruments',
      )
      .map((r) => [r.symbol, r]),
  );

  // Every trading date in range that any symbol has a bar for.
  const dates = [
    ...new Set(
      [...candlesBySymbol.values()]
        .flat()
        .map((c) => dateKey(c.ts))
        .filter((d) => d >= dateKey(opts.from) && d <= dateKey(opts.to)),
    ),
  ].sort();

  const result: ReplayResult = {
    datesEvaluated: 0,
    decisionsMade: 0,
    byAction: {},
    skipped: [],
    decisions: [],
  };

  for (const asOf of dates) {
    result.datesEvaluated++;

    // Benchmark truncated to the same instant.
    const benchmarkBars = barsAsOf(allBenchmark, asOf);
    const benchmarkCloses = benchmarkBars.map((c) => c.close);
    const regime =
      benchmarkCloses.length >= 50 ? assessRegime({ niftyCloses: benchmarkCloses }) : undefined;

    for (const symbol of symbols) {
      const history = barsAsOf(candlesBySymbol.get(symbol) ?? [], asOf);

      // The symbol must actually have traded on this date.
      const lastBar = history[history.length - 1];
      if (!lastBar || dateKey(lastBar.ts) !== asOf) continue;

      if (history.length < minHistory) continue;

      // Events filed on or before the as-of date only.
      const event = db.get<EventRow>(
        `SELECT id, symbol, event_type, source_tier, sentiment, materiality,
                filed_at, detected_at, detection_lag_sec
           FROM events
          WHERE symbol = ?
            AND substr(COALESCE(filed_at, detected_at), 1, 10) <= ?
          ORDER BY COALESCE(filed_at, detected_at) DESC
          LIMIT 1`,
        symbol,
        asOf,
      );

      if (opts.eventDrivenOnly) {
        const eventDate = event ? dateKey(event.filed_at ?? event.detected_at ?? '') : null;
        if (eventDate !== asOf) continue;
      }

      const instrument = instruments.get(symbol);
      const aligned =
        benchmarkCloses.length === history.length ? benchmarkCloses : undefined;

      const features = buildFeatures({
        symbol,
        candles: history,
        benchmarkCloses: aligned,
        event: event
          ? {
              id: event.id,
              eventType: event.event_type,
              sourceTier: event.source_tier as 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS' | null,
              sentiment: event.sentiment as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS' | null,
              materiality: event.materiality,
              filedAt: event.filed_at,
              detectionLagSec: event.detection_lag_sec,
              corroborationCount: null,
            }
          : undefined,
        fundamental: toFeatureFundamentals(latestFundamentals(db, symbol, asOf)),
      regime,
        liquidity: instrument
          ? {
              avgTurnover20d: instrument.avg_turnover_20d,
              isTradeable: instrument.is_tradeable === 1,
              exclusionReason: instrument.exclusion_reason,
            }
          : undefined,
      });

      // Stamp the decision with the as-of date, not today.
      features.meta.ts = lastBar.ts;

      const decision = decide(features, lastBar.close, opts.config);
      if (persist) saveCandidate(db, decision);

      result.decisions.push(decision);
      result.decisionsMade++;
      result.byAction[decision.action] = (result.byAction[decision.action] ?? 0) + 1;
    }
  }

  return result;
}
