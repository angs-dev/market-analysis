/**
 * Validation metrics.
 *
 * The point of this module is to answer one question honestly: does the
 * PAPER_BUY bucket behave differently from WATCH and IGNORE? Everything else
 * is supporting detail.
 *
 * Two disciplines are enforced here rather than left to the reader:
 *   1. Cohorts of differing data fidelity are not pooled silently. A win rate
 *      from delayed bars is not comparable with one from real-time bars.
 *   2. Every rate is reported with a confidence interval and a sample size.
 *      A 60% win rate on 12 trades is not evidence of anything, and printing
 *      it without its interval invites exactly that mistake.
 */

import type { Db } from '../db/driver.ts';
import type { Fidelity } from '../sources/types.ts';

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval — well behaved at small n and near 0 or 1, unlike the
 * normal approximation, which is precisely where this project will live for
 * its first few hundred signals.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export interface TradeMetrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  winRateInterval: Interval;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Per-trade expected return in percent, net of modelled costs. */
  expectancyPct: number | null;
  /** Gross profit divided by gross loss. Above 1 is profitable. */
  profitFactor: number | null;
  maxDrawdownPct: number;
  avgBarsToTarget: number | null;
  avgBarsToStop: number | null;
  exitBreakdown: Record<string, number>;
  /** True when the sample is too small to support any conclusion. */
  underpowered: boolean;
}

export interface HorizonMetrics {
  horizon: string;
  n: number;
  avgReturnPct: number;
  medianReturnPct: number;
  avgReturnVsNiftyPct: number | null;
  positiveRate: number;
  positiveRateInterval: Interval;
  avgMfePct: number;
  avgMaePct: number;
}

export interface BucketMetrics {
  action: string;
  candidates: number;
  byHorizon: HorizonMetrics[];
  trades: TradeMetrics | null;
}

export interface ValidationReport {
  generatedAt: string;
  totalCandidates: number;
  /** Fidelity levels present. More than one means cohorts are not comparable. */
  fidelities: Fidelity[];
  mixedFidelityWarning: string | null;
  buckets: BucketMetrics[];
  /** Does PAPER_BUY actually beat the rest? The exit criterion. */
  separation: SeparationResult | null;
  gateEffectiveness: GateEffectiveness[];
  notes: string[];
}

export interface SeparationResult {
  horizon: string;
  buyAvgReturnPct: number | null;
  watchAvgReturnPct: number | null;
  ignoreAvgReturnPct: number | null;
  buyMinusIgnorePct: number | null;
  /** Honest verdict, deliberately conservative. */
  verdict: 'INSUFFICIENT_DATA' | 'NO_SEPARATION' | 'WEAK_SEPARATION' | 'SEPARATION_PRESENT';
  rationale: string;
}

export interface GateEffectiveness {
  gate: string;
  rejected: number;
  /** Average forward return of what this gate rejected. */
  avgReturnPct: number | null;
  /** Negative means the gate rejected losers, which is what it exists to do. */
  verdict: string;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Peak-to-trough drawdown of the cumulative return series, in percent. */
export function maxDrawdown(returnsPct: readonly number[]): number {
  let equity = 100;
  let peak = 100;
  let worst = 0;
  for (const r of returnsPct) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, ((equity - peak) / peak) * 100);
  }
  return Math.abs(worst);
}

/** Minimum trades below which no conclusion is drawn. */
export const UNDERPOWERED_BELOW = 30;

export function tradeMetrics(
  rows: readonly {
    return_pct: number; result: string; exit_reason: string | null;
    time_to_target_min: number | null; time_to_stop_min: number | null;
  }[],
): TradeMetrics {
  const returns = rows.map((r) => r.return_pct);
  const wins = rows.filter((r) => r.result === 'WIN');
  const losses = rows.filter((r) => r.result === 'LOSS');
  const breakeven = rows.filter((r) => r.result === 'BREAKEVEN');

  const grossProfit = wins.reduce((s, r) => s + r.return_pct, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.return_pct, 0));

  const exitBreakdown: Record<string, number> = {};
  for (const r of rows) {
    const key = r.exit_reason ?? 'UNKNOWN';
    exitBreakdown[key] = (exitBreakdown[key] ?? 0) + 1;
  }

  const toTarget = rows.map((r) => r.time_to_target_min).filter((v): v is number => v !== null);
  const toStop = rows.map((r) => r.time_to_stop_min).filter((v): v is number => v !== null);

  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: rows.length === 0 ? 0 : wins.length / rows.length,
    winRateInterval: wilsonInterval(wins.length, rows.length),
    avgWinPct: wins.length > 0 ? mean(wins.map((r) => r.return_pct)) : null,
    avgLossPct: losses.length > 0 ? mean(losses.map((r) => r.return_pct)) : null,
    expectancyPct: rows.length > 0 ? mean(returns) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    maxDrawdownPct: maxDrawdown(returns),
    avgBarsToTarget: toTarget.length > 0 ? mean(toTarget) : null,
    avgBarsToStop: toStop.length > 0 ? mean(toStop) : null,
    exitBreakdown,
    underpowered: rows.length < UNDERPOWERED_BELOW,
  };
}

