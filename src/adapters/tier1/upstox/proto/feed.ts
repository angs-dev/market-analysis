/**
 * Market Data Feed V3 message decoding.
 *
 * Field numbers below mirror MarketDataFeedV3.proto, kept alongside this file.
 *
 * ⚠️ PROVENANCE OF THE SCHEMA: the .proto in this directory was obtained from a
 * third-party mirror, not from Upstox directly (their site is unreachable from
 * the development sandbox). It must be diffed against the official file before
 * this adapter is trusted with live data. Field numbers are centralised in
 * FIELD below precisely so that reconciliation is a single-file edit.
 */

import {
  decodeMessage,
  getDouble,
  getEnum,
  getEnumMap,
  getInt64,
  getMap,
  getMessage,
  getRepeatedMessage,
  getString,
  type Message,
} from './wire.ts';

/** Field numbers, straight from the .proto. */
export const FIELD = {
  FeedResponse: { type: 1, feeds: 2, currentTs: 3, marketInfo: 4 },
  Feed: { ltpc: 1, fullFeed: 2, firstLevelWithGreeks: 3, requestMode: 4 },
  FullFeed: { marketFF: 1, indexFF: 2 },
  MarketFullFeed: {
    ltpc: 1, marketLevel: 2, optionGreeks: 3, marketOHLC: 4,
    atp: 5, vtt: 6, oi: 7, iv: 8, tbq: 9, tsq: 10,
  },
  IndexFullFeed: { ltpc: 1, marketOHLC: 2 },
  LTPC: { ltp: 1, ltt: 2, ltq: 3, cp: 4 },
  MarketOHLC: { ohlc: 1 },
  OHLC: { interval: 1, open: 2, high: 3, low: 4, close: 5, vol: 6, ts: 7 },
  MarketInfo: { segmentStatus: 1 },
} as const;

/** FeedResponse.Type */
export const FEED_TYPE = { initial_feed: 0, live_feed: 1, market_info: 2 } as const;

/**
 * RequestMode, per the .proto enum. Note the wire name is `full_d5`, while the
 * SDK and documentation refer to the same mode as `full` — the subscription
 * request uses the documented string, not this enum name.
 */
export const REQUEST_MODE = { ltpc: 0, full_d5: 1, option_greeks: 2, full_d30: 3 } as const;

export const MARKET_STATUS: Record<number, string> = {
  0: 'PRE_OPEN_START',
  1: 'PRE_OPEN_END',
  2: 'NORMAL_OPEN',
  3: 'NORMAL_CLOSE',
  4: 'CLOSING_START',
  5: 'CLOSING_END',
};

export interface Ltpc {
  /** Last traded price. */
  ltp: number;
  /** Last trade time, epoch ms as reported by the exchange. */
  ltt: number | null;
  /** Last traded quantity. */
  ltq: number | null;
  /** Previous close. */
  cp: number | null;
}

export interface OhlcBar {
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ts: number | null;
}

export interface DecodedFeed {
  instrumentKey: string;
  ltpc: Ltpc | null;
  /** Volume traded today, cumulative. Present in full mode for equities. */
  vtt: number | null;
  /** Average traded price. */
  atp: number | null;
  ohlc: OhlcBar[];
  /** True when the payload came through IndexFullFeed. */
  isIndex: boolean;
  requestMode: number | null;
}

export interface DecodedFeedResponse {
  type: number;
  /** Feed-level timestamp, epoch ms. */
  currentTs: number | null;
  feeds: DecodedFeed[];
  /** Segment to market status, present on market_info messages. */
  segmentStatus: Map<string, string>;
}

function decodeLtpc(msg: Message | undefined): Ltpc | null {
  if (!msg) return null;
  const ltp = getDouble(msg, FIELD.LTPC.ltp);
  if (ltp === undefined) return null;
  return {
    ltp,
    ltt: getInt64(msg, FIELD.LTPC.ltt) ?? null,
    ltq: getInt64(msg, FIELD.LTPC.ltq) ?? null,
    cp: getDouble(msg, FIELD.LTPC.cp) ?? null,
  };
}

