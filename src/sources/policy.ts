/**
 * Policy defaults, normalisation and validation.
 *
 * Configuration is not trusted. Intervals are clamped up to the source's
 * declared floor, and a policy that would retry a "stop" status is rejected
 * outright rather than quietly corrected.
 */

import type { Clock } from './clock.ts';
import type { PollPolicy, SourcePolicy } from './types.ts';

/** Deliberately conservative. Individual sources may only be slower. */
export const DEFAULT_POLICY = {
  poll: {
    intervalMs: 60_000,
    jitterPct: 0.15,
    marketHoursOnly: true,
    tradingDaysOnly: true,
    minIntervalMsFloor: 30_000,
  },
  rateLimit: {
    maxPerMinute: 20,
    maxPerHour: 600,
    maxConcurrent: 2,
    minGapMs: 1_000,
  },
  backoff: {
    strategy: 'EXPONENTIAL_JITTER',
    baseMs: 2_000,
    maxMs: 60_000,
    maxRetries: 3,
    respectRetryAfter: true,
    on: [429, 500, 502, 503, 504],
  },
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 300_000,
    hardStopOn: [403],
    hardStopThreshold: 3,
  },
  cache: {
    ttlMs: 300_000,
    persistRaw: true,
  },
} as const;

export type PartialPolicy = Partial<Omit<SourcePolicy, 'poll' | 'rateLimit' | 'backoff' | 'circuitBreaker' | 'cache'>> & {
  id: string;
  tier: 0 | 1 | 2;
  latencyClass: SourcePolicy['latencyClass'];
  legalBasis: SourcePolicy['legalBasis'];
  poll?: Partial<PollPolicy>;
  rateLimit?: Partial<SourcePolicy['rateLimit']>;
  backoff?: Partial<SourcePolicy['backoff']>;
  circuitBreaker?: Partial<SourcePolicy['circuitBreaker']>;
  cache?: Partial<SourcePolicy['cache']>;
};

export class PolicyError extends Error {}

/** Merges a partial policy over the conservative defaults. */
export function normalizePolicy(input: PartialPolicy): SourcePolicy {
  const poll = { ...DEFAULT_POLICY.poll, ...input.poll };
  const policy: SourcePolicy = {
    id: input.id,
    tier: input.tier,
    latencyClass: input.latencyClass,
    legalBasis: input.legalBasis,
    enabledByDefault: input.enabledByDefault ?? false,
    requiresExplicitOptIn:
      input.requiresExplicitOptIn ?? input.legalBasis === 'TOS_GREY',
    poll: {
      ...poll,
      // The floor wins. Configuration cannot poll faster than the source allows.
      intervalMs: Math.max(poll.intervalMs, poll.minIntervalMsFloor),
    },
    rateLimit: { ...DEFAULT_POLICY.rateLimit, ...input.rateLimit },
    backoff: {
      ...DEFAULT_POLICY.backoff,
      ...input.backoff,
      on: [...(input.backoff?.on ?? DEFAULT_POLICY.backoff.on)],
    },
    circuitBreaker: {
      ...DEFAULT_POLICY.circuitBreaker,
      ...input.circuitBreaker,
      hardStopOn: [
        ...(input.circuitBreaker?.hardStopOn ?? DEFAULT_POLICY.circuitBreaker.hardStopOn),
      ],
    },
    cache: { ...DEFAULT_POLICY.cache, ...input.cache },
  };
  if (input.attribution) policy.attribution = input.attribution;

  validatePolicy(policy);
  return policy;
}

export function validatePolicy(p: SourcePolicy): void {
  const fail = (msg: string): never => {
    throw new PolicyError(`Invalid policy for source '${p.id}': ${msg}`);
  };

  if (p.poll.intervalMs < p.poll.minIntervalMsFloor) {
    fail(`poll interval ${p.poll.intervalMs}ms is below floor ${p.poll.minIntervalMsFloor}ms`);
  }
  if (p.poll.jitterPct < 0 || p.poll.jitterPct >= 1) {
    fail(`jitterPct must be in [0, 1), got ${p.poll.jitterPct}`);
  }

  // The rule that matters: a "stop" status must never also be retryable.
  const contradictory = p.backoff.on.filter((s) => p.circuitBreaker.hardStopOn.includes(s));
  if (contradictory.length > 0) {
    fail(
      `status ${contradictory.join(', ')} appears in both backoff.on and ` +
        `circuitBreaker.hardStopOn — a stop instruction must never be retried`,
    );
  }

  if (p.rateLimit.maxPerMinute <= 0) fail('rateLimit.maxPerMinute must be > 0');
  if (p.rateLimit.maxPerHour < p.rateLimit.maxPerMinute) {
    fail('rateLimit.maxPerHour must be >= maxPerMinute');
  }
  if (p.rateLimit.maxConcurrent <= 0) fail('rateLimit.maxConcurrent must be > 0');
  if (p.backoff.maxRetries < 0) fail('backoff.maxRetries must be >= 0');
  if (p.circuitBreaker.hardStopThreshold <= 0) {
    fail('circuitBreaker.hardStopThreshold must be > 0');
  }

  // A source whose terms are unclear must never be silently switched on.
  if (p.legalBasis === 'TOS_GREY' && p.enabledByDefault) {
    fail('a TOS_GREY source cannot be enabledByDefault — it requires explicit opt-in');
  }
}

/** Next poll delay with jitter applied, in ms. Never below the floor. */
export function nextPollDelay(poll: PollPolicy, clock: Clock): number {
  const spread = poll.intervalMs * poll.jitterPct;
  const offset = (clock.random() * 2 - 1) * spread;
  return Math.max(poll.minIntervalMsFloor, Math.round(poll.intervalMs + offset));
}

/** Exponential backoff with full jitter, capped at maxMs. */
export function backoffDelay(
  attempt: number,
  backoff: SourcePolicy['backoff'],
  clock: Clock,
  retryAfterMs?: number,
): number {
  if (backoff.respectRetryAfter && retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, backoff.maxMs);
  }
  const exponential = Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
  return Math.round(exponential * (0.5 + clock.random() * 0.5));
}
