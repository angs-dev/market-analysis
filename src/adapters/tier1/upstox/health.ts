/**
 * Connection health tracking (requirement 13).
 *
 * Everything the operator needs to answer "is the feed actually working right
 * now?" without reading logs. Deliberately contains no credential material —
 * snapshots are persisted to SQLite and printed to the console.
 */

export type ConnectionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'AUTH_FAILED'
  | 'STOPPED';

export interface FeedHealth {
  state: ConnectionState;
  /** ISO of the most recent successful connect. */
  connectedAt: string | null;
  /** ISO of the last tick of any instrument. */
  lastTickAt: string | null;
  /** ISO of the last message of any kind, including heartbeats. */
  lastMessageAt: string | null;
  reconnectCount: number;
  consecutiveAuthFailures: number;
  subscribedInstruments: number;
  ticksReceived: number;
  ticksRejected: number;
  rejectionsByReason: Record<string, number>;
  decodeErrors: number;
  socketErrors: number;
  /** Rolling mean of exchange-to-receive latency, ms. Null until measurable. */
  meanLatencyMs: number | null;
  maxLatencyMs: number | null;
  /** Set when the feed reported all segments closed. */
  marketStatus: string | null;
  lastError: string | null;
}

export class HealthTracker {
  #state: ConnectionState = 'IDLE';
  #connectedAt: string | null = null;
  #lastTickAt: string | null = null;
  #lastMessageAt: string | null = null;
  #reconnectCount = 0;
  #consecutiveAuthFailures = 0;
  #subscribed = 0;
  #ticksReceived = 0;
  #ticksRejected = 0;
  #rejections: Record<string, number> = {};
  #decodeErrors = 0;
  #socketErrors = 0;
  #latencySum = 0;
  #latencyCount = 0;
  #maxLatency = 0;
  #marketStatus: string | null = null;
  #lastError: string | null = null;

  get state(): ConnectionState {
    return this.#state;
  }

  setState(state: ConnectionState, at: string): void {
    this.#state = state;
    if (state === 'CONNECTED') {
      this.#connectedAt = at;
      this.#consecutiveAuthFailures = 0;
    }
  }

  recordReconnect(): void {
    this.#reconnectCount++;
  }

  recordAuthFailure(detail: string): void {
    this.#consecutiveAuthFailures++;
    this.#lastError = detail;
  }

  recordMessage(at: string): void {
    this.#lastMessageAt = at;
  }

  recordTick(at: string, latencyMs: number | null): void {
    this.#ticksReceived++;
    this.#lastTickAt = at;
    if (latencyMs !== null && Number.isFinite(latencyMs)) {
      this.#latencySum += latencyMs;
      this.#latencyCount++;
      this.#maxLatency = Math.max(this.#maxLatency, latencyMs);
    }
  }

  recordRejection(reason: string): void {
    this.#ticksRejected++;
    this.#rejections[reason] = (this.#rejections[reason] ?? 0) + 1;
  }

  recordDecodeError(detail: string): void {
    this.#decodeErrors++;
    this.#lastError = detail;
  }

  recordSocketError(detail: string): void {
    this.#socketErrors++;
    this.#lastError = detail;
  }

  setSubscribed(count: number): void {
    this.#subscribed = count;
  }

  setMarketStatus(status: string | null): void {
    this.#marketStatus = status;
  }

  /** Milliseconds since the last message, for staleness detection. */
  msSinceLastMessage(nowMs: number): number | null {
    if (this.#lastMessageAt === null) return null;
    return nowMs - new Date(this.#lastMessageAt).getTime();
  }

  snapshot(): FeedHealth {
    return {
      state: this.#state,
      connectedAt: this.#connectedAt,
      lastTickAt: this.#lastTickAt,
      lastMessageAt: this.#lastMessageAt,
      reconnectCount: this.#reconnectCount,
      consecutiveAuthFailures: this.#consecutiveAuthFailures,
      subscribedInstruments: this.#subscribed,
      ticksReceived: this.#ticksReceived,
      ticksRejected: this.#ticksRejected,
      rejectionsByReason: { ...this.#rejections },
      decodeErrors: this.#decodeErrors,
      socketErrors: this.#socketErrors,
      meanLatencyMs: this.#latencyCount > 0 ? this.#latencySum / this.#latencyCount : null,
      maxLatencyMs: this.#latencyCount > 0 ? this.#maxLatency : null,
      marketStatus: this.#marketStatus,
      lastError: this.#lastError,
    };
  }
}
