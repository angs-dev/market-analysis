/**
 * Price structure: swing points, support and resistance, breakout levels and
 * extension.
 *
 * Support and resistance here are derived from actual swing pivots and their
 * clustering, not from round numbers or drawn lines. A level nobody traded is
 * not a level.
 */

import type { OHLCV } from './indicators.ts';
import { atr, ema, highest, latest, lowest } from './indicators.ts';

export interface SwingPoint {
  index: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

/**
 * Fractal swing points: a bar whose high exceeds `lookback` bars either side
 * (or low below). Requires `lookback` bars of confirmation, so the most recent
 * bars are deliberately excluded — a swing is only a swing once price has
 * turned away from it.
 */
export function findSwings(bars: readonly OHLCV[], lookback = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const bar = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j]!.high >= bar.high) isHigh = false;
      if (bars[j]!.low <= bar.low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: bar.high, kind: 'HIGH' });
    if (isLow) out.push({ index: i, price: bar.low, kind: 'LOW' });
  }
  return out;
}

export interface Level {
  price: number;
  /** How many swing points formed this cluster. More touches, stronger level. */
  touches: number;
  kind: 'SUPPORT' | 'RESISTANCE';
}

/**
 * Clusters swing points into levels. Points within `tolerancePct` of each other
 * are one level, priced at the mean of its members.
 */
export function clusterLevels(
  swings: readonly SwingPoint[],
  kind: 'SUPPORT' | 'RESISTANCE',
  tolerancePct = 0.75,
): Level[] {
  const wanted = swings.filter((s) => (kind === 'SUPPORT' ? s.kind === 'LOW' : s.kind === 'HIGH'));
  const sorted = [...wanted].sort((a, b) => a.price - b.price);
  const levels: Level[] = [];
  let group: SwingPoint[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    const mean = group.reduce((s, p) => s + p.price, 0) / group.length;
    levels.push({ price: mean, touches: group.length, kind });
    group = [];
  };

  for (const point of sorted) {
    if (group.length === 0) {
      group.push(point);
      continue;
    }
    const anchor = group[0]!.price;
    if (Math.abs(point.price - anchor) / anchor * 100 <= tolerancePct) group.push(point);
    else {
      flush();
      group.push(point);
    }
  }
  flush();
  return levels;
}

export interface StructureView {
  lastClose: number;
  /** Nearest level below the current price. */
  support: number | null;
  /** Nearest level above the current price. */
  resistance: number | null;
  distanceToSupportPct: number | null;
  distanceToResistancePct: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  week52High: number | null;
  week52Low: number | null;
  pctFrom52wHigh: number | null;
  pctOf52wRange: number | null;
  /** Highest high of the consolidation immediately preceding the last bar. */
  breakoutLevel: number | null;
  breakoutStatus: BreakoutStatus;
  /** Consecutive bars trading inside a narrow range before the last bar. */
  consolidationDays: number;
  atr14: number | null;
  atrPct: number | null;
  pctFrom20Ema: number | null;
  pctFrom50Ema: number | null;
  /** How much of a typical day's range the last bar has used. */
  atrBurnRatio: number | null;
}

export type BreakoutStatus = 'NONE' | 'CLEAN' | 'RETEST' | 'FAILED' | 'EXTENDED';

/**
 * Classifies the breakout state of the most recent bar relative to the level
 * it is breaking.
 *
 * FAILED is the important one: closing back below a level the bar traded above
 * is a failed breakout, which the gates reject outright. Distinguishing it from
 * a clean break is the difference between a good entry and the worst one.
 */
export function classifyBreakout(
  bars: readonly OHLCV[],
  level: number | null,
  atrValue: number | null,
): BreakoutStatus {
  const last = bars[bars.length - 1];
  if (!last || level === null || level <= 0) return 'NONE';

  const brokeIntrabar = last.high > level;
  const closedAbove = last.close > level;

  if (!brokeIntrabar) return 'NONE';
  if (!closedAbove) return 'FAILED';

  const extensionPct = ((last.close - level) / level) * 100;
  const atrPct = atrValue !== null && last.close > 0 ? (atrValue / last.close) * 100 : null;

  // More than ~1.5 ATR beyond the level is a chase, not an entry.
  if (atrPct !== null && extensionPct > atrPct * 1.5) return 'EXTENDED';
  // A break that pulled back into the level and held is the cleanest entry.
  if (last.low <= level * 1.002) return 'RETEST';
  return 'CLEAN';
}

