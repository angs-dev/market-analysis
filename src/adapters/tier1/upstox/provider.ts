/**
 * UpstoxProvider — implements MarketDataProvider.
 *
 * Nothing outside this directory knows the provider is Upstox (requirement 5).
 * The scoring, reaction and validation layers see only MarketDataProvider.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ-ONLY BY CONSTRUCTION.
 *
 * This class implements only the read methods of MarketDataProvider. It has no
 * order, position, funds, or margin method, and the interface gives it nowhere
 * to put one. Combined with the Analytics Token — which cannot place, modify
 * or cancel orders at all — there are two independent barriers between this
 * system and a live order.
 *
 * Portfolio, Accounts and Funds endpoints are deliberately NOT implemented,
 * even though the Analytics Token can reach them with a static IP.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { UpstoxFeedClient, type FeedMode, type SocketFactory, type Authorizer } from './feed-client.ts';
import type { UpstoxCredentials } from './credentials.ts';
import type { FeedHealth } from './health.ts';
import { CandleBuilder } from '../../../technicals/candle-builder.ts';
import { tradingDate } from '../../../parse/dates.ts';
import type { Clock } from '../../../sources/clock.ts';
import type { MarketDataProvider, ProviderCapabilities, Unsubscribe } from '../../../market/provider.ts';
import type { Candle, DateRange, Provenance, Timeframe } from '../../../market/types.ts';
import type { Tick } from '../../../market/tick.ts';

export const UPSTOX_SOURCE_ID = 'upstox_feed_v3';

const REALTIME: Provenance = {
  sourceId: UPSTOX_SOURCE_ID,
  latencyClass: 'REALTIME',
  fidelity: 'HIGH',
};

/** Historical bars are a REST pull, not a live tick — labelled honestly. */
const HISTORICAL: Provenance = {
  sourceId: UPSTOX_SOURCE_ID,
  latencyClass: 'PERIODIC',
  fidelity: 'HIGH',
};

/** Injected so the REST layer is testable without a network. */
export type RestFetcher = (
  path: string,
  credentials: UpstoxCredentials,
) => Promise<unknown>;

export interface UpstoxProviderOptions {
  credentials: UpstoxCredentials;
  clock: Clock;
  authorize: Authorizer;
  socketFactory: SocketFactory;
  restFetcher: RestFetcher;
  /** Instrument key to internal symbol. */
  keyToSymbol: ReadonlyMap<string, string>;
  /** Internal symbol to instrument key. */
  symbolToKey: ReadonlyMap<string, string>;
  mode?: FeedMode;
  heartbeatTimeoutMs?: number;
  onLog?: (line: string) => void;
}

/** Upstox candle tuple: [timestamp, open, high, low, close, volume, openInterest]. */
type UpstoxCandleTuple = [string, number, number, number, number, number, number];

function isCandleTuple(value: unknown): value is UpstoxCandleTuple {
  return (
    Array.isArray(value) &&
    value.length >= 6 &&
    typeof value[0] === 'string' &&
    value.slice(1, 6).every((v) => typeof v === 'number')
  );
}

/** Maps our timeframe to the V3 historical-candle unit/interval pair. */
export function toUnitInterval(tf: Timeframe): { unit: string; interval: string } {
  switch (tf) {
    case '1m': return { unit: 'minutes', interval: '1' };
    case '3m': return { unit: 'minutes', interval: '3' };
    case '5m': return { unit: 'minutes', interval: '5' };
    case '15m': return { unit: 'minutes', interval: '15' };
    case '30m': return { unit: 'minutes', interval: '30' };
    case '60m': return { unit: 'hours', interval: '1' };
    case '1d': return { unit: 'days', interval: '1' };
    case '1w': return { unit: 'weeks', interval: '1' };
  }
}

export class UpstoxProvider implements MarketDataProvider {
  readonly id = UPSTOX_SOURCE_ID;

  readonly capabilities: ProviderCapabilities = {
    timeframes: ['1m', '3m', '5m', '15m', '30m', '60m', '1d', '1w'],
    latencyClass: 'REALTIME',
    fidelity: 'HIGH',
    // Verified from Upstox documentation.
    historyFrom: '2000-01-01',
    intradayLookbackDays: undefined,
    supportsQuotes: false,
    supportsStreaming: true,
    notes: [
      'Market Data Feed V3 (V2 deprecated). Protobuf binary frames.',
      'Minute and hour history from Jan 2022; daily and above from Jan 2000.',
      'Read-only Analytics Token: cannot place, modify, or cancel orders.',
      'Portfolio/Accounts/Funds endpoints intentionally not implemented.',
    ],
  };

