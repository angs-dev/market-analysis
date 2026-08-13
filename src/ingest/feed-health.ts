/**
 * Persists feed health snapshots and tick rejections.
 * Provider-neutral: takes a source id, knows nothing about Upstox.
 */

import type { Db } from '../db/driver.ts';
import type { FeedHealth } from '../adapters/tier1/upstox/health.ts';
import type { RejectedTick } from '../market/tick.ts';

export function recordFeedHealth(db: Db, sourceId: string, health: FeedHealth, ts: string): void {
  db.run(
    `INSERT INTO feed_health
       (ts, source_id, state, connected_at, last_tick_at, last_message_at,
        reconnect_count, consecutive_auth_failures, subscribed_instruments,
        ticks_received, ticks_rejected, rejections_by_reason_json,
        decode_errors, socket_errors, mean_latency_ms, max_latency_ms,
        market_status, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ts,
    sourceId,
    health.state,
    health.connectedAt,
    health.lastTickAt,
    health.lastMessageAt,
    health.reconnectCount,
    health.consecutiveAuthFailures,
    health.subscribedInstruments,
    health.ticksReceived,
    health.ticksRejected,
    JSON.stringify(health.rejectionsByReason),
    health.decodeErrors,
    health.socketErrors,
    health.meanLatencyMs,
    health.maxLatencyMs,
    health.marketStatus,
    health.lastError,
  );
}

export function recordTickRejection(
  db: Db,
  sourceId: string,
  rejection: RejectedTick,
  ts: string,
): void {
  db.run(
    `INSERT INTO tick_rejections (ts, source_id, instrument_key, reason, detail)
     VALUES (?, ?, ?, ?, ?)`,
    ts,
    sourceId,
    rejection.instrumentKey,
    rejection.reason,
    rejection.detail,
  );
}
