/**
 * Feature assembly from stored data.
 *
 * Turns candles, an optional event, and market context into a FeatureVector.
 * Anything that cannot be computed from what is present stays null — this
 * module never estimates, interpolates, or substitutes a typical value.
 */

import {
  atr, closingStrength, ema, latest, relativeStrength, rsi, volumeRatio, type OHLCV,
} from '../technicals/indicators.ts';
import { buildStructure } from '../technicals/structure.ts';
import { detectPattern } from '../technicals/patterns.ts';
import { assessRegime, type RegimeResult } from '../regime/market.ts';
import { emptyFeatures, collectMissing, classifyEntrySetup, type FeatureVector } from './features.ts';
import type { Candle } from '../market/types.ts';
import type { LatencyClass } from '../sources/types.ts';

export interface BuildFeaturesInput {
  symbol: string;
  /** Daily candles ascending. The last one is "now". */
  candles: readonly Candle[];
  /** Benchmark closes aligned to the same dates as `candles`. */
  benchmarkCloses?: readonly number[];
  /** Sector index closes, aligned the same way. */
  sectorCloses?: readonly number[];
  event?: {
    id: number | null;
    eventType: string | null;
    sourceTier: 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS' | null;
    sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS' | null;
    materiality: number | null;
    filedAt: string | null;
    detectionLagSec: number | null;
    corroborationCount: number | null;
  };
  fundamental?: Partial<FeatureVector['fundamental']>;
  regime?: RegimeResult;
  liquidity?: { avgTurnover20d: number | null; isTradeable: boolean | null; exclusionReason: string | null };
  risk?: Partial<FeatureVector['risk']>;
  /** Move since the event, when intraday data made it measurable. */
  changeSinceEventPct?: number | null;
  /** VWAP position, only available at Tier 1. */
  vwapPosition?: 'ABOVE' | 'BELOW' | 'AT' | null;
  vwapDistPct?: number | null;
  tier?: 0 | 1 | 2;
}

function toOhlcv(candles: readonly Candle[]): OHLCV[] {
  return candles.map((c) => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }));
}

