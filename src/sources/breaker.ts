/**
 * Circuit breaker.
 *
 * The important rule here is not the ordinary open/half-open/closed cycle — it
 * is the handling of "stop" statuses. An HTTP 403 from a public endpoint means
 * we are being told to go away. Retrying it is the behaviour that gets an IP
 * banned, so it is modelled as a distinct, terminal state rather than as one
 * more transient failure.
 */

import type { BreakerState, CircuitBreakerPolicy } from './types.ts';
import type { Clock } from './clock.ts';

export interface BreakerSnapshot {
  state: BreakerState;
  reason?: string;
  consecutiveFailures: number;
  hardStopHits: number;
  openedAt?: number;
}

export interface BreakerAlert {
  sourceId: string;
  state: BreakerState;
  reason: string;
}

export class CircuitBreaker {
  #state: BreakerState = 'CLOSED';
  #reason: string | undefined;
  #consecutiveFailures = 0;
  #hardStopHits = 0;
  #openedAt: number | undefined;

  readonly sourceId: string;
  readonly #policy: CircuitBreakerPolicy;
  readonly #clock: Clock;
  readonly #onAlert: ((alert: BreakerAlert) => void) | undefined;

  constructor(
    sourceId: string,
    policy: CircuitBreakerPolicy,
    clock: Clock,
    onAlert?: (alert: BreakerAlert) => void,
  ) {
    this.sourceId = sourceId;
    this.#policy = policy;
    this.#clock = clock;
    this.#onAlert = onAlert;
  }

  get state(): BreakerState {
    return this.#state;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.#state,
      reason: this.#reason,
      consecutiveFailures: this.#consecutiveFailures,
      hardStopHits: this.#hardStopHits,
      openedAt: this.#openedAt,
    };
  }

  /** True if a request may be attempted now. Transitions OPEN→HALF_OPEN when the cooldown has elapsed. */
  canAttempt(): boolean {
    if (this.#state === 'HARD_STOPPED') return false;
    if (this.#state === 'OPEN') {
      const elapsed = this.#clock.now() - (this.#openedAt ?? 0);
      if (elapsed >= this.#policy.cooldownMs) {
        this.#state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true;
  }

  /** Human-readable reason a request is being refused. */
  blockedReason(): string {
    if (this.#state === 'HARD_STOPPED') {
      return this.#reason ?? 'hard-stopped for this session';
    }
    const remaining =
      this.#policy.cooldownMs - (this.#clock.now() - (this.#openedAt ?? 0));
    return `circuit open, ${Math.max(0, remaining)}ms of cooldown remaining`;
  }

  /** True if this status means "stop asking", rather than "try again later". */
  isHardStop(httpStatus: number | undefined): boolean {
    return httpStatus !== undefined && this.#policy.hardStopOn.includes(httpStatus);
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    if (this.#state !== 'CLOSED') {
      this.#state = 'CLOSED';
      this.#reason = undefined;
      this.#openedAt = undefined;
    }
  }

  /**
   * Records a failed attempt.
   *
   * A hard-stop status counts towards hardStopThreshold and, once reached,
   * disables the source for the rest of the session with no cooldown and no
   * automatic recovery. That is deliberate: recovering automatically from a
   * block means resuming the exact behaviour that caused it.
   */
  recordFailure(httpStatus?: number, detail?: string): void {
    if (this.isHardStop(httpStatus)) {
      this.#hardStopHits++;
      if (this.#hardStopHits >= this.#policy.hardStopThreshold) {
        this.#trip(
          'HARD_STOPPED',
          `received ${this.#hardStopHits}x HTTP ${httpStatus} — source is refusing ` +
            `automated access; disabled for this session (manual review required)`,
        );
      }
      return;
    }

    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= this.#policy.failureThreshold) {
      this.#trip(
        'OPEN',
        `${this.#consecutiveFailures} consecutive failures` +
          (detail ? `: ${detail}` : ''),
      );
    }
  }

  #trip(state: BreakerState, reason: string): void {
    const changed = this.#state !== state;
    this.#state = state;
    this.#reason = reason;
    this.#openedAt = this.#clock.now();
    if (changed) this.#onAlert?.({ sourceId: this.sourceId, state, reason });
  }

  /** Manual reset. Requires an explicit human decision for a hard stop. */
  reset(): void {
    this.#state = 'CLOSED';
    this.#reason = undefined;
    this.#consecutiveFailures = 0;
    this.#hardStopHits = 0;
    this.#openedAt = undefined;
  }
}