  readonly #opts: UpstoxProviderOptions;
  #feed: UpstoxFeedClient | null = null;

  constructor(opts: UpstoxProviderOptions) {
    this.#opts = opts;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.#opts.authorize(this.#opts.credentials);
      return true;
    } catch {
      return false;
    }
  }

  get feedHealth(): FeedHealth | null {
    return this.#feed?.health ?? null;
  }

  #keyFor(symbol: string): string {
    const key = this.#opts.symbolToKey.get(symbol.toUpperCase());
    if (key === undefined) {
      throw new Error(
        `No instrument key for '${symbol}'. Resolve it from the Upstox instrument ` +
          `master before requesting data — keys are never guessed.`,
      );
    }
    return key;
  }

  #parseCandles(payload: unknown, symbol: string, timeframe: Timeframe): Candle[] {
    const data = (payload as { data?: { candles?: unknown } } | null)?.data?.candles;
    if (!Array.isArray(data)) return [];

    const out: Candle[] = [];
    for (const row of data) {
      if (!isCandleTuple(row)) continue;
      const [ts, open, high, low, close, volume] = row;
      const parsed = new Date(ts);
      if (Number.isNaN(parsed.getTime())) continue;
      out.push({
        symbol: symbol.toUpperCase(),
        timeframe,
        // Daily bars are stored as calendar dates to match the Tier 0 path.
        ts: timeframe === '1d' || timeframe === '1w'
          ? tradingDate(parsed.toISOString())
          : parsed.toISOString(),
        open, high, low, close,
        volume: Number.isFinite(volume) ? volume : null,
        vwap: null,
        provenance: HISTORICAL,
      });
    }
    // Upstox returns newest-first; the rest of the system assumes ascending.
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async getDailyCandles(symbol: string, range: DateRange): Promise<Candle[]> {
    return this.#historical(symbol, '1d', range);
  }

  async getIntradayCandles(
    symbol: string,
    timeframe: Timeframe,
    range: DateRange,
  ): Promise<Candle[]> {
    return this.#historical(symbol, timeframe, range);
  }

  async #historical(symbol: string, timeframe: Timeframe, range: DateRange): Promise<Candle[]> {
    const key = this.#keyFor(symbol);
    const { unit, interval } = toUnitInterval(timeframe);
    const from = range.from.slice(0, 10);
    const to = range.to.slice(0, 10);
    const path =
      `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${to}/${from}`;
    return this.#parseCandles(
      await this.#opts.restFetcher(path, this.#opts.credentials),
      symbol,
      timeframe,
    );
  }

  /**
   * Live subscription. Ticks are aggregated into 1-minute candles and emitted
   * through the same Candle shape every other source produces.
   */
  subscribe(symbols: string[], onCandle: (candle: Candle) => void): Unsubscribe {
    const keys: string[] = [];
    for (const symbol of symbols) keys.push(this.#keyFor(symbol));

    const builder = new CandleBuilder({ provenance: REALTIME });

    const client = new UpstoxFeedClient({
      credentials: this.#opts.credentials,
      authorize: this.#opts.authorize,
      socketFactory: this.#opts.socketFactory,
      clock: this.#opts.clock,
      instrumentMap: this.#opts.keyToSymbol,
      mode: this.#opts.mode ?? 'full',
      provenance: REALTIME,
      heartbeatTimeoutMs: this.#opts.heartbeatTimeoutMs ?? 30_000,
      onLog: this.#opts.onLog,
      onTick: (tick: Tick) => {
        const completed = builder.add(tick);
        if (completed) onCandle(completed);
      },
    });

    this.#feed = client;
    void client.start(keys);

    return () => {
      client.stop();
      for (const candle of builder.flush()) onCandle(candle);
      this.#feed = null;
    };
  }

  /** Direct tick access, for the reaction engine. Not part of the interface. */
  subscribeTicks(symbols: string[], onTick: (tick: Tick) => void): Unsubscribe {
    const keys = symbols.map((s) => this.#keyFor(s));
    const client = new UpstoxFeedClient({
      credentials: this.#opts.credentials,
      authorize: this.#opts.authorize,
      socketFactory: this.#opts.socketFactory,
      clock: this.#opts.clock,
      instrumentMap: this.#opts.keyToSymbol,
      mode: this.#opts.mode ?? 'full',
      provenance: REALTIME,
      heartbeatTimeoutMs: this.#opts.heartbeatTimeoutMs ?? 30_000,
      onLog: this.#opts.onLog,
      onTick,
    });
    this.#feed = client;
    void client.start(keys);
    return () => {
      client.stop();
      this.#feed = null;
    };
  }
}
