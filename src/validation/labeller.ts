/**
 * Outcome labelling.
 *
 * Attaches what actually happened to every candidate — including the ones that
 * were rejected. Labelling only the trades taken would make the most important
 * question unanswerable: were the things the gates threw away actually bad?
 *
 * Two independent things are recorded:
 *   1. Forward returns at fixed horizons, for every candidate regardless of
 *      action. This is the unbiased comparison across action buckets.
 *   2. A simulated paper trade for candidates that had a plan, walking bars
 *      forward to a stop, target or time exit.
 */

import type { Db } from '../db/driver.ts';
import { readCandles } from '../ingest/candles.ts';
import { roundTripCost, DEFAULT_COSTS, type CostConfig } from '../paper/cost-model.ts';
import type { Candle } from '../market/types.ts';
import type { Fidelity } from '../sources/types.ts';

/** Horizons in trading bars, not calendar days. Weekends are not outcomes. */
export const DEFAULT_HORIZONS: Record<string, number> = {
  '1d': 1,
  '3d': 3,
  '5d': 5,
  '10d': 10,
};

export interface LabelOptions {
  horizons?: Record<string, number>;
  /** Benchmark for market-relative returns. */
  benchmarkSymbol?: string;
  /** Bars after which an open simulated trade is closed at market. */
  maxHoldBars?: number;
  costs?: CostConfig;
  /** Re-label candidates that already have labels. */
  force?: boolean;
}

export interface LabelStats {
  candidatesConsidered: number;
  labelled: number;
  skippedNoForwardData: number;
  tradesSimulated: number;
}

interface CandidateRow {
  id: number;
  ts: string;
  symbol: string;
  action: string;
}

interface PlanRow {
  entry_price: number;
  quantity: number;
  stop_loss: number;
  target: number;
}

/** Index of the first bar strictly after the decision timestamp. */
function firstBarAfter(candles: readonly Candle[], ts: string): number {
  const key = ts.slice(0, 10);
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.ts.slice(0, 10) > key) return i;
  }
  return -1;
}

/** Weakest fidelity among the bars used — a cohort is only as good as its worst data. */
function weakestFidelity(bars: readonly Candle[]): Fidelity {
  const rank: Record<Fidelity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNAVAILABLE: 0 };
  let worst: Fidelity = 'HIGH';
  for (const bar of bars) {
    if (rank[bar.provenance.fidelity] < rank[worst]) worst = bar.provenance.fidelity;
  }
  return worst;
}

export type ExitReason = 'TARGET' | 'STOP' | 'TIME' | 'INVALIDATION' | 'REGIME';

export interface SimulatedTrade {
  entryTs: string;
  entryPrice: number;
  quantity: number;
  exitTs: string;
  exitPrice: number;
  exitReason: ExitReason;
  barsHeld: number;
  mfePct: number;
  maePct: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  returnPct: number;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN';
}

/**
 * Walks bars forward from the entry to a stop, target or time exit.
 *
 * When a single bar's range covers both the stop and the target, the stop is
 * assumed to have been hit first. Daily bars do not record the order in which
 * the extremes traded, and assuming the favourable one is how a backtest
 * flatters itself into an edge it does not have.
 */
export function simulateTrade(
  bars: readonly Candle[],
  plan: { entryPrice: number; quantity: number; stopLoss: number; target: number },
  maxHoldBars = 10,
  costs: CostConfig = DEFAULT_COSTS,
): SimulatedTrade | null {
  if (bars.length === 0) return null;

  const { entryPrice, quantity, stopLoss, target } = plan;
  let mfe = -Infinity;
  let mae = Infinity;
  let exitPrice = entryPrice;
  let exitReason: ExitReason = 'TIME';
  let exitIndex = Math.min(bars.length, maxHoldBars) - 1;

  const limit = Math.min(bars.length, maxHoldBars);
  for (let i = 0; i < limit; i++) {
    const bar = bars[i]!;
    mfe = Math.max(mfe, ((bar.high - entryPrice) / entryPrice) * 100);
    mae = Math.min(mae, ((bar.low - entryPrice) / entryPrice) * 100);

    const stopHit = bar.low <= stopLoss;
    const targetHit = bar.high >= target;

    if (stopHit) {
      // Pessimistic ordering, deliberately.
      exitPrice = stopLoss;
      exitReason = 'STOP';
      exitIndex = i;
      break;
    }
    if (targetHit) {
      exitPrice = target;
      exitReason = 'TARGET';
      exitIndex = i;
      break;
    }
  }

  if (exitReason === 'TIME') {
    const lastBar = bars[exitIndex];
    if (!lastBar) return null;
    exitPrice = lastBar.close;
  }

  const grossPnl = (exitPrice - entryPrice) * quantity;
  const cost = roundTripCost(entryPrice, exitPrice, quantity, costs).total;
  const netPnl = grossPnl - cost;

  return {
    entryTs: bars[0]!.ts,
    entryPrice,
    quantity,
    exitTs: bars[exitIndex]!.ts,
    exitPrice,
    exitReason,
    barsHeld: exitIndex + 1,
    mfePct: Number.isFinite(mfe) ? mfe : 0,
    maePct: Number.isFinite(mae) ? mae : 0,
    grossPnl,
    costs: cost,
    netPnl,
    returnPct: (netPnl / (entryPrice * quantity)) * 100,
    result: netPnl > 0 ? 'WIN' : netPnl < 0 ? 'LOSS' : 'BREAKEVEN',
  };
}

