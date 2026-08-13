/**
 * Indicator library.
 *
 * Written in-repo rather than pulled from a package because TA libraries
 * disagree on seeding and smoothing conventions, and an indicator you cannot
 * account for is an edge you cannot debug. Every function documents the exact
 * convention it implements.
 *
 * All series functions return an array the same length as the input, with
 * `null` during the warm-up period. Callers must handle null rather than
 * receiving a silently wrong number.
 */

export type Series = readonly number[];
export type MaybeSeries = (number | null)[];

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

function assertPeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${name}: period must be a positive integer, got ${period}`);
  }
}

/** Simple moving average over the trailing `period` values, inclusive of current. */
export function sma(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'sma');
  const out: MaybeSeries = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Convention: seeded with the SMA of the first `period` values (the standard
 * used by most charting platforms), then EMA_t = price_t * k + EMA_(t-1) *
 * (1 - k) with k = 2 / (period + 1).
 */
export function ema(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'ema');
  const out: MaybeSeries = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (a.k.a. RMA / SMMA), used by RSI and ATR.
 *
 * Seeded with the SMA of the first `period` values, then
 * RMA_t = (RMA_(t-1) * (period - 1) + value_t) / period.
 * This is an EMA with k = 1 / period, and is NOT the same as ema(values, period).
 */
export function wilderSmooth(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'wilderSmooth');
  const out: MaybeSeries = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index, Wilder's original formulation.
 *
 * Gains and losses are smoothed with Wilder's method seeded on the simple
 * average of the first `period` changes. The first defined value is therefore
 * at index `period`. A zero average loss yields 100.
 */
export function rsi(closes: Series, period = 14): MaybeSeries {
  assertPeriod(period, 'rsi');
  const out: MaybeSeries = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(0, change));
    losses.push(Math.max(0, -change));
  }

  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);

  // gains[j] corresponds to closes[j + 1].
  for (let j = 0; j < gains.length; j++) {
    const g = avgGain[j];
    const l = avgLoss[j];
    if (g === null || l === null || g === undefined || l === undefined) continue;
    out[j + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** True Range. The first bar has no previous close, so TR = high - low. */
export function trueRange(bars: readonly OHLCV[]): number[] {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1]!.close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
  });
}

/** Average True Range, Wilder-smoothed over True Range. */
export function atr(bars: readonly OHLCV[], period = 14): MaybeSeries {
  return wilderSmooth(trueRange(bars), period);
}

/**
 * Session-anchored VWAP: cumulative (typical price x volume) / cumulative
 * volume, reset at each session boundary.
 *
 * `sessionKey` maps a bar index to a session identifier — typically the trading
 * date. VWAP is meaningless without an anchor, so the caller must supply one.
 * Bars with null or zero cumulative volume yield null rather than 0.
 */
export function vwap(
  bars: readonly OHLCV[],
  sessionKey: (index: number) => string,
): MaybeSeries {
  const out: MaybeSeries = new Array(bars.length).fill(null);
  let currentSession: string | null = null;
  let cumPV = 0;
  let cumVol = 0;

  for (let i = 0; i < bars.length; i++) {
    const session = sessionKey(i);
    if (session !== currentSession) {
      currentSession = session;
      cumPV = 0;
      cumVol = 0;
    }
    const bar = bars[i]!;
    if (bar.volume === null) continue;

    const typical = (bar.high + bar.low + bar.close) / 3;
    cumPV += typical * bar.volume;
    cumVol += bar.volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return out;
}

/**
 * Volume ratio: current volume divided by the average of the `period` bars
 * *before* it. The current bar is excluded from its own baseline — including it
 * damps exactly the spike the ratio exists to detect.
 */
export function volumeRatio(volumes: readonly (number | null)[], period = 20): MaybeSeries {
  assertPeriod(period, 'volumeRatio');
  const out: MaybeSeries = new Array(volumes.length).fill(null);

  for (let i = period; i < volumes.length; i++) {
    const current = volumes[i];
    if (current === null || current === undefined) continue;

    let sum = 0;
    let count = 0;
    for (let j = i - period; j < i; j++) {
      const v = volumes[j];
      if (v !== null && v !== undefined) {
        sum += v;
        count++;
      }
    }
    if (count === 0) continue;
    const avg = sum / count;
    out[i] = avg > 0 ? current / avg : null;
  }
  return out;
}

/** Percentage change over `period` bars: (v_t / v_(t-period) - 1) * 100. */
export function rateOfChange(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'rateOfChange');
  const out: MaybeSeries = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period]!;
    if (past !== 0) out[i] = (values[i]! / past - 1) * 100;
  }
  return out;
}

/**
 * Relative strength versus a benchmark, as the difference in percentage return
 * over `period` bars. Positive means the stock outperformed.
 *
 * Series must be aligned bar-for-bar by the caller; misalignment here is a
 * silent correctness bug, so lengths are checked.
 */
export function relativeStrength(
  values: Series,
  benchmark: Series,
  period: number,
): MaybeSeries {
  if (values.length !== benchmark.length) {
    throw new Error(
      `relativeStrength: series lengths differ (${values.length} vs ${benchmark.length}) — ` +
        'align both series on trading dates before calling',
    );
  }
  const stock = rateOfChange(values, period);
  const bench = rateOfChange(benchmark, period);
  return stock.map((s, i) => {
    const b = bench[i];
    return s === null || b === null || b === undefined ? null : s - b;
  });
}

/** Highest high over the trailing `period` bars, inclusive of current. */
export function highest(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'highest');
  const out: MaybeSeries = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) max = Math.max(max, values[j]!);
    out[i] = max;
  }
  return out;
}

/** Lowest low over the trailing `period` bars, inclusive of current. */
export function lowest(values: Series, period: number): MaybeSeries {
  assertPeriod(period, 'lowest');
  const out: MaybeSeries = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) min = Math.min(min, values[j]!);
    out[i] = min;
  }
  return out;
}

/**
 * Closing strength: where the close sits within the bar's range, 0..1.
 * 1.0 is a close on the high, 0.0 on the low. A zero-range bar yields 0.5.
 */
export function closingStrength(bar: OHLCV): number {
  const range = bar.high - bar.low;
  return range === 0 ? 0.5 : (bar.close - bar.low) / range;
}

/** Last non-null value of a series, or null. */
export function latest(series: MaybeSeries): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
