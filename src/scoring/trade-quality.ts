/**
 * TRADE QUALITY (0-100): given the event, is this a good trade right now?
 *
 * Everything about price, timing, structure and market context lives here.
 * The priced-in penalty is applied inside this score and reported separately,
 * so a chase is visibly a chase rather than being averaged away.
 */

import { Explainer } from './explain.ts';
import type { FeatureVector } from './features.ts';
import type { PricedInAssessment } from '../pricedin/engine.ts';

export interface TradeWeights {
  version: string;
  buckets: {
    marketRegime: number;
    trendRS: number;
    entryQuality: number;
    reactionQuality: number;
    volumeAccumulation: number;
    candleStructure: number;
    riskReward: number;
  };
  /** Preference ordering over entry setups, 0..1. */
  setupScores: Record<string, number>;
}

export const DEFAULT_TRADE_WEIGHTS: TradeWeights = {
  version: 'trade-v1',
  buckets: {
    marketRegime: 15,
    trendRS: 15,
    entryQuality: 25,
    reactionQuality: 15,
    volumeAccumulation: 10,
    candleStructure: 10,
    riskReward: 10,
  },
  setupScores: {
    BREAKOUT_RETEST: 1.0,
    CONTROLLED_PULLBACK: 0.95,
    CONSOLIDATION_BREAKOUT: 0.9,
    EARLY_REACTION: 0.85,
    SUPPORT_RECLAIM: 0.7,
    RELATIVE_STRENGTH: 0.5,
    NONE: 0,
  },
};

export interface TradeQualityScore {
  total: number;
  buckets: Record<string, number>;
  pricedInPenalty: number;
  confidence: number;
  weightsVersion: string;
  explanations: ReturnType<Explainer['entries']>;
}

export interface TradeQualityInput {
  features: FeatureVector;
  pricedIn: PricedInAssessment;
  /** Risk/reward of the computed plan, when one could be built. */
  riskReward: number | null;
}

