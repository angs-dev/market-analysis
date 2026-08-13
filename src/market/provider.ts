/**
 * MarketDataProvider — the broker-neutral seam.
 *
 * Every price source in this system implements this interface: a CSV file on
 * disk, a delayed public endpoint, or (later) a broker feed. Nothing above this
 * layer knows or cares which. Swapping providers must never require a change to
 * the scoring, reaction, or validation code.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS INTERFACE IS DATA-ONLY, PERMANENTLY.
 *
 * It has no method to place, modify, or cancel an order, and no method to read
 * positions, funds, or margins. That is a structural guarantee rather than a
 * convention: a provider implementation physically cannot trade through this
 * interface, so no future change to strategy code can accidentally do so.
 *
 * A broker adapter added later implements only the read methods below, using
 * read-only credentials where the broker offers them.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type {
  Candle,
  DateRange,
  InstrumentRef,
  Quote,
  Timeframe,
} from './types.ts';
import type { Fidelity, LatencyClass } from '../sources/types.ts';

export interface ProviderCapabilities {
  /** Timeframes this provider can actually return. */
  timeframes: Timeframe[];
  /** Honest latency of the data, not the marketing claim. */
  latencyClass: LatencyClass;
  fidelity: Fidelity;
  /** Earliest date with data, ISO date, if known. */
  historyFrom?: string;
  /** Max span a single intraday request may cover, in days, if limited. */
  maxIntradayRangeDays?: number;
  /** How far back intraday data exists at all, in days, if limited. */
  intradayLookbackDays?: number;
  supportsQuotes: boolean;
  supportsStreaming: boolean;
  /** Free-text limitations worth surfacing to the operator. */
  notes?: string[];
}

export type Unsubscribe = () => void;

export interface MarketDataProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  /** True when the provider is configured and reachable. */
  isAvailable(): Promise<boolean>;

  /** Daily candles, inclusive of both range ends. */
  getDailyCandles(symbol: string, range: DateRange): Promise<Candle[]>;

  /** Intraday candles. Optional — Tier 0 providers do not have them. */
  getIntradayCandles?(
    symbol: string,
    timeframe: Timeframe,
    range: DateRange,
  ): Promise<Candle[]>;

  /** Latest quote. Optional. */
  getQuote?(symbol: string): Promise<Quote>;

  /** Live streaming. Optional — only a REALTIME provider implements this. */
  subscribe?(symbols: string[], onCandle: (c: Candle) => void): Unsubscribe;

  /** Instruments this provider knows about. Optional. */
  listInstruments?(): Promise<InstrumentRef[]>;
}

/** Narrowing helpers, so callers check rather than assume. */
export function supportsIntraday(
  p: MarketDataProvider,
): p is MarketDataProvider & Required<Pick<MarketDataProvider, 'getIntradayCandles'>> {
  return typeof p.getIntradayCandles === 'function';
}

export function supportsStreaming(
  p: MarketDataProvider,
): p is MarketDataProvider & Required<Pick<MarketDataProvider, 'subscribe'>> {
  return typeof p.subscribe === 'function';
}

/**
 * Asserts a provider can serve a timeframe, with a message naming the provider
 * and its real limits. Prevents silently returning empty arrays.
 */
export function assertTimeframe(p: MarketDataProvider, tf: Timeframe): void {
  if (!p.capabilities.timeframes.includes(tf)) {
    throw new Error(
      `Provider '${p.id}' does not support timeframe '${tf}' ` +
        `(supports: ${p.capabilities.timeframes.join(', ') || 'none'})`,
    );
  }
}
