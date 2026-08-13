/**
 * The rate-limit governor.
 *
 * All outbound requests to external sources pass through here. It enforces the
 * source's declared limits, applies backoff, consults the circuit breaker, and
 * logs every attempt so our own behaviour is auditable.
 *
 * Adapters never call fetch directly.
 */

import { CircuitBreaker, type BreakerAlert } from './breaker.ts';
import { backoffDelay } from './policy.ts';
import { systemClock, type Clock } from './clock.ts';
import {
  HttpStatusError,
  SourceBlockedError,
  SourceExhaustedError,
  SourceNotPermittedError,
  SourceUnavailableError,
} from './errors.ts';
import type { AttemptOutcome, SourceHealth, SourcePolicy } from './types.ts';

export interface RequestLog {
  sourceId: string;
  ts: string;
  urlHash?: string;
  httpStatus?: number;
  latencyMs: number;
  fromCache: boolean;
  retryCount: number;
  error?: string;
}

export interface GovernorDeps {
  clock?: Clock;
  /** Persists to source_requests. */
  onRequest?: (log: RequestLog) => void;
  onAlert?: (alert: BreakerAlert) => void;
}

export interface ExecuteOptions {
  /** Identifies the request in logs without storing full URLs. */
  urlHash?: string;
}

interface SourceState {
  policy: SourcePolicy;
  breaker: CircuitBreaker;
  enabled: boolean;
  minuteWindow: number[];
  hourWindow: number[];
  inFlight: number;
  lastRequestAt: number;
  lastOkAt?: number;
  lastErrorAt?: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

export class SourceGovernor {
  readonly #sources = new Map<string, SourceState>();
  readonly #clock: Clock;
  readonly #onRequest: ((log: RequestLog) => void) | undefined;
  readonly #onAlert: ((alert: BreakerAlert) => void) | undefined;

  constructor(deps: GovernorDeps = {}) {
    this.#clock = deps.clock ?? systemClock;
    this.#onRequest = deps.onRequest;
    this.#onAlert = deps.onAlert;
  }

  register(policy: SourcePolicy, enabled = policy.enabledByDefault): void {
    this.#sources.set(policy.id, {
      policy,
      breaker: new CircuitBreaker(policy.id, policy.circuitBreaker, this.#clock, this.#onAlert),
      enabled,
      minuteWindow: [],
      hourWindow: [],
      inFlight: 0,
      lastRequestAt: -Infinity,
    });
  }

  has(sourceId: string): boolean {
    return this.#sources.has(sourceId);
  }

  setEnabled(sourceId: string, enabled: boolean): void {
    this.#state(sourceId).enabled = enabled;
  }

  policyOf(sourceId: string): SourcePolicy {
    return this.#state(sourceId).policy;
  }

  health(sourceId: string): SourceHealth {
    const s = this.#state(sourceId);
    this.#prune(s);
    const snap = s.breaker.snapshot();
    const health: SourceHealth = {
      id: sourceId,
      breakerState: snap.state,
      consecutiveFailures: snap.consecutiveFailures,
      requestsThisMinute: s.minuteWindow.length,
      requestsThisHour: s.hourWindow.length,
    };
    if (snap.reason) health.breakerReason = snap.reason;
    if (s.lastOkAt !== undefined) health.lastOkAt = new Date(s.lastOkAt).toISOString();
    if (s.lastErrorAt !== undefined) health.lastErrorAt = new Date(s.lastErrorAt).toISOString();
    return health;
  }