export function scoreTradeQuality(
  input: TradeQualityInput,
  weights: TradeWeights = DEFAULT_TRADE_WEIGHTS,
): TradeQualityScore {
  const f = input.features;
  const ex = new Explainer('TRADE');
  const w = weights.buckets;
  const src = 'scoring/trade-quality';

  // ── Market regime ─────────────────────────────────────────────────────────
  if (f.regime.score !== null) {
    ex.add({
      bucket: 'marketRegime', feature: 'regime_score', rawValue: f.regime.score,
      comparator: '>=', threshold: 11,
      points: Math.round(Math.min(w.marketRegime, f.regime.score)), pointsMax: w.marketRegime,
      rationale: `market regime is ${f.regime.label ?? 'unknown'}` +
        (f.regime.vix !== null ? ` (VIX ${f.regime.vix.toFixed(1)})` : ''),
      sourceRef: src,
      confidence: f.regime.completeness ?? 0.5,
    });
  } else {
    ex.missing('marketRegime', 'regime_score', 'market regime not assessed', src);
  }

  // ── Trend and relative strength ───────────────────────────────────────────
  const t = f.trend;
  if (t.emaStack !== null) {
    const stackPoints = t.emaStack === 'BULLISH' ? 7 : t.emaStack === 'MIXED' ? 3 : 0;
    ex.add({
      bucket: 'trendRS', feature: 'ema_stack', rawValue: t.emaStack,
      comparator: '==', threshold: 'BULLISH', points: stackPoints, pointsMax: 7,
      rationale: t.emaStack === 'BULLISH'
        ? 'price above a rising 20 over 50 EMA structure'
        : 'moving-average structure is not supportive',
      sourceRef: src,
    });
  } else {
    ex.missing('trendRS', 'ema_stack', 'insufficient history for EMA structure', src);
  }

  if (t.rsVsNifty !== null) {
    const rsPoints = t.rsVsNifty > 8 ? 8 : t.rsVsNifty > 3 ? 6 : t.rsVsNifty > 0 ? 3 : 0;
    ex.add({
      bucket: 'trendRS', feature: 'rs_vs_nifty', rawValue: Number(t.rsVsNifty.toFixed(2)),
      comparator: '>', threshold: 3, points: rsPoints, pointsMax: 8,
      rationale: t.rsVsNifty > 0
        ? `outperforming Nifty by ${t.rsVsNifty.toFixed(1)} points`
        : 'lagging the index',
      sourceRef: src,
    });
  } else {
    ex.missing('trendRS', 'rs_vs_nifty', 'relative strength unavailable', src);
  }

  // ── Entry quality — the largest single bucket ─────────────────────────────
  const setup = f.entry.setupType;
  if (setup !== null) {
    const share = weights.setupScores[setup] ?? 0;
    ex.add({
      bucket: 'entryQuality', feature: 'entry_setup', rawValue: setup,
      comparator: 'in', threshold: 'setup preference table',
      points: Math.round(w.entryQuality * 0.6 * share), pointsMax: Math.round(w.entryQuality * 0.6),
      rationale: setup === 'NONE'
        ? 'no recognisable entry structure — nothing to define a stop against'
        : `${setup} offers a defined entry`,
      sourceRef: src,
    });
  } else {
    ex.missing('entryQuality', 'entry_setup', 'entry setup not classified', src);
  }

  // Headroom to the next resistance decides whether a target is reachable.
  const headroom = f.entry.distanceToResistancePct;
  if (headroom !== null) {
    const points = headroom > 6 ? 10 : headroom > 3 ? 7 : headroom > 1.5 ? 3 : 0;
    ex.add({
      bucket: 'entryQuality', feature: 'distance_to_resistance_pct',
      rawValue: Number(headroom.toFixed(2)), comparator: '>', threshold: 3,
      points, pointsMax: 10,
      rationale: headroom > 3
        ? `${headroom.toFixed(1)}% of clear air to the next resistance`
        : `resistance only ${headroom.toFixed(1)}% away — little room to a target`,
      sourceRef: src,
    });
  } else {
    ex.missing('entryQuality', 'distance_to_resistance_pct', 'no resistance level identified', src);
  }

  // ── Reaction quality ──────────────────────────────────────────────────────
  const vwapPosition = f.volume.vwapPosition;
  if (vwapPosition !== null) {
    ex.add({
      bucket: 'reactionQuality', feature: 'vwap_position', rawValue: vwapPosition,
      comparator: '==', threshold: 'ABOVE',
      points: vwapPosition === 'ABOVE' ? 8 : vwapPosition === 'AT' ? 4 : 0, pointsMax: 8,
      rationale: vwapPosition === 'ABOVE'
        ? 'trading above VWAP — buyers in control of the session'
        : 'below VWAP — the average participant today is underwater',
      sourceRef: src,
    });
  } else {
    ex.missing('reactionQuality', 'vwap_position', 'VWAP unavailable at this tier', src);
  }

  const change = f.momentum.changeSinceEventPct;
  if (change !== null) {
    // A move that is present but small is the sweet spot: confirmation without
    // the price already gone.
    const points = change > 0.3 && change < 3 ? 7 : change >= 3 ? 2 : change > 0 ? 4 : 0;
    ex.add({
      bucket: 'reactionQuality', feature: 'change_since_event_pct',
      rawValue: Number(change.toFixed(2)), comparator: 'range', threshold: '0.3..3.0',
      points, pointsMax: 7,
      rationale: change > 0.3 && change < 3
        ? 'the market is reacting but the move is still early'
        : change >= 3 ? 'the move is already well advanced' : 'no meaningful reaction yet',
      sourceRef: src,
    });
  } else {
    ex.missing('reactionQuality', 'change_since_event_pct', 'no post-event move measured', src);
  }

  // ── Volume and accumulation ───────────────────────────────────────────────
  const volumeRatio = f.volume.volumeRatio;
  if (volumeRatio !== null) {
    const points =
      volumeRatio >= 3 ? 10 : volumeRatio >= 2 ? 8 : volumeRatio >= 1.5 ? 5 : volumeRatio >= 1 ? 2 : 0;
    ex.add({
      bucket: 'volumeAccumulation', feature: 'volume_ratio',
      rawValue: Number(volumeRatio.toFixed(2)), comparator: '>=', threshold: 2,
      points, pointsMax: w.volumeAccumulation,
      rationale: volumeRatio >= 2
        ? `${volumeRatio.toFixed(1)}x normal volume — genuine participation`
        : 'volume does not confirm the move',
      sourceRef: src,
    });
  } else {
    ex.missing('volumeAccumulation', 'volume_ratio', 'volume ratio unavailable', src);
  }

  // ── Candle structure ──────────────────────────────────────────────────────
  if (f.candle.patternBias !== null) {
    const bias = f.candle.patternBias;
    const strength = f.candle.patternStrength ?? 0.5;
    const points =
      bias === 'BULLISH' ? Math.round(6 * strength) : bias === 'BEARISH' ? -3 : 0;
    ex.add({
      bucket: 'candleStructure', feature: 'candle_pattern',
      rawValue: f.candle.pattern ?? 'NONE', comparator: '==', threshold: 'BULLISH bias',
      points, pointsMax: 6,
      rationale: `${f.candle.pattern ?? 'no pattern'} (${bias.toLowerCase()})`,
      sourceRef: src,
    });
  } else {
    ex.missing('candleStructure', 'candle_pattern', 'candle pattern not detected', src);
  }

  const cs = f.candle.closingStrength;
  if (cs !== null) {
    const points = cs > 0.7 ? 4 : cs > 0.5 ? 2 : 0;
    ex.add({
      bucket: 'candleStructure', feature: 'closing_strength',
      rawValue: Number(cs.toFixed(2)), comparator: '>', threshold: 0.7,
      points, pointsMax: 4,
      rationale: cs > 0.7 ? 'closed in the top third of its range' : 'weak close within the bar',
      sourceRef: src,
    });
  }

  // ── Risk/reward ───────────────────────────────────────────────────────────
  const rr = input.riskReward;
  if (rr !== null) {
    const points = rr >= 3 ? 10 : rr >= 2 ? 8 : rr >= 1.5 ? 5 : 0;
    ex.add({
      bucket: 'riskReward', feature: 'risk_reward', rawValue: Number(rr.toFixed(2)),
      comparator: '>=', threshold: 1.5, points, pointsMax: w.riskReward,
      rationale: rr >= 1.5
        ? `${rr.toFixed(1)}:1 on structure-derived stop and target`
        : `${rr.toFixed(1)}:1 does not justify the risk`,
      sourceRef: src,
    });
  } else {
    ex.missing('riskReward', 'risk_reward', 'no trade plan could be constructed', src);
  }

  // ── Priced-in penalty, applied last and reported separately ───────────────
  const penalty = input.pricedIn.penaltyPoints;
  if (penalty !== 0) {
    ex.add({
      bucket: 'pricedIn', feature: 'priced_in_verdict', rawValue: input.pricedIn.verdict,
      comparator: '==', threshold: 'EARLY', points: penalty,
      rationale: input.pricedIn.pricedInRatio !== null
        ? `${(input.pricedIn.pricedInRatio * 100).toFixed(0)}% of the expected move is already done`
        : 'price is extended relative to its own structure',
      sourceRef: 'pricedin/engine',
      confidence: input.pricedIn.expectedMoveConfidence,
    });
  }

  const buckets: Record<string, number> = {};
  for (const bucket of Object.keys(w)) buckets[bucket] = ex.bucketTotal(bucket);
  buckets['pricedIn'] = penalty;

  return {
    total: Math.max(0, Math.min(100, Math.round(ex.total()))),
    buckets,
    pricedInPenalty: penalty,
    confidence: ex.confidence(),
    weightsVersion: weights.version,
    explanations: ex.entries(),
  };
}