/** Counts trailing bars whose range sits inside `maxRangePct` of the mean close. */
export function countConsolidation(
  bars: readonly OHLCV[],
  maxRangePct = 6,
  maxBars = 40,
): number {
  if (bars.length < 3) return 0;
  const end = bars.length - 1; // exclude the breakout bar itself
  let count = 0;
  let high = -Infinity;
  let low = Infinity;

  for (let i = end - 1; i >= Math.max(0, end - maxBars); i--) {
    const bar = bars[i]!;
    const nextHigh = Math.max(high, bar.high);
    const nextLow = Math.min(low, bar.low);
    const mid = (nextHigh + nextLow) / 2;
    if (mid <= 0) break;
    if (((nextHigh - nextLow) / mid) * 100 > maxRangePct) break;
    high = nextHigh;
    low = nextLow;
    count++;
  }
  return count;
}

export function buildStructure(bars: readonly OHLCV[]): StructureView {
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const empty: StructureView = {
    lastClose: last?.close ?? 0,
    support: null, resistance: null,
    distanceToSupportPct: null, distanceToResistancePct: null,
    prevDayHigh: null, prevDayLow: null,
    week52High: null, week52Low: null,
    pctFrom52wHigh: null, pctOf52wRange: null,
    breakoutLevel: null, breakoutStatus: 'NONE', consolidationDays: 0,
    atr14: null, atrPct: null, pctFrom20Ema: null, pctFrom50Ema: null,
    atrBurnRatio: null,
  };
  if (!last || bars.length < 2) return empty;

  const swings = findSwings(bars, 3);
  const close = last.close;

  const supports = clusterLevels(swings, 'SUPPORT').filter((l) => l.price < close);
  const resistances = clusterLevels(swings, 'RESISTANCE').filter((l) => l.price > close);
  const support = supports.length > 0 ? Math.max(...supports.map((l) => l.price)) : null;
  const resistance = resistances.length > 0 ? Math.min(...resistances.map((l) => l.price)) : null;

  // 52 weeks of daily bars, or whatever history exists.
  const window = Math.min(bars.length, 252);
  const week52High = latest(highest(highs, window));
  const week52Low = latest(lowest(lows, window));

  const atrValue = latest(atr(bars, 14));
  const ema20 = latest(ema(closes, 20));
  const ema50 = latest(ema(closes, 50));

  // The level being broken is the highest swing high below or at the last high.
  const priorHighs = swings.filter((s) => s.kind === 'HIGH' && s.index < bars.length - 1);
  const breakoutLevel =
    priorHighs.length > 0 ? Math.max(...priorHighs.map((s) => s.price)) : null;

  return {
    lastClose: close,
    support,
    resistance,
    distanceToSupportPct: support !== null ? ((close - support) / close) * 100 : null,
    distanceToResistancePct: resistance !== null ? ((resistance - close) / close) * 100 : null,
    prevDayHigh: bars[bars.length - 2]!.high,
    prevDayLow: bars[bars.length - 2]!.low,
    week52High,
    week52Low,
    pctFrom52wHigh:
      week52High !== null && week52High > 0 ? ((close - week52High) / week52High) * 100 : null,
    pctOf52wRange:
      week52High !== null && week52Low !== null && week52High > week52Low
        ? ((close - week52Low) / (week52High - week52Low)) * 100
        : null,
    breakoutLevel,
    breakoutStatus: classifyBreakout(bars, breakoutLevel, atrValue),
    consolidationDays: countConsolidation(bars),
    atr14: atrValue,
    atrPct: atrValue !== null && close > 0 ? (atrValue / close) * 100 : null,
    pctFrom20Ema: ema20 !== null && ema20 > 0 ? ((close - ema20) / ema20) * 100 : null,
    pctFrom50Ema: ema50 !== null && ema50 > 0 ? ((close - ema50) / ema50) * 100 : null,
    atrBurnRatio: atrValue !== null && atrValue > 0 ? (last.high - last.low) / atrValue : null,
  };
}