export function buildFeatures(input: BuildFeaturesInput): FeatureVector {
  const { candles } = input;
  const last = candles[candles.length - 1];
  const ts = last?.ts ?? new Date().toISOString();
  const f = emptyFeatures(input.symbol.toUpperCase(), ts, input.tier ?? 0);

  if (!last || candles.length < 2) {
    f.meta.missing = collectMissing(f);
    return f;
  }

  const bars = toOhlcv(candles);
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const structure = buildStructure(bars);
  const pattern = detectPattern(bars);

  // ── Provenance ────────────────────────────────────────────────────────────
  for (const c of candles) {
    f.provenance[c.provenance.sourceId] = c.provenance.latencyClass as LatencyClass;
  }

  // ── Event ─────────────────────────────────────────────────────────────────
  if (input.event) {
    const e = input.event;
    f.meta.eventId = e.id;
    f.event = {
      eventType: e.eventType,
      sourceTier: e.sourceTier,
      materiality: e.materiality,
      sentiment: e.sentiment,
      minutesSinceEvent: e.filedAt
        ? Math.round((Date.parse(ts) - Date.parse(e.filedAt)) / 60_000)
        : null,
      corroborationCount: e.corroborationCount,
      detectionLagSec: e.detectionLagSec,
    };
  }

  if (input.fundamental) f.fundamental = { ...f.fundamental, ...input.fundamental };

  // ── Trend ─────────────────────────────────────────────────────────────────
  const ema20 = latest(ema(closes, 20));
  const ema50 = latest(ema(closes, 50));
  f.trend = {
    emaStack:
      ema20 !== null && ema50 !== null
        ? last.close > ema20 && ema20 > ema50
          ? 'BULLISH'
          : last.close < ema20 && ema20 < ema50
            ? 'BEARISH'
            : 'MIXED'
        : null,
    pctFrom20Ema: structure.pctFrom20Ema,
    pctFrom50Ema: structure.pctFrom50Ema,
    rsVsNifty:
      input.benchmarkCloses && input.benchmarkCloses.length === closes.length
        ? latest(relativeStrength(closes, input.benchmarkCloses, 20))
        : null,
    rsVsSector:
      input.sectorCloses && input.sectorCloses.length === closes.length
        ? latest(relativeStrength(closes, input.sectorCloses, 20))
        : null,
    pctFrom52wHigh: structure.pctFrom52wHigh,
    pctOf52wRange: structure.pctOf52wRange,
  };

  // ── Momentum ──────────────────────────────────────────────────────────────
  const rsiSeries = rsi(closes, 14);
  const prevClose = candles[candles.length - 2]!.close;
  f.momentum = {
    rsi14: latest(rsiSeries),
    rsi14Prev: rsiSeries.length >= 2 ? rsiSeries[rsiSeries.length - 2] ?? null : null,
    dayChangePct: prevClose > 0 ? ((last.close - prevClose) / prevClose) * 100 : null,
    changeSinceEventPct: input.changeSinceEventPct ?? null,
    atrPct: structure.atrPct,
  };

  // ── Candle ────────────────────────────────────────────────────────────────
  const lastBar = bars[bars.length - 1]!;
  const range = lastBar.high - lastBar.low;
  f.candle = {
    pattern: pattern.pattern,
    patternStrength: pattern.strength,
    patternBias: pattern.bias,
    closingStrength: closingStrength(lastBar),
    upperWickPct: range > 0
      ? ((lastBar.high - Math.max(lastBar.open, lastBar.close)) / range) * 100 : null,
    lowerWickPct: range > 0
      ? ((Math.min(lastBar.open, lastBar.close) - lastBar.low) / range) * 100 : null,
  };

  // ── Volume ────────────────────────────────────────────────────────────────
  f.volume = {
    volumeRatio: latest(volumeRatio(volumes, 20)),
    vwapPosition: input.vwapPosition ?? null,
    vwapDistPct: input.vwapDistPct ?? null,
    deliveryPct: null,
  };

  // ── Entry structure ───────────────────────────────────────────────────────
  f.entry = {
    setupType: null,
    breakoutStatus: structure.breakoutStatus,
    breakoutLevel: structure.breakoutLevel,
    support: structure.support,
    resistance: structure.resistance,
    distanceToSupportPct: structure.distanceToSupportPct,
    distanceToResistancePct: structure.distanceToResistancePct,
    consolidationDays: structure.consolidationDays,
    atrBurnRatio: structure.atrBurnRatio,
  };
  f.entry.setupType = classifyEntrySetup(f);

  // ── Liquidity, regime, risk ───────────────────────────────────────────────
  if (input.liquidity) f.liquidity = input.liquidity;

  if (input.regime) {
    const r = input.regime;
    f.regime = {
      label: r.label, score: r.score, trend: r.trend,
      niftyChangePct: r.niftyChangePct, vix: r.vix, breadthRatio: r.breadthRatio,
      unstable: r.unstable, completeness: r.completeness,
    };
  } else if (input.benchmarkCloses && input.benchmarkCloses.length >= 50) {
    const r = assessRegime({ niftyCloses: input.benchmarkCloses });
    f.regime = {
      label: r.label, score: r.score, trend: r.trend,
      niftyChangePct: r.niftyChangePct, vix: r.vix, breadthRatio: r.breadthRatio,
      unstable: r.unstable, completeness: r.completeness,
    };
  }

  if (input.risk) f.risk = { ...f.risk, ...input.risk };

  // ATR is the unit everything else is measured in; without it the priced-in
  // engine cannot size an expected move, so flag it plainly.
  if (latest(atr(bars, 14)) === null) {
    f.momentum.atrPct = null;
  }

  f.meta.missing = collectMissing(f);
  return f;
}
