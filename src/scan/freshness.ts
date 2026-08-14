/**
 * Data freshness.
 *
 * A green dashboard showing stale numbers is more dangerous than a red one, so
 * every candidate carries the age and latency class of the data behind it, and
 * a stale price feed marks the candidate degraded — which the STALE_DATA gate
 * then converts into a refusal to issue PAPER_BUY.
 */

import type { Candle } from '../market/types.ts';
import type { SessionState } from '../market/session.ts';
import type { LatencyClass } from '../sources/types.ts';
import type { DataFreshness } from './types.ts';

export interface FreshnessInput {
  candles: readonly Candle[];
  event?: { detected_at: string | null; filed_at: string | null } | undefined;
  now: Date;
  session: SessionState;
  staleFeedMs: number;
  fundamentalsAsOf: string | null;
}

export function buildFreshness(input: FreshnessInput): DataFreshness {
  const notes: string[] = [];
  const lastBar = input.candles[input.candles.length - 1];

  const latency: LatencyClass = lastBar?.provenance.latencyClass ?? 'UNKNOWN';

  // Daily bars carry a date, not a timestamp; age is measured to the end of
  // that trading day rather than to an imagined intraday instant.
  let ageSeconds: number | null = null;
  if (lastBar) {
    const barMs = Date.parse(
      lastBar.ts.length === 10 ? `${lastBar.ts}T10:00:00Z` : lastBar.ts,
    );
    if (Number.isFinite(barMs)) ageSeconds = Math.max(0, Math.round((input.now.getTime() - barMs) / 1000));
  }

  /**
   * Staleness only means something while the market is open. Outside session
   * hours the most recent bar is legitimately old, and flagging that as a feed
   * failure would make the warning meaningless by firing constantly.
   */
  let stale = false;
  if (input.session.isOpen && latency === 'REALTIME') {
    stale = ageSeconds !== null && ageSeconds * 1000 > input.staleFeedMs;
    if (stale) {
      notes.push(
        `price feed is ${ageSeconds}s old, beyond the ${Math.round(input.staleFeedMs / 1000)}s ` +
          'threshold — PAPER_BUY is disabled while the feed is stale',
      );
    }
  } else if (input.session.isOpen && latency !== 'REALTIME') {
    notes.push(
      `price data is ${latency}, not real-time — intraday reaction cannot be measured accurately`,
    );
  }

  if (!lastBar) notes.push('no price data available for this symbol');

  let detectionLagSeconds: number | null = null;
  let newsLatency: LatencyClass = 'UNKNOWN';
  if (input.event) {
    const filed = input.event.filed_at;
    const detected = input.event.detected_at;
    if (filed && detected) {
      const lag = Math.round((Date.parse(detected) - Date.parse(filed)) / 1000);
      if (Number.isFinite(lag)) detectionLagSeconds = lag;
    }
    newsLatency =
      detectionLagSeconds === null ? 'UNKNOWN'
        : detectionLagSeconds <= 120 ? 'NEAR_REALTIME'
          : 'PERIODIC';
  }

  return {
    price: { latency, ageSeconds, stale },
    news: { latency: newsLatency, detectionLagSeconds },
    fundamentals: {
      asOf: input.fundamentalsAsOf,
      label: input.fundamentalsAsOf ? 'LATEST_REPORTED' : 'UNAVAILABLE',
    },
    degraded: stale || !lastBar,
    notes,
  };
}
