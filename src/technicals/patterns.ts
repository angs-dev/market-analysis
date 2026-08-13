/**
 * Candle pattern detection.
 *
 * Patterns are reported with a strength score rather than as a boolean, and
 * they are never consumed in isolation — the trade-quality scorer weights a
 * pattern by where it occurs, because a hammer at support and a hammer in open
 * air are not the same information.
 */

import type { OHLCV } from './indicators.ts';
import { closingStrength } from './indicators.ts';

export type CandlePattern =
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'HAMMER'
  | 'SHOOTING_STAR'
  | 'DOJI'
  | 'INSIDE_BAR'
  | 'LONG_UPPER_WICK'
  | 'LONG_LOWER_WICK'
  | 'MARUBOZU_BULL'
  | 'NONE';

export interface CandleAnatomy {
  range: number;
  body: number;
  bodyPct: number;
  upperWick: number;
  lowerWick: number;
  upperWickPct: number;
  lowerWickPct: number;
  isBullish: boolean;
  closingStrength: number;
}

export function anatomy(bar: OHLCV): CandleAnatomy {
  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const safe = range === 0 ? 1 : range;

  return {
    range,
    body,
    bodyPct: (body / safe) * 100,
    upperWick,
    lowerWick,
    upperWickPct: (upperWick / safe) * 100,
    lowerWickPct: (lowerWick / safe) * 100,
    isBullish: bar.close > bar.open,
    closingStrength: closingStrength(bar),
  };
}

export interface PatternResult {
  pattern: CandlePattern;
  /** 0..1. How textbook the formation is. */
  strength: number;
  /** Bullish, bearish or neutral implication. */
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rationale: string;
}

const NONE: PatternResult = {
  pattern: 'NONE', strength: 0, bias: 'NEUTRAL', rationale: 'no distinct formation',
};

/**
 * Classifies the most recent bar. Returns the single most significant pattern
 * rather than a list — a bar that is simultaneously three things is usually
 * none of them convincingly.
 */
export function detectPattern(bars: readonly OHLCV[]): PatternResult {
  const last = bars[bars.length - 1];
  if (!last) return NONE;
  const a = anatomy(last);
  if (a.range === 0) return NONE;

  const prev = bars.length >= 2 ? bars[bars.length - 2] : undefined;

  // Engulfing needs a prior bar of opposite direction that this bar swallows.
  if (prev) {
    const p = anatomy(prev);
    const engulfs = last.close > prev.open && last.open < prev.close;
    if (a.isBullish && !p.isBullish && engulfs && a.body > p.body) {
      return {
        pattern: 'BULLISH_ENGULFING',
        strength: Math.min(1, a.body / Math.max(p.body, 1e-9) / 2),
        bias: 'BULLISH',
        rationale: `bullish body engulfs the prior down bar (${a.bodyPct.toFixed(0)}% of range)`,
      };
    }
    const engulfsDown = last.close < prev.open && last.open > prev.close;
    if (!a.isBullish && p.isBullish && engulfsDown && a.body > p.body) {
      return {
        pattern: 'BEARISH_ENGULFING',
        strength: Math.min(1, a.body / Math.max(p.body, 1e-9) / 2),
        bias: 'BEARISH',
        rationale: 'bearish body engulfs the prior up bar',
      };
    }
    if (last.high <= prev.high && last.low >= prev.low) {
      return {
        pattern: 'INSIDE_BAR',
        strength: 0.5,
        bias: 'NEUTRAL',
        rationale: 'range contained within the prior bar — compression',
      };
    }
  }

  if (a.bodyPct < 10) {
    return {
      pattern: 'DOJI', strength: 0.6, bias: 'NEUTRAL',
      rationale: `body is only ${a.bodyPct.toFixed(0)}% of range — indecision`,
    };
  }

  if (a.bodyPct > 80 && a.isBullish) {
    return {
      pattern: 'MARUBOZU_BULL', strength: 0.9, bias: 'BULLISH',
      rationale: `body is ${a.bodyPct.toFixed(0)}% of range with almost no wicks`,
    };
  }

  if (a.lowerWickPct > 55 && a.bodyPct < 35) {
    return {
      pattern: 'HAMMER',
      strength: Math.min(1, a.lowerWickPct / 70),
      bias: 'BULLISH',
      rationale: `lower wick is ${a.lowerWickPct.toFixed(0)}% of range — rejection of lows`,
    };
  }

  if (a.upperWickPct > 55 && a.bodyPct < 35) {
    return {
      pattern: 'SHOOTING_STAR',
      strength: Math.min(1, a.upperWickPct / 70),
      bias: 'BEARISH',
      rationale: `upper wick is ${a.upperWickPct.toFixed(0)}% of range — rejection of highs`,
    };
  }

  if (a.upperWickPct > 40) {
    return {
      pattern: 'LONG_UPPER_WICK', strength: a.upperWickPct / 100, bias: 'BEARISH',
      rationale: `sellers active into strength (${a.upperWickPct.toFixed(0)}% upper wick)`,
    };
  }

  if (a.lowerWickPct > 40) {
    return {
      pattern: 'LONG_LOWER_WICK', strength: a.lowerWickPct / 100, bias: 'BULLISH',
      rationale: `buyers defended lows (${a.lowerWickPct.toFixed(0)}% lower wick)`,
    };
  }

  return NONE;
}
