/**
 * FeatureVector — the raw, unscored inputs to a decision.
 *
 * This shape is persisted verbatim in candidate_features. That is what makes
 * offline weight re-optimisation possible: storing `volumeRatio: 4.2` lets the
 * whole history be re-scored under new weights in seconds, whereas storing only
 * `volumeScore: 8` throws the information away permanently.
 *
 * Every field is nullable. A missing feature is null and is recorded as missing
 * — it is never imputed to a plausible-looking default.
 */

import type { BreakoutStatus } from '../technicals/structure.ts';
import type { CandlePattern } from '../technicals/patterns.ts';
import type { RegimeLabel, Trend } from '../regime/market.ts';
import type { LatencyClass } from '../sources/types.ts';

export const FEATURE_SCHEMA_VERSION = 1;

export type EarningsQuality =
  | 'OPERATING' | 'ONE_OFF' | 'EXCEPTIONAL_INCOME'
  | 'TAX_BENEFIT' | 'ASSET_SALE' | 'ACCOUNTING' | 'UNKNOWN';

export type EntrySetup =
  | 'EARLY_REACTION'
  | 'CONTROLLED_PULLBACK'
  | 'BREAKOUT_RETEST'
  | 'CONSOLIDATION_BREAKOUT'
  | 'SUPPORT_RECLAIM'
  | 'RELATIVE_STRENGTH'
  | 'NONE';

export interface FeatureVector {
  meta: {
    symbol: string;
    ts: string;
    eventId: number | null;
    schemaVersion: number;
    /** Names of features that had no data. */
    missing: string[];
    /** Data tier that produced this vector. */
    tier: 0 | 1 | 2;
  };

  event: {
    eventType: string | null;
    sourceTier: 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS' | null;
    materiality: number | null;
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS' | null;
    minutesSinceEvent: number | null;
    /** How many independent sources reported it. */
    corroborationCount: number | null;
    detectionLagSec: number | null;
  };

  fundamental: {
    revenueYoY: number | null;
    revenueQoQ: number | null;
    patYoY: number | null;
    patQoQ: number | null;
    ebitdaYoY: number | null;
    ebitdaMarginDeltaYoY: number | null;
    epsYoY: number | null;
    earningsQuality: EarningsQuality | null;
    qualityConfidence: number | null;
    pe: number | null;
    debtEquity: number | null;
    roe: number | null;
  };

  trend: {
    emaStack: 'BULLISH' | 'BEARISH' | 'MIXED' | null;
    pctFrom20Ema: number | null;
    pctFrom50Ema: number | null;
    rsVsNifty: number | null;
    rsVsSector: number | null;
    pctFrom52wHigh: number | null;
    pctOf52wRange: number | null;
  };

  momentum: {
    rsi14: number | null;
    rsi14Prev: number | null;
    dayChangePct: number | null;
    changeSinceEventPct: number | null;
    atrPct: number | null;
  };

  candle: {
    pattern: CandlePattern | null;
    patternStrength: number | null;
    patternBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
    closingStrength: number | null;
    upperWickPct: number | null;
    lowerWickPct: number | null;
  };

  volume: {
    volumeRatio: number | null;
    vwapPosition: 'ABOVE' | 'BELOW' | 'AT' | null;
    vwapDistPct: number | null;
    deliveryPct: number | null;
  };

  entry: {
    setupType: EntrySetup | null;
    breakoutStatus: BreakoutStatus | null;
    breakoutLevel: number | null;
    support: number | null;
    resistance: number | null;
    distanceToSupportPct: number | null;
    distanceToResistancePct: number | null;
    consolidationDays: number | null;
    atrBurnRatio: number | null;
  };

  liquidity: {
    avgTurnover20d: number | null;
    isTradeable: boolean | null;
    exclusionReason: string | null;
  };

  regime: {
    label: RegimeLabel | null;
    score: number | null;
    trend: Trend | null;
    niftyChangePct: number | null;
    vix: number | null;
    breadthRatio: number | null;
    unstable: boolean | null;
    completeness: number | null;
  };

  risk: {
    daysToNextResults: number | null;
    hasUpcomingMacroEvent: boolean | null;
    negativeEventPresent: boolean | null;
    dataStale: boolean | null;
  };

  /** Latency class per contributing source. Never claim REALTIME falsely. */
  provenance: Record<string, LatencyClass>;
}