export function labelCandidates(db: Db, opts: LabelOptions = {}): LabelStats {
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const maxHorizon = Math.max(...Object.values(horizons));
  const maxHold = opts.maxHoldBars ?? maxHorizon;
  const benchmark = opts.benchmarkSymbol ?? 'NIFTY_50';

  const benchmarkCandles = readCandles(db, benchmark, '1d');
  const candlesBySymbol = new Map<string, Candle[]>();

  const stats: LabelStats = {
    candidatesConsidered: 0,
    labelled: 0,
    skippedNoForwardData: 0,
    tradesSimulated: 0,
  };

  const candidates = db.all<CandidateRow>(
    opts.force
      ? 'SELECT id, ts, symbol, action FROM candidates ORDER BY ts'
      : `SELECT c.id, c.ts, c.symbol, c.action FROM candidates c
          WHERE NOT EXISTS (SELECT 1 FROM outcome_labels o WHERE o.candidate_id = c.id)
          ORDER BY c.ts`,
  );

  db.transaction(() => {
    for (const candidate of candidates) {
      stats.candidatesConsidered++;

      let candles = candlesBySymbol.get(candidate.symbol);
      if (!candles) {
        candles = readCandles(db, candidate.symbol, '1d');
        candlesBySymbol.set(candidate.symbol, candles);
      }

      const start = firstBarAfter(candles, candidate.ts);
      if (start === -1) {
        // The future has not happened yet. Not an error — just not labellable.
        stats.skippedNoForwardData++;
        continue;
      }

      const decisionBar = candles[start - 1];
      const basePrice = decisionBar?.close ?? candles[start]!.open;
      const forward = candles.slice(start);
      const benchStart = firstBarAfter(benchmarkCandles, candidate.ts);
      const benchForward = benchStart === -1 ? [] : benchmarkCandles.slice(benchStart);
      const benchBase = benchStart > 0 ? benchmarkCandles[benchStart - 1]!.close : null;

      let wroteAny = false;

      for (const [name, bars] of Object.entries(horizons)) {
        if (forward.length < bars) continue;

        const window = forward.slice(0, bars);
        const endBar = window[window.length - 1]!;
        const returnPct = ((endBar.close - basePrice) / basePrice) * 100;

        let returnVsNifty: number | null = null;
        if (benchBase !== null && benchForward.length >= bars) {
          const benchEnd = benchForward[bars - 1]!;
          returnVsNifty = returnPct - ((benchEnd.close - benchBase) / benchBase) * 100;
        }

        const mfe = Math.max(...window.map((b) => ((b.high - basePrice) / basePrice) * 100));
        const mae = Math.min(...window.map((b) => ((b.low - basePrice) / basePrice) * 100));

        db.run(
          `INSERT INTO outcome_labels
             (candidate_id, horizon, price, return_pct, return_vs_nifty_pct,
              mfe_pct, mae_pct, fidelity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(candidate_id, horizon) DO UPDATE SET
             price = excluded.price, return_pct = excluded.return_pct,
             return_vs_nifty_pct = excluded.return_vs_nifty_pct,
             mfe_pct = excluded.mfe_pct, mae_pct = excluded.mae_pct,
             fidelity = excluded.fidelity`,
          candidate.id, name, endBar.close, returnPct, returnVsNifty,
          mfe, mae, weakestFidelity(window),
        );
        wroteAny = true;
      }

      if (wroteAny) stats.labelled++;

      // Simulated trade, for candidates that had a plan.
      const plan = db.get<PlanRow>(
        'SELECT entry_price, quantity, stop_loss, target FROM trade_plans WHERE candidate_id = ?',
        candidate.id,
      );
      if (plan && forward.length > 0) {
        const trade = simulateTrade(forward, {
          entryPrice: plan.entry_price,
          quantity: plan.quantity,
          stopLoss: plan.stop_loss,
          target: plan.target,
        }, maxHold, opts.costs);

        if (trade) {
          db.run('DELETE FROM paper_trades WHERE candidate_id = ?', candidate.id);
          db.run(
            `INSERT INTO paper_trades
               (candidate_id, entry_ts, entry_price, quantity, exit_ts, exit_price,
                exit_reason, mfe_pct, mae_pct, time_to_target_min, time_to_stop_min,
                gross_pnl, costs, net_pnl, return_pct, result)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            candidate.id, trade.entryTs, trade.entryPrice, trade.quantity,
            trade.exitTs, trade.exitPrice, trade.exitReason,
            trade.mfePct, trade.maePct,
            trade.exitReason === 'TARGET' ? trade.barsHeld : null,
            trade.exitReason === 'STOP' ? trade.barsHeld : null,
            trade.grossPnl, trade.costs, trade.netPnl, trade.returnPct, trade.result,
          );
          stats.tradesSimulated++;
        }
      }
    }
  });

  return stats;
}
