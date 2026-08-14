/**
 * Extension risk — the "don't chase" classifier.
 *
 * The priced-in engine already answers "has this news been absorbed?" in terms
 * of the event. This adds the purely technical question: regardless of the
 * news, how stretched is the price right now?
 *
 * They are deliberately separate. A stock can be early on its event and still
 * technically extended, and the operator should see both.
 */

import type { FeatureVector } from '../scoring/features.ts';
import type { PricedInAssessment } from '../pricedin/engine.ts';
import type { ExtensionRisk } from './types.ts';

export interface ExtensionFactor {
  name: string;
  value: number | string | null;
  /** 0..1 contribution to the overall risk. */
  weight: number;
  note: string;
}

export interface ExtensionAssessment {
  risk: ExtensionRisk;
  score: number;
  factors: ExtensionFactor[];
}

export const EXTENSION_THRESHOLDS = {
  medium: 0.25,
  high: 0.5,
  extreme: 0.75,
} as const;

/**
 * Scores extension across eight independent factors.
 *
 * Any one of them alone is weak evidence — a stock 6% above its 20 EMA in a
 * strong trend is normal. Several together is the profile of a move that has
 * already happened.
 */
export function assessExtension(
  f: FeatureVector,
  pricedIn: PricedInAssessment,
): ExtensionAssessment {
  const factors: ExtensionFactor[] = [];
  const add = (name: string, value: number | string | null, weight: number, note: string): void => {
    factors.push({ name, value, weight: Math.max(0, Math.min(1, weight)), note });
  };

  // 1. Move since the event
  const since = f.momentum.changeSinceEventPct;
  if (since !== null) {
    add('eventToCurrentReturn', Number(since.toFixed(2)), Math.min(1, Math.max(0, since / 8)),
      since > 5 ? 'most of the post-event move has already happened' : 'move since the event is contained');
  }

  // 2. Distance from VWAP
  const vwapDist = f.volume.vwapDistPct;
  if (vwapDist !== null) {
    add('distanceFromVwap', Number(vwapDist.toFixed(2)), Math.min(1, Math.max(0, vwapDist / 4)),
      vwapDist > 2 ? 'trading well above the session average price' : 'close to VWAP');
  }

  // 3. Distance from the 20 EMA
  const ema = f.trend.pctFrom20Ema;
  if (ema !== null) {
    add('distanceFromEma20', Number(ema.toFixed(2)), Math.min(1, Math.max(0, ema / 10)),
      ema > 6 ? 'stretched from its 20 EMA' : 'within a normal band of the 20 EMA');
  }

  // 4. ATR-normalised move — the fairest comparison across volatilities
  const atrPct = f.momentum.atrPct;
  const dayChange = f.momentum.dayChangePct;
  if (atrPct !== null && atrPct > 0 && dayChange !== null) {
    const normalised = dayChange / atrPct;
    add('atrNormalisedMove', Number(normalised.toFixed(2)), Math.min(1, Math.max(0, normalised / 2.5)),
      normalised > 1.5 ? "today's move is large even for this stock's volatility" : 'move is normal for its volatility');
  }

  // 5. Volume climax
  const volumeRatio = f.volume.volumeRatio;
  if (volumeRatio !== null) {
    // High volume confirms a move, but extreme volume with price extension is
    // more often distribution than accumulation.
    const climax = volumeRatio > 6 ? Math.min(1, (volumeRatio - 6) / 6) : 0;
    add('volumeClimax', Number(volumeRatio.toFixed(2)), climax,
      climax > 0 ? 'volume is at climax levels, which often marks exhaustion' : 'volume is elevated but not climactic');
  }

  // 6. Upper wick — sellers active into strength
  const wick = f.candle.upperWickPct;
  if (wick !== null) {
    add('upperWick', Number(wick.toFixed(1)), Math.min(1, Math.max(0, (wick - 30) / 50)),
      wick > 40 ? 'long upper wick — sellers met the advance' : 'no meaningful upper rejection');
  }

  // 7. Proximity to resistance
  const toResistance = f.entry.distanceToResistancePct;
  if (toResistance !== null) {
    add('nearResistance', Number(toResistance.toFixed(2)), Math.min(1, Math.max(0, (3 - toResistance) / 3)),
      toResistance < 1.5 ? 'resistance is immediately overhead' : 'clear air to the next level');
  }

  // 8. ATR burn — how much of a typical day is already used
  const burn = f.entry.atrBurnRatio;
  if (burn !== null) {
    add('atrBurn', Number(burn.toFixed(2)), Math.min(1, Math.max(0, (burn - 1) / 1.5)),
      burn > 1.5 ? "today's range has exceeded a typical day" : 'range is within normal bounds');
  }

  if (factors.length === 0) {
    return {
      risk: 'MEDIUM',
      score: 0.5,
      factors: [{
        name: 'unavailable', value: null, weight: 0.5,
        note: 'no extension inputs available — treated as medium rather than assumed safe',
      }],
    };
  }

  const score = factors.reduce((s, x) => s + x.weight, 0) / factors.length;

  // The priced-in verdict can only raise the risk, never lower it.
  const floor: Record<PricedInAssessment['verdict'], number> = {
    EARLY: 0, DEVELOPING: 0, MATURE: EXTENSION_THRESHOLDS.high,
    PRICED_IN: EXTENSION_THRESHOLDS.high, OVEREXTENDED: EXTENSION_THRESHOLDS.extreme,
  };
  const combined = Math.max(score, floor[pricedIn.verdict]);

  const risk: ExtensionRisk =
    combined >= EXTENSION_THRESHOLDS.extreme ? 'EXTREME'
      : combined >= EXTENSION_THRESHOLDS.high ? 'HIGH'
        : combined >= EXTENSION_THRESHOLDS.medium ? 'MEDIUM'
          : 'LOW';

  return { risk, score: combined, factors };
}

/** Convenience wrapper returning only the label. */
export function classifyExtension(
  f: FeatureVector,
  pricedIn: PricedInAssessment,
): ExtensionRisk {
  return assessExtension(f, pricedIn).risk;
}
