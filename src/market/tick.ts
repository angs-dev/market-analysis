/**
 * Internal tick format. Provider-neutral: nothing here names Upstox, and the
 * candle builder and health monitor consume only this shape.
 *
 * Timestamps are kept strictly separate:
 *   exchangeTs  — when the exchange says it happened. Authoritative for
 *                 bucketing, but may be absent, stale, or skewed.
 *   receivedAt  — when this process saw it. Always present. Used for latency
 *                 measurement and staleness detection, never for bucketing.
 *
 * Conflating the two makes feed latency invisible, which is exactly the thing
 * worth measuring in an event-driven system.
 */

import type { Provenance } from './types.ts';

export interface Tick {
  /** Internal symbol, resolved from the provider's instrument key. */
  symbol: string;
  /** The provider's own identifier, retained for debugging and replay. */
  instrumentKey: string;

  /** Last traded price. */
  ltp: number;
  /** Last traded quantity, when the mode provides it. */
  ltq: number | null;
  /** Cumulative volume traded today. Candle volume is derived from its delta. */
  volumeToday: number | null;
  /** Average traded price for the session. */
  atp: number | null;
  /** Previous session close. */
  prevClose: number | null;

  /** Exchange-reported time, ISO. Null when the feed omitted it. */
  exchangeTs: string | null;
  /** Local receive time, ISO. Always set. */
  receivedAt: string;
  /** receivedAt - exchangeTs in ms, when both are known. */
  latencyMs: number | null;

  isIndex: boolean;
  provenance: Provenance;
}

export type TickRejectionReason =
  | 'MALFORMED'
  | 'NO_PRICE'
  | 'NON_POSITIVE_PRICE'
  | 'UNKNOWN_INSTRUMENT'
  | 'DUPLICATE'
  | 'OUT_OF_ORDER'
  | 'STALE';

export interface RejectedTick {
  reason: TickRejectionReason;
  instrumentKey: string;
  detail: string;
}

/**
 * Deduplication and ordering gate.
 *
 * A feed legitimately repeats the last trade when nothing has changed, and
 * reconnects replay recent state, so duplicates are normal rather than
 * exceptional. Out-of-order ticks are rejected because admitting one would
 * corrupt the candle currently being built.
 */
export class TickSequencer {
  readonly #lastExchangeTs = new Map<string, number>();
  readonly #lastSignature = new Map<string, string>();

  /** Identity of a tick: price, quantity and exchange time together. */
  static signature(tick: Tick): string {
    return `${tick.ltp}|${tick.ltq ?? '-'}|${tick.exchangeTs ?? '-'}|${tick.volumeToday ?? '-'}`;
  }

  accept(tick: Tick): RejectedTick | null {
    const key = tick.instrumentKey;

    const signature = TickSequencer.signature(tick);
    if (this.#lastSignature.get(key) === signature) {
      return { reason: 'DUPLICATE', instrumentKey: key, detail: 'identical to previous tick' };
    }

    if (tick.exchangeTs !== null) {
      const ts = new Date(tick.exchangeTs).getTime();
      const previous = this.#lastExchangeTs.get(key);
      if (previous !== undefined && ts < previous) {
        return {
          reason: 'OUT_OF_ORDER',
          instrumentKey: key,
          detail: `exchange ts ${tick.exchangeTs} precedes last seen ${new Date(previous).toISOString()}`,
        };
      }
      this.#lastExchangeTs.set(key, ts);
    }

    this.#lastSignature.set(key, signature);
    return null;
  }

  reset(): void {
    this.#lastExchangeTs.clear();
    this.#lastSignature.clear();
  }

  /**
   * Clears remembered signatures but keeps timestamps.
   *
   * Called on reconnect: the feed replays current state, and those replayed
   * values are legitimately new to the freshly built candle even though they
   * match what was seen before the drop. Timestamp ordering still applies.
   */
  softResetForReconnect(): void {
    this.#lastSignature.clear();
  }
}