interface LabelRow {
  action: string;
  horizon: string;
  return_pct: number;
  return_vs_nifty_pct: number | null;
  mfe_pct: number;
  mae_pct: number;
  fidelity: string;
}

export function buildReport(db: Db, primaryHorizon = '5d'): ValidationReport {
  const notes: string[] = [];

  const labels = db.all<LabelRow>(
    `SELECT c.action, o.horizon, o.return_pct, o.return_vs_nifty_pct,
            o.mfe_pct, o.mae_pct, o.fidelity
       FROM outcome_labels o
       JOIN candidates c ON c.id = o.candidate_id`,
  );

  const fidelities = [...new Set(labels.map((l) => l.fidelity))] as Fidelity[];
  const mixedFidelityWarning =
    fidelities.length > 1
      ? `Labels span ${fidelities.length} fidelity levels (${fidelities.join(', ')}). ` +
        'These cohorts are not directly comparable — a win rate derived from ' +
        'delayed bars cannot be pooled with one from real-time bars. Segment ' +
        'before drawing any conclusion.'
      : null;

  const actions = db.all<{ action: string; n: number }>(
    'SELECT action, COUNT(*) AS n FROM candidates GROUP BY action',
  );

  const buckets: BucketMetrics[] = actions.map(({ action, n }) => {
    const forAction = labels.filter((l) => l.action === action);
    const horizonNames = [...new Set(forAction.map((l) => l.horizon))].sort();

    const byHorizon: HorizonMetrics[] = horizonNames.map((horizon) => {
      const rows = forAction.filter((l) => l.horizon === horizon);
      const returns = rows.map((r) => r.return_pct);
      const vsNifty = rows
        .map((r) => r.return_vs_nifty_pct)
        .filter((v): v is number => v !== null);
      const positives = returns.filter((r) => r > 0).length;

      return {
        horizon,
        n: rows.length,
        avgReturnPct: mean(returns),
        medianReturnPct: median(returns),
        avgReturnVsNiftyPct: vsNifty.length > 0 ? mean(vsNifty) : null,
        positiveRate: rows.length === 0 ? 0 : positives / rows.length,
        positiveRateInterval: wilsonInterval(positives, rows.length),
        avgMfePct: mean(rows.map((r) => r.mfe_pct)),
        avgMaePct: mean(rows.map((r) => r.mae_pct)),
      };
    });

    const tradeRows = db.all<{
      return_pct: number; result: string; exit_reason: string | null;
      time_to_target_min: number | null; time_to_stop_min: number | null;
    }>(
      `SELECT p.return_pct, p.result, p.exit_reason, p.time_to_target_min, p.time_to_stop_min
         FROM paper_trades p
         JOIN candidates c ON c.id = p.candidate_id
        WHERE c.action = ?`,
      action,
    );

    return {
      action,
      candidates: n,
      byHorizon,
      trades: tradeRows.length > 0 ? tradeMetrics(tradeRows) : null,
    };
  });

  const separation = assessSeparation(buckets, primaryHorizon);

  // Gate effectiveness: did what each gate rejected actually underperform?
  const gateRows = db.all<{ veto_gate: string; n: number; avg_return: number | null }>(
    `SELECT c.veto_gate, COUNT(*) AS n, AVG(o.return_pct) AS avg_return
       FROM candidates c
       LEFT JOIN outcome_labels o
         ON o.candidate_id = c.id AND o.horizon = ?
      WHERE c.veto_gate IS NOT NULL
      GROUP BY c.veto_gate
      ORDER BY n DESC`,
    primaryHorizon,
  );

  const gateEffectiveness: GateEffectiveness[] = gateRows.map((g) => ({
    gate: g.veto_gate,
    rejected: g.n,
    avgReturnPct: g.avg_return,
    verdict:
      g.avg_return === null
        ? 'no labelled outcomes yet'
        : // Same bar as everywhere else. Calling a gate "too strict" on a dozen
          // rejections is exactly the overconfidence this module exists to avoid.
          g.n < UNDERPOWERED_BELOW
          ? `only ${g.n} rejections — too few to judge`
          : g.avg_return < 0
            ? 'rejected candidates lost on average — the gate is doing its job'
            : 'rejected candidates gained on average — this gate may be too strict',
  }));

  if (labels.length === 0) {
    notes.push('No labelled outcomes yet. Run the labeller once forward bars exist.');
  }
  notes.push(
    'Nothing here constitutes evidence of an edge until the sample is large ' +
      'enough and spans more than one market regime.',
  );

  return {
    generatedAt: new Date().toISOString(),
    totalCandidates: actions.reduce((s, a) => s + a.n, 0),
    fidelities,
    mixedFidelityWarning,
    buckets,
    separation,
    gateEffectiveness,
    notes,
  };
}

