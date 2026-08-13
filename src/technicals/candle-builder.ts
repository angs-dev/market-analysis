/**
 * Builds 1-minute candles from a live tick stream.
 *
 * Bucketing uses the exchange timestamp when present, falling back to local
 * receive time. Using receive time for bucketing when an exchange time exists
 * would smear bars across boundaries under network jitter, so the fallback is
 * recorded on the bar rather than hidden.
 *
 * Volume is derived from the delta of cumulative volume-traded-today, not by
 * summing last-traded-quantity: a tick stream is sampled, so summing LTQ
 * systematically undercounts. When the feed does not carry cumulative volume
 * (LTPC mode), volume is null rather than a plausible wrong number.
 */

import type { Candle, Provenance, Timeframe } from '../market/types.ts';
import type { Tick } from '../market/tick.ts';

export const MINUTE_MS = 60_000;

export interface PartialCandle {
  symbol: string;
  /** Bucket start, ISO. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Cumulative volume at the first tick of this bucket. */
  volumeAtOpen: number | null;
  /** Cumulative volume at the most recent tick. */
  volumeAtClose: number | null;
  tickCount: number;
  firstTickAt: string;
  lastTickAt: string;
  /** True when no exchange timestamp was available and receive time was used. */
  usedReceiveTime: boolean;
}

export interface BuilderOptions {
  timeframeMs?: number;
  provenance: Provenance;
  /** Called when a bucket closes because a later one opened. */
  onCandle?: (candle: Candle, partial: PartialCandle) => void;
}

/** Floors an epoch-ms value to its bucket start. */
export function bucketStart(epochMs: number, sizeMs = MINUTE_MS): number {
  return Math.floor(epochMs / sizeMs) * sizeMs;
}

function toCandle(
  p: PartialCandle,
  provenance: Provenance,
  timeframe: Timeframe,
): Candle {
  const volume =
    p.volumeAtOpen !== null && p.volumeAtClose !== null
      ? Math.max(0, p.volumeAtClose - p.volumeAtOpen)
      : null;

  return {
    symbol: p.symbol,
    timeframe,
    ts: p.ts,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
    volume,
    vwap: null,
    provenance,
  };
}

export class CandleBuilder {
  readonly #open = new Map<string, PartialCandle>();
  readonly #sizeMs: number;
  readonly #provenance: Provenance;
  readonly #onCandle: BuilderOptions['onCandle'];
  readonly #timeframe: Timeframe;

  constructor(opts: BuilderOptions) {
    this.#sizeMs = opts.timeframeMs ?? MINUTE_MS;
    this.#provenance = opts.provenance;
    this.#onCandle = opts.onCandle;
    this.#timeframe = this.#sizeMs === MINUTE_MS ? '1m' : '5m';
  }

  /**
   * Feeds a tick in. Returns the completed candle if this tick rolled the
   * bucket over, otherwise null.
   */
  add(tick: Tick): Candle | null {
    const usedReceiveTime = tick.exchangeTs === null;
    const epochMs = new Date(tick.exchangeTs ?? tick.receivedAt).getTime();
    if (!Number.isFinite(epochMs)) return null;

    const start = bucketStart(epochMs, this.#sizeMs);
    const startIso = new Date(start).toISOString();
    const current = this.#open.get(tick.symbol);

    // A tick belonging to an already-closed bucket is dropped rather than
    // reopening it — late data must not mutate a bar already published.
    if (current && startIso < current.ts) return null;

    if (!current || startIso !== current.ts) {
      let completed: Candle | null = null;
      if (current) {
        completed = toCandle(current, this.#provenance, this.#timeframe);
        this.#onCandle?.(completed, current);
      }
      this.#open.set(tick.symbol, {
        symbol: tick.symbol,
        ts: startIso,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volumeAtOpen: tick.volumeToday,
        volumeAtClose: tick.volumeToday,
        tickCount: 1,
        firstTickAt: tick.receivedAt,
        lastTickAt: tick.receivedAt,
        usedReceiveTime,
      });
      return completed;
    }

    current.high = Math.max(current.high, tick.ltp);
    current.low = Math.min(current.low, tick.ltp);
    current.close = tick.ltp;
    current.tickCount++;
    current.lastTickAt = tick.receivedAt;
    if (tick.volumeToday !== null) {
      current.volumeAtClose = tick.volumeToday;
      if (current.volumeAtOpen === null) current.volumeAtOpen = tick.volumeToday;
    }
    if (usedReceiveTime) current.usedReceiveTime = true;
    return null;
  }

  /** The in-progress bar for a symbol, if any. */
  peek(symbol: string): PartialCandle | undefined {
    return this.#open.get(symbol);
  }

  /**
   * Closes every open bucket. Called at session end or on shutdown; a bar
   * flushed this way is complete for the ticks received, which is not the same
   * as complete for the minute — callers validating against historical data
   * should expect boundary differences.
   */
  flush(): Candle[] {
    const out: Candle[] = [];
    for (const partial of this.#open.values()) {
      const candle = toCandle(partial, this.#provenance, this.#timeframe);
      out.push(candle);
      this.#onCandle?.(candle, partial);
    }
    this.#open.clear();
    return out;
  }

  get openCount(): number {
    return this.#open.size;
  }
}

// ── Validation against historical bars (requirement 17) ─────────────────────

export interface CandleComparison {
  ts: string;
  field: 'open' | 'high' | 'low' | 'close' | 'volume';
  live: number | null;
  historical: number | null;
  absDiff: number | null;
  relDiffPct: number | null;
}

export interface ValidationReport {
  compared: number;
  matched: number;
  mismatches: CandleComparison[];
  /** Bars present live but absent historically, and vice versa. */
  onlyLive: string[];
  onlyHistorical: string[];
  maxRelDiffPct: number;
}

/**
 * Compares locally built candles against the provider's own historical bars.
 *
 * Exact equality is not expected: a tick stream is sampled rather than
 * exhaustive, so extremes touched between ticks can be missed. The report
 * surfaces magnitude so the operator can judge, rather than asserting a
 * pass/fail the data cannot support.
 */
export function validateAgainstHistorical(
  live: readonly Candle[],
  historical: readonly Candle[],
  tolerancePct = 0.1,
): ValidationReport {
  const liveByTs = new Map(live.map((c) => [c.ts, c]));
  const histByTs = new Map(historical.map((c) => [c.ts, c]));

  const report: ValidationReport = {
    compared: 0,
    matched: 0,
    mismatches: [],
    onlyLive: [...liveByTs.keys()].filter((ts) => !histByTs.has(ts)).sort(),
    onlyHistorical: [...histByTs.keys()].filter((ts) => !liveByTs.has(ts)).sort(),
    maxRelDiffPct: 0,
  };

  for (const [ts, liveBar] of liveByTs) {
    const hist = histByTs.get(ts);
    if (!hist) continue;
    report.compared++;
    let barMatched = true;

    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      const l = liveBar[field];
      const h = hist[field];
      if (l === null || h === null) continue;

      const absDiff = Math.abs(l - h);
      const relDiffPct = h !== 0 ? (absDiff / Math.abs(h)) * 100 : absDiff > 0 ? Infinity : 0;
      report.maxRelDiffPct = Math.max(report.maxRelDiffPct, relDiffPct);

      if (relDiffPct > tolerancePct) {
        barMatched = false;
        report.mismatches.push({ ts, field, live: l, historical: h, absDiff, relDiffPct });
      }
    }
    if (barMatched) report.matched++;
  }

  return report;
}