/** An empty vector with everything null. Builders fill what they can find. */
export function emptyFeatures(
  symbol: string,
  ts: string,
  tier: 0 | 1 | 2 = 0,
): FeatureVector {
  return {
    meta: { symbol, ts, eventId: null, schemaVersion: FEATURE_SCHEMA_VERSION, missing: [], tier },
    event: {
      eventType: null, sourceTier: null, materiality: null, sentiment: null,
      minutesSinceEvent: null, corroborationCount: null, detectionLagSec: null,
    },
    fundamental: {
      revenueYoY: null, revenueQoQ: null, patYoY: null, patQoQ: null, ebitdaYoY: null,
      ebitdaMarginDeltaYoY: null, epsYoY: null, earningsQuality: null,
      qualityConfidence: null, pe: null, debtEquity: null, roe: null,
    },
    trend: {
      emaStack: null, pctFrom20Ema: null, pctFrom50Ema: null, rsVsNifty: null,
      rsVsSector: null, pctFrom52wHigh: null, pctOf52wRange: null,
    },
    momentum: {
      rsi14: null, rsi14Prev: null, dayChangePct: null,
      changeSinceEventPct: null, atrPct: null,
    },
    candle: {
      pattern: null, patternStrength: null, patternBias: null,
      closingStrength: null, upperWickPct: null, lowerWickPct: null,
    },
    volume: { volumeRatio: null, vwapPosition: null, vwapDistPct: null, deliveryPct: null },
    entry: {
      setupType: null, breakoutStatus: null, breakoutLevel: null, support: null,
      resistance: null, distanceToSupportPct: null, distanceToResistancePct: null,
      consolidationDays: null, atrBurnRatio: null,
    },
    liquidity: { avgTurnover20d: null, isTradeable: null, exclusionReason: null },
    regime: {
      label: null, score: null, trend: null, niftyChangePct: null, vix: null,
      breadthRatio: null, unstable: null, completeness: null,
    },
    risk: {
      daysToNextResults: null, hasUpcomingMacroEvent: null,
      negativeEventPresent: null, dataStale: null,
    },
    provenance: {},
  };
}

/**
 * Classifies the entry setup from structure and reaction.
 *
 * Ordered by preference: a controlled pullback and a breakout retest are the
 * best entries because they offer a defined stop, whereas an extended breakout
 * offers none. Returns NONE when nothing qualifies — which is a valid answer.
 */
export function classifyEntrySetup(f: FeatureVector): EntrySetup {
  const e = f.entry;
  const m = f.momentum;
  const t = f.trend;

  if (e.breakoutStatus === 'FAILED') return 'NONE';

  if (e.breakoutStatus === 'RETEST') return 'BREAKOUT_RETEST';

  if (
    e.breakoutStatus === 'CLEAN' &&
    e.consolidationDays !== null && e.consolidationDays >= 5
  ) {
    return 'CONSOLIDATION_BREAKOUT';
  }

  // Early reaction: the event has moved price a little, not a lot.
  if (
    m.changeSinceEventPct !== null &&
    m.changeSinceEventPct > 0.3 && m.changeSinceEventPct < 3.5 &&
    (t.pctFrom20Ema === null || t.pctFrom20Ema < 6)
  ) {
    return 'EARLY_REACTION';
  }

  if (
    t.pctFrom20Ema !== null && t.pctFrom20Ema > -3 && t.pctFrom20Ema < 1.5 &&
    f.candle.patternBias === 'BULLISH'
  ) {
    return 'CONTROLLED_PULLBACK';
  }

  if (
    e.distanceToSupportPct !== null && e.distanceToSupportPct < 2.5 &&
    f.candle.patternBias === 'BULLISH'
  ) {
    return 'SUPPORT_RECLAIM';
  }

  if (t.rsVsNifty !== null && t.rsVsNifty > 5 && t.emaStack === 'BULLISH') {
    return 'RELATIVE_STRENGTH';
  }

  return 'NONE';
}

/** Collects the names of null features, for the missing list. */
export function collectMissing(f: FeatureVector): string[] {
  const missing: string[] = [];
  const groups: [string, Record<string, unknown>][] = [
    ['event', f.event], ['fundamental', f.fundamental], ['trend', f.trend],
    ['momentum', f.momentum], ['candle', f.candle], ['volume', f.volume],
    ['entry', f.entry], ['liquidity', f.liquidity], ['regime', f.regime], ['risk', f.risk],
  ];
  for (const [group, obj] of groups) {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null) missing.push(`${group}.${key}`);
    }
  }
  return missing;
}
