/**
 * Core market data types. Deliberately broker-neutral — nothing here names a
 * broker, and nothing here describes an order.
 */

import type { Fidelity, LatencyClass } from '../sources/types.ts';

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1w';

export const INTRADAY_TIMEFRAMES: readonly Timeframe[] = [
  '1m', '3m', '5m', '15m', '30m', '60m',
];

/** Provenance travels with the data, never alongside it. */
export interface Provenance {
  sourceId: string;
  latencyClass: LatencyClass;
  fidelity: Fidelity;
}

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  /** ISO 8601. Candle open time, not close time. */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  /** Session VWAP at this candle, when the source provides it. */
  vwap: number | null;
  provenance: Provenance;
}

export interface Quote {
  symbol: string;
  ts: string;
  last: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  provenance: Provenance;
}

export interface InstrumentRef {
  symbol: string;
  isin?: string;
  bseCode?: string;
  name?: string;
  sector?: string;
  sectorIndex?: string;
}

export interface DateRange {
  /** Inclusive, ISO date (YYYY-MM-DD) or full ISO timestamp. */
  from: string;
  /** Inclusive. */
  to: string;
}

/** Raw announcement, before classification. */
export interface RawAnnouncement {
  /** Stable identity for deduplication across sources. */
  dedupeKey: string;
  symbol: string | null;
  exchange: string | null;
  headline: string;
  body?: string;
  url?: string;
  attachmentUrl?: string;
  /** When the exchange/publisher timestamped it. */
  filedAt: string | null;
  /** When we saw it. Always set by the adapter. */
  detectedAt: string;
  sourceId: string;
  sourceTier: 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS';
}