  allHealth(): SourceHealth[] {
    return [...this.#sources.keys()].map((id) => this.health(id));
  }

  /** Manual breaker reset. A hard stop should only be cleared by a human. */
  resetBreaker(sourceId: string): void {
    this.#state(sourceId).breaker.reset();
  }

  /**
   * Runs `fn` under this source's policy.
   *
   * `fn` should throw HttpStatusError for HTTP-level failures so the governor
   * can distinguish retryable statuses from stop instructions.
   */
  async execute<T>(
    sourceId: string,
    fn: (attempt: number) => Promise<T>,
    opts: ExecuteOptions = {},
  ): Promise<T> {
    const s = this.#state(sourceId);

    if (!s.enabled) {
      throw new SourceNotPermittedError(
        `source '${sourceId}' is disabled` +
          (s.policy.requiresExplicitOptIn ? ' and requires explicit opt-in' : ''),
        sourceId,
      );
    }

    const { backoff } = s.policy;
    let lastOutcome: AttemptOutcome | undefined;

    for (let attempt = 0; attempt <= backoff.maxRetries; attempt++) {
      if (!s.breaker.canAttempt()) {
        throw new SourceUnavailableError(sourceId, s.breaker.blockedReason());
      }

      await this.#awaitSlot(s);

      const startedAt = this.#clock.now();
      s.inFlight++;
      s.lastRequestAt = startedAt;
      s.minuteWindow.push(startedAt);
      s.hourWindow.push(startedAt);

      try {
        const value = await fn(attempt);
        s.inFlight--;
        s.lastOkAt = this.#clock.now();
        s.breaker.recordSuccess();
        this.#log(s, {
          sourceId,
          ts: new Date(startedAt).toISOString(),
          urlHash: opts.urlHash,
          httpStatus: 200,
          latencyMs: this.#clock.now() - startedAt,
          fromCache: false,
          retryCount: attempt,
        });
        return value;
      } catch (err) {
        s.inFlight--;
        s.lastErrorAt = this.#clock.now();

        const status = err instanceof HttpStatusError ? err.httpStatus : undefined;
        const retryAfterMs = err instanceof HttpStatusError ? err.retryAfterMs : undefined;
        lastOutcome = { httpStatus: status, retryAfterMs };

        this.#log(s, {
          sourceId,
          ts: new Date(startedAt).toISOString(),
          urlHash: opts.urlHash,
          httpStatus: status,
          latencyMs: this.#clock.now() - startedAt,
          fromCache: false,
          retryCount: attempt,
          error: err instanceof Error ? err.message : String(err),
        });

        s.breaker.recordFailure(status, err instanceof Error ? err.message : undefined);

        // A stop instruction ends the call immediately. No retry, ever.
        if (s.breaker.isHardStop(status)) {
          throw new SourceBlockedError(sourceId, status!);
        }

        const retryable = status === undefined || backoff.on.includes(status);
        if (!retryable || attempt === backoff.maxRetries) {
          if (!retryable) throw err;
          break;
        }

        await this.#clock.sleep(backoffDelay(attempt, backoff, this.#clock, retryAfterMs));
      }
    }

    throw new SourceExhaustedError(sourceId, backoff.maxRetries + 1, lastOutcome);
  }

  /** Blocks until concurrency, spacing and both rate windows all permit a request. */
  async #awaitSlot(s: SourceState): Promise<void> {
    const { rateLimit } = s.policy;

    // Concurrency. Yielding is enough: in-flight requests decrement on settle.
    while (s.inFlight >= rateLimit.maxConcurrent) {
      await this.#clock.sleep(rateLimit.minGapMs);
    }

    for (;;) {
      this.#prune(s);
      const now = this.#clock.now();

      const gapWait = Math.max(0, s.lastRequestAt + rateLimit.minGapMs - now);
      const minuteWait =
        s.minuteWindow.length >= rateLimit.maxPerMinute
          ? Math.max(0, s.minuteWindow[0]! + MINUTE - now)
          : 0;
      const hourWait =
        s.hourWindow.length >= rateLimit.maxPerHour
          ? Math.max(0, s.hourWindow[0]! + HOUR - now)
          : 0;

      const wait = Math.max(gapWait, minuteWait, hourWait);
      if (wait <= 0) return;
      await this.#clock.sleep(wait);
    }
  }

  #prune(s: SourceState): void {
    const now = this.#clock.now();
    while (s.minuteWindow.length > 0 && now - s.minuteWindow[0]! >= MINUTE) {
      s.minuteWindow.shift();
    }
    while (s.hourWindow.length > 0 && now - s.hourWindow[0]! >= HOUR) {
      s.hourWindow.shift();
    }
  }

  #log(s: SourceState, log: RequestLog): void {
    void s;
    this.#onRequest?.(log);
  }

  #state(sourceId: string): SourceState {
    const s = this.#sources.get(sourceId);
    if (!s) {
      throw new SourceNotPermittedError(
        `source '${sourceId}' is not registered`,
        sourceId,
      );
    }
    return s;
  }
}