/**
 * The exit criterion, stated conservatively.
 *
 * Requires both a meaningful gap and a minimum sample before it will say
 * anything positive. Declining to conclude is the correct answer far more often
 * than it is comfortable.
 */
export function assessSeparation(
  buckets: readonly BucketMetrics[],
  horizon: string,
): SeparationResult | null {
  const at = (action: string): HorizonMetrics | undefined =>
    buckets.find((b) => b.action === action)?.byHorizon.find((h) => h.horizon === horizon);

  const buy = at('PAPER_BUY');
  const watch = at('WATCH');
  const ignore = at('IGNORE');

  if (!buy) {
    return {
      horizon,
      buyAvgReturnPct: null, watchAvgReturnPct: watch?.avgReturnPct ?? null,
      ignoreAvgReturnPct: ignore?.avgReturnPct ?? null, buyMinusIgnorePct: null,
      verdict: 'INSUFFICIENT_DATA',
      rationale: 'no labelled PAPER_BUY candidates at this horizon',
    };
  }

  const gap = ignore ? buy.avgReturnPct - ignore.avgReturnPct : null;
  const minSample = 30;

  if (buy.n < minSample || (ignore !== undefined && ignore.n < minSample)) {
    return {
      horizon,
      buyAvgReturnPct: buy.avgReturnPct,
      watchAvgReturnPct: watch?.avgReturnPct ?? null,
      ignoreAvgReturnPct: ignore?.avgReturnPct ?? null,
      buyMinusIgnorePct: gap,
      verdict: 'INSUFFICIENT_DATA',
      rationale:
        `${buy.n} PAPER_BUY and ${ignore?.n ?? 0} IGNORE labels. At least ${minSample} ` +
        'of each is needed before the difference means anything, and 200+ before it ' +
        'is worth acting on.',
    };
  }

  if (gap === null) {
    return {
      horizon,
      buyAvgReturnPct: buy.avgReturnPct, watchAvgReturnPct: watch?.avgReturnPct ?? null,
      ignoreAvgReturnPct: null, buyMinusIgnorePct: null,
      verdict: 'INSUFFICIENT_DATA',
      rationale: 'no IGNORE bucket to compare against',
    };
  }

  if (gap <= 0) {
    return {
      horizon,
      buyAvgReturnPct: buy.avgReturnPct, watchAvgReturnPct: watch?.avgReturnPct ?? null,
      ignoreAvgReturnPct: ignore!.avgReturnPct, buyMinusIgnorePct: gap,
      verdict: 'NO_SEPARATION',
      rationale:
        'candidates the algorithm selected did no better than the ones it rejected. ' +
        'The scoring is not adding information.',
    };
  }

  return {
    horizon,
    buyAvgReturnPct: buy.avgReturnPct,
    watchAvgReturnPct: watch?.avgReturnPct ?? null,
    ignoreAvgReturnPct: ignore!.avgReturnPct,
    buyMinusIgnorePct: gap,
    verdict: gap < 1 ? 'WEAK_SEPARATION' : 'SEPARATION_PRESENT',
    rationale:
      `PAPER_BUY averaged ${gap.toFixed(2)} points more than IGNORE at ${horizon}. ` +
      (gap < 1
        ? 'The gap is small enough to be noise at this sample size.'
        : 'Worth investigating further — this is not yet proof, and the weights have ' +
          'not been validated out of sample.'),
  };
}
