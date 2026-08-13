/**
 * Scan job: runs the full decision path over stored data.
 *
 * Reads candles and events from SQLite, builds features, decides, and stores
 * every candidate — PAPER_BUY, WATCH, IGNORE and NO_TRADE alike — with its
 * complete explanation trail.
 *
 * Places no orders. Produces no alerts. It records what the algorithm thinks,
 * so that later it can be checked against what actually happened.
 */

import type { Db } from '../db/driver.ts';
import { readCandles } from '../ingest/candles.ts';
import { saveCandidate, summariseCandidates, gateHitCounts } from '../ingest/candidates.ts';
import { buildFeatures } from '../scoring/build-features.ts';
import { latestFundamentals, toFeatureFundamentals } from '../ingest/fundamentals.ts';
import { decide, type Decision, type DecideConfig } from '../scoring/decide.ts';
import { renderExplanations } from '../scoring/explain.ts';
import { assessRegime } from '../regime/market.ts';

export interface ScanOptions {
  /** Restrict to these symbols. Empty means every tradeable instrument. */
  symbols?: string[];
  /** Benchmark symbol for relative strength and regime. */
  benchmarkSymbol?: string;
  config?: DecideConfig;
  /** Print the full explanation for each candidate. */
  verbose?: boolean;
}

export interface ScanResult {
  evaluated: number;
  decisions: Decision[];
  skipped: { symbol: string; reason: string }[];
}

interface EventRow {
  id: number;
  symbol: string;
  event_type: string | null;
  source_tier: string | null;
  sentiment: string | null;
  materiality: number | null;
  filed_at: string | null;
  detection_lag_sec: number | null;
}

interface InstrumentRow {
  symbol: string;
  avg_turnover_20d: number | null;
  is_tradeable: number;
  exclusion_reason: string | null;
}

export function runScan(db: Db, opts: ScanOptions = {}): ScanResult {
  const benchmark = opts.benchmarkSymbol ?? 'NIFTY_50';
  const benchmarkCandles = readCandles(db, benchmark, '1d');
  const benchmarkCloses = benchmarkCandles.map((c) => c.close);

  const regime =
    benchmarkCloses.length >= 50 ? assessRegime({ niftyCloses: benchmarkCloses }) : undefined;

  const instruments = db.all<InstrumentRow>(
    opts.symbols && opts.symbols.length > 0
      ? `SELECT symbol, avg_turnover_20d, is_tradeable, exclusion_reason FROM instruments
          WHERE symbol IN (${opts.symbols.map(() => '?').join(',')})`
      : `SELECT symbol, avg_turnover_20d, is_tradeable, exclusion_reason FROM instruments
          ORDER BY symbol`,
    ...(opts.symbols ?? []),
  );

  const decisions: Decision[] = [];
  const skipped: { symbol: string; reason: string }[] = [];

  for (const instrument of instruments) {
    const candles = readCandles(db, instrument.symbol, '1d');
    if (candles.length < 20) {
      skipped.push({
        symbol: instrument.symbol,
        reason: `only ${candles.length} daily bars — too little history to judge structure`,
      });
      continue;
    }

    const event = db.get<EventRow>(
      `SELECT id, symbol, event_type, source_tier, sentiment, materiality,
              filed_at, detection_lag_sec
         FROM events WHERE symbol = ? ORDER BY COALESCE(filed_at, detected_at) DESC LIMIT 1`,
      instrument.symbol,
    );

    // Benchmark closes must align bar-for-bar for relative strength to mean
    // anything, so they are only supplied when the lengths match.
    const aligned =
      benchmarkCloses.length === candles.length ? benchmarkCloses : undefined;

    const features = buildFeatures({
      symbol: instrument.symbol,
      candles,
      benchmarkCloses: aligned,
      event: event
        ? {
            id: event.id,
            eventType: event.event_type,
            sourceTier: event.source_tier as 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS' | null,
            sentiment: event.sentiment as FeatureSentiment,
            materiality: event.materiality,
            filedAt: event.filed_at,
            detectionLagSec: event.detection_lag_sec,
            corroborationCount: null,
          }
        : undefined,
      fundamental: toFeatureFundamentals(latestFundamentals(db, instrument.symbol)),
      regime,
      liquidity: {
        avgTurnover20d: instrument.avg_turnover_20d,
        isTradeable: instrument.is_tradeable === 1,
        exclusionReason: instrument.exclusion_reason,
      },
    });

    const decision = decide(features, candles[candles.length - 1]!.close, opts.config);
    saveCandidate(db, decision);
    decisions.push(decision);
  }

  return { evaluated: decisions.length, decisions, skipped };
}

type FeatureSentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS' | null;

const ICON: Record<string, string> = {
  PAPER_BUY: '[BUY ]',
  WATCH: '[WTCH]',
  IGNORE: '[IGNR]',
  NO_TRADE: '[NONE]',
};

export function printScan(db: Db, result: ScanResult, verbose = false): void {
  console.log(`Evaluated ${result.evaluated} instrument(s)\n`);

  for (const { symbol, reason } of result.skipped) {
    console.log(`  skipped ${symbol}: ${reason}`);
  }
  if (result.skipped.length > 0) console.log('');

  for (const d of result.decisions) {
    console.log(
      `${ICON[d.action] ?? d.action} ${d.symbol.padEnd(12)} ` +
        `event ${String(d.eventQuality.total).padStart(3)}/100  ` +
        `trade ${String(d.tradeQuality.total).padStart(3)}/100  ` +
        `${d.pricedIn.verdict.padEnd(12)} ${d.entrySetup}`,
    );
    for (const line of d.summary) console.log(`         ${line}`);
    if (d.plan) {
      const p = d.plan;
      console.log(
        `         entry ${p.entryPrice.toFixed(2)}  qty ${p.quantity}  ` +
          `SL ${p.stopLoss.toFixed(2)} (${p.stopBasis})  ` +
          `T ${p.target.toFixed(2)} (${p.targetBasis})  R:R ${p.riskReward.toFixed(2)}  ` +
          `net ${p.expectedProfitNet.toFixed(0)}`,
      );
    }
    if (verbose) {
      for (const line of renderExplanations(d.explanations)) console.log(`  ${line}`);
      console.log('');
    }
  }

  console.log('\n─── STORED CANDIDATES ───');
  for (const row of summariseCandidates(db)) {
    console.log(
      `  ${row.action.padEnd(10)} ${String(row.count).padStart(4)}  ` +
        `avg event ${(row.avgEventQuality ?? 0).toFixed(0)}  ` +
        `avg trade ${(row.avgTradeQuality ?? 0).toFixed(0)}`,
    );
  }

  const gates = gateHitCounts(db);
  if (gates.length > 0) {
    console.log('\n─── REJECTION REASONS ───');
    for (const g of gates) console.log(`  ${g.veto_gate.padEnd(24)} ${g.count}`);
  }
}
