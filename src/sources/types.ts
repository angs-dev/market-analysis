/**
 * Source policy types.
 *
 * Every external data source declares a policy. Nothing about polling cadence
 * or rate limiting is hard-coded in adapter logic — it is configuration,
 * enforced centrally by the governor.
 */

export type LatencyClass =
  | 'REALTIME'
  /** Sub-minute but not pushed — a fast poll, honestly labelled. */
  | 'NEAR_REALTIME'
  | 'DELAYED'
  | 'PERIODIC'
  | 'UNKNOWN';

export type Fidelity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNAVAILABLE';

/**
 * Why we believe we are permitted to use this source. Anything TOS_GREY must
 * be opted into explicitly and is never enabled by default.
 * See docs/DATA-SOURCE-COMPLIANCE.md.
 */
export type LegalBasis =
  | 'PUBLISHED_FILE'
  | 'BROKER_LICENSED'
  | 'RSS_SYNDICATION'
  | 'MANUAL_HUMAN'
  | 'TOS_GREY';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'HARD_STOPPED';

export interface PollPolicy {
  /** Configured cadence. Clamped up to minIntervalMsFloor — never below. */
  intervalMs: number;
  /** Randomises each interval by ±jitterPct to avoid lockstep request patterns. */
  jitterPct: number;
  marketHoursOnly: boolean;
  tradingDaysOnly: boolean;
  /** Hard floor. Configuration cannot poll faster than this. */
  minIntervalMsFloor: number;
}

export interface RateLimitPolicy {
  maxPerMinute: number;
  maxPerHour: number;
  maxConcurrent: number;
  /** Minimum spacing between two consecutive requests to this source. */
  minGapMs: number;
}

export interface BackoffPolicy {
  strategy: 'EXPONENTIAL_JITTER';
  baseMs: number;
  maxMs: number;
  maxRetries: number;
  respectRetryAfter: boolean;
  /** HTTP statuses that are retryable. 403 must never appear here. */
  on: number[];
}

export interface CircuitBreakerPolicy {
  /** Consecutive soft failures before the circuit opens. */
  failureThreshold: number;
  /** How long an OPEN circuit waits before trying a probe request. */
  cooldownMs: number;
  /**
   * Statuses meaning "you are being told to stop" — typically [403].
   * These are never retried, and hardStopThreshold of them disables the
   * source for the remainder of the session.
   */
  hardStopOn: number[];
  hardStopThreshold: number;
}

export interface CachePolicy {
  ttlMs: number;
  /** Persist raw responses so development replays hit disk, not the network. */
  persistRaw: boolean;
}

export interface SourcePolicy {
  id: string;
  tier: 0 | 1 | 2;
  latencyClass: LatencyClass;
  legalBasis: LegalBasis;
  enabledByDefault: boolean;
  requiresExplicitOptIn: boolean;
  poll: PollPolicy;
  rateLimit: RateLimitPolicy;
  backoff: BackoffPolicy;
  circuitBreaker: CircuitBreakerPolicy;
  cache: CachePolicy;
  /** Required attribution text, where the source's terms demand it (e.g. BSE). */
  attribution?: string;
}

export interface SourceHealth {
  id: string;
  breakerState: BreakerState;
  breakerReason?: string;
  consecutiveFailures: number;
  lastOkAt?: string;
  lastErrorAt?: string;
  requestsThisMinute: number;
  requestsThisHour: number;
}

/** Result of one attempt, as reported back to the governor. */
export interface AttemptOutcome {
  httpStatus?: number;
  retryAfterMs?: number;
}
