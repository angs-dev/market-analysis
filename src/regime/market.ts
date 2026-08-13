/**
 * Market regime.
 *
 * Evaluated before any stock is scored. A strong setup in a collapsing market
 * is still a bad trade, and an unstable market produces NO_TRADE outright
 * rather than a downgraded score — declining to trade is a valid outcome.
 *
 * Inputs that are unavailable are recorded as missing rather than defaulted.
 * A regime scored on half the evidence must not look as confident as one
 * scored on all of it.
 */

import { ema, latest, rateOfChange } from '../technicals/indicators.ts';

export type RegimeLabel = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'UNSTABLE';
export type Trend = 'BULLISH' | 'BEARISH' | 'SIDEWAYS';

export interface RegimeInput {
  /** Nifty daily closes, ascending. */
  niftyCloses: readonly number[];
  bankNiftyCloses?: readonly number[];
  /** India VIX level and its day-on-day change in percent. */
  vix?: number | null;
  vixChangePct?: number | null;
  /** Advancing and declining counts across the universe. */
  advances?: number | null;
  declines?: number | null;
  /** Sector index returns, keyed by sector index name. */
  sectorReturns?: ReadonlyMap<string, number>;
  /** Set when a major scheduled event lands within the holding horizon. */
  majorEventAhead?: boolean;
}

export interface RegimeResult {
  label: RegimeLabel;
  /** 0..15, the market bucket of the trade-quality score. */
  score: number;
  trend: Trend;
  niftyChangePct: number | null;
  breadthRatio: number | null;
  vix: number | null;
  /** True when conditions are too disordered to trade at all. */
  unstable: boolean;
  unstableReason: string | null;
  /** 0..1, the fraction of inputs that were actually available. */
  completeness: number;
  missing: string[];
}

export const MAX_REGIME_SCORE = 15;

/** VIX above this is treated as disordered rather than merely risk-off. */
export const VIX_UNSTABLE = 28;
/** A single-session VIX spike this large is a regime break in progress. */
export const VIX_SPIKE_PCT = 25;

export function classifyTrend(closes: readonly number[]): Trend {
  if (closes.length < 50) return 'SIDEWAYS';
  const close = closes[closes.length - 1]!;
  const ema20 = latest(ema(closes, 20));
  const ema50 = latest(ema(closes, 50));
  if (ema20 === null || ema50 === null) return 'SIDEWAYS';

  if (close > ema20 && ema20 > ema50) return 'BULLISH';
  if (close < ema20 && ema20 < ema50) return 'BEARISH';
  return 'SIDEWAYS';
}

export function assessRegime(input: RegimeInput): RegimeResult {
  const missing: string[] = [];
  let available = 0;
  const total = 5;

  const closes = input.niftyCloses;
  const trend = classifyTrend(closes);
  const niftyChangePct = closes.length >= 2 ? latest(rateOfChange(closes, 1)) : null;
  if (closes.length >= 50) available++;
  else missing.push('nifty history (need 50 bars)');

  const vix = input.vix ?? null;
  if (vix !== null) available++;
  else missing.push('india vix');

  const breadthRatio =
    input.advances != null && input.declines != null && input.declines > 0
      ? input.advances / input.declines
      : null;
  if (breadthRatio !== null) available++;
  else missing.push('market breadth');

  const bankTrend =
    input.bankNiftyCloses && input.bankNiftyCloses.length >= 50
      ? classifyTrend(input.bankNiftyCloses)
      : null;
  if (bankTrend !== null) available++;
  else missing.push('bank nifty');

  if (input.sectorReturns && input.sectorReturns.size > 0) available++;
  else missing.push('sector returns');

  // ── Instability: refuse to trade rather than trade small ──────────────────
  let unstableReason: string | null = null;
  if (vix !== null && vix >= VIX_UNSTABLE) {
    unstableReason = `India VIX at ${vix.toFixed(1)} is above the ${VIX_UNSTABLE} instability threshold`;
  } else if (input.vixChangePct != null && input.vixChangePct >= VIX_SPIKE_PCT) {
    unstableReason = `India VIX spiked ${input.vixChangePct.toFixed(1)}% in a session — regime is breaking`;
  } else if (niftyChangePct !== null && Math.abs(niftyChangePct) >= 2.5) {
    unstableReason = `Nifty moved ${niftyChangePct.toFixed(2)}% in a session — disorderly`;
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  let score = 0;
  if (trend === 'BULLISH') score += 6;
  else if (trend === 'SIDEWAYS') score += 3;

  if (vix !== null) {
    if (vix < 14) score += 4;
    else if (vix < 18) score += 3;
    else if (vix < 22) score += 1;
  }

  if (breadthRatio !== null) {
    if (breadthRatio > 1.5) score += 3;
    else if (breadthRatio > 1.0) score += 2;
    else if (breadthRatio > 0.7) score += 1;
  }

  if (bankTrend === 'BULLISH') score += 2;
  else if (bankTrend === 'SIDEWAYS') score += 1;

  score = Math.max(0, Math.min(MAX_REGIME_SCORE, score));

  let label: RegimeLabel;
  if (unstableReason !== null) label = 'UNSTABLE';
  else if (score >= 11) label = 'RISK_ON';
  else if (score >= 6) label = 'NEUTRAL';
  else label = 'RISK_OFF';

  return {
    label,
    score,
    trend,
    niftyChangePct,
    breadthRatio,
    vix,
    unstable: unstableReason !== null,
    unstableReason,
    completeness: available / total,
    missing,
  };
}