function decodeOhlc(marketOhlc: Message | undefined): OhlcBar[] {
  if (!marketOhlc) return [];
  return getRepeatedMessage(marketOhlc, FIELD.MarketOHLC.ohlc).map((bar) => ({
    interval: getString(bar, FIELD.OHLC.interval) ?? '',
    open: getDouble(bar, FIELD.OHLC.open) ?? 0,
    high: getDouble(bar, FIELD.OHLC.high) ?? 0,
    low: getDouble(bar, FIELD.OHLC.low) ?? 0,
    close: getDouble(bar, FIELD.OHLC.close) ?? 0,
    volume: getInt64(bar, FIELD.OHLC.vol) ?? null,
    ts: getInt64(bar, FIELD.OHLC.ts) ?? null,
  }));
}

function decodeFeed(instrumentKey: string, feed: Message): DecodedFeed {
  const out: DecodedFeed = {
    instrumentKey,
    ltpc: null,
    vtt: null,
    atp: null,
    ohlc: [],
    isIndex: false,
    requestMode: getEnum(feed, FIELD.Feed.requestMode) ?? null,
  };

  // oneof: ltpc | fullFeed | firstLevelWithGreeks
  const bare = getMessage(feed, FIELD.Feed.ltpc);
  if (bare) out.ltpc = decodeLtpc(bare);

  const full = getMessage(feed, FIELD.Feed.fullFeed);
  if (full) {
    const marketFF = getMessage(full, FIELD.FullFeed.marketFF);
    if (marketFF) {
      out.ltpc = decodeLtpc(getMessage(marketFF, FIELD.MarketFullFeed.ltpc));
      out.vtt = getInt64(marketFF, FIELD.MarketFullFeed.vtt) ?? null;
      out.atp = getDouble(marketFF, FIELD.MarketFullFeed.atp) ?? null;
      out.ohlc = decodeOhlc(getMessage(marketFF, FIELD.MarketFullFeed.marketOHLC));
    }
    const indexFF = getMessage(full, FIELD.FullFeed.indexFF);
    if (indexFF) {
      out.isIndex = true;
      out.ltpc = decodeLtpc(getMessage(indexFF, FIELD.IndexFullFeed.ltpc));
      out.ohlc = decodeOhlc(getMessage(indexFF, FIELD.IndexFullFeed.marketOHLC));
    }
  }

  const greeks = getMessage(feed, FIELD.Feed.firstLevelWithGreeks);
  if (greeks) {
    out.ltpc = decodeLtpc(getMessage(greeks, 1));
    out.vtt = getInt64(greeks, 4) ?? null;
  }

  return out;
}

/** Decodes one binary frame. Throws ProtoError on malformed input. */
export function decodeFeedResponse(buf: Uint8Array): DecodedFeedResponse {
  const root = decodeMessage(buf);

  const feeds: DecodedFeed[] = [];
  for (const [key, feed] of getMap(root, FIELD.FeedResponse.feeds)) {
    feeds.push(decodeFeed(key, feed));
  }

  const segmentStatus = new Map<string, string>();
  const marketInfo = getMessage(root, FIELD.FeedResponse.marketInfo);
  if (marketInfo) {
    for (const [segment, status] of getEnumMap(marketInfo, FIELD.MarketInfo.segmentStatus)) {
      segmentStatus.set(segment, MARKET_STATUS[status] ?? `UNKNOWN_${status}`);
    }
  }

  return {
    type: getEnum(root, FIELD.FeedResponse.type) ?? FEED_TYPE.live_feed,
    currentTs: getInt64(root, FIELD.FeedResponse.currentTs) ?? null,
    feeds,
    segmentStatus,
  };
}

/** True when every reported segment is in a closed//pre-open-end state. */
export function isMarketClosed(segmentStatus: ReadonlyMap<string, string>): boolean {
  if (segmentStatus.size === 0) return false;
  return [...segmentStatus.values()].every(
    (s) => s === 'NORMAL_CLOSE' || s === 'CLOSING_END' || s === 'PRE_OPEN_END',
  );
}
