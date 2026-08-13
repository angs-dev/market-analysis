import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffDelay,
  nextPollDelay,
  normalizePolicy,
  PolicyError,
  type PartialPolicy,
} from '../src/sources/policy.ts';
import { FakeClock } from '../src/sources/clock.ts';

const BASE: PartialPolicy = {
  id: 'test',
  tier: 0,
  latencyClass: 'PERIODIC',
  legalBasis: 'PUBLISHED_FILE',
};

describe('normalizePolicy', () => {
  test('fills conservative defaults', () => {
    const p = normalizePolicy(BASE);
    assert.equal(p.poll.intervalMs, 60_000);
    assert.equal(p.rateLimit.maxConcurrent, 2);
    assert.deepEqual(p.circuitBreaker.hardStopOn, [403]);
    assert.equal(p.enabledByDefault, false, 'sources are off unless explicitly on');
  });

  test('clamps a too-fast poll interval up to the floor', () => {
    const p = normalizePolicy({
      ...BASE,
      poll: { intervalMs: 1_000, minIntervalMsFloor: 30_000 },
    });
    assert.equal(p.poll.intervalMs, 30_000, 'configuration cannot poll below the floor');
  });

  test('marks a TOS_GREY source as requiring explicit opt-in', () => {
    const p = normalizePolicy({ ...BASE, legalBasis: 'TOS_GREY' });
    assert.equal(p.requiresExplicitOptIn, true);
  });

  test('rejects a TOS_GREY source that is enabled by default', () => {
    assert.throws(
      () => normalizePolicy({ ...BASE, legalBasis: 'TOS_GREY', enabledByDefault: true }),
      PolicyError,
    );
  });

  // A stop instruction must never also be retryable.
  test('rejects a policy that would retry a stop status', () => {
    assert.throws(
      () =>
        normalizePolicy({
          ...BASE,
          backoff: { on: [429, 403] },
          circuitBreaker: { hardStopOn: [403] },
        }),
      (err: unknown) =>
        err instanceof PolicyError && /must never be retried/.test(err.message),
    );
  });

  test('rejects incoherent rate limits', () => {
    assert.throws(
      () => normalizePolicy({ ...BASE, rateLimit: { maxPerMinute: 100, maxPerHour: 10 } }),
      PolicyError,
    );
  });
});

describe('nextPollDelay', () => {
  test('applies symmetric jitter around the interval', () => {
    const poll = {
      intervalMs: 60_000,
      jitterPct: 0.1,
      marketHoursOnly: true,
      tradingDaysOnly: true,
      minIntervalMsFloor: 30_000,
    };
    assert.equal(nextPollDelay(poll, new FakeClock(0, 0.5)), 60_000, 'mid-random = no offset');
    assert.equal(nextPollDelay(poll, new FakeClock(0, 1)), 66_000, 'max jitter = +10%');
    assert.equal(nextPollDelay(poll, new FakeClock(0, 0)), 54_000, 'min jitter = -10%');
  });

  test('never returns a delay below the floor', () => {
    const poll = {
      intervalMs: 30_000,
      jitterPct: 0.9,
      marketHoursOnly: true,
      tradingDaysOnly: true,
      minIntervalMsFloor: 30_000,
    };
    assert.equal(nextPollDelay(poll, new FakeClock(0, 0)), 30_000);
  });
});

describe('backoffDelay', () => {
  const backoff = {
    strategy: 'EXPONENTIAL_JITTER' as const,
    baseMs: 1_000,
    maxMs: 10_000,
    maxRetries: 5,
    respectRetryAfter: true,
    on: [429, 503],
  };

  test('grows exponentially and caps at maxMs', () => {
    const clock = new FakeClock(0, 1);
    assert.equal(backoffDelay(0, backoff, clock), 1_000);
    assert.equal(backoffDelay(1, backoff, clock), 2_000);
    assert.equal(backoffDelay(2, backoff, clock), 4_000);
    assert.equal(backoffDelay(10, backoff, clock), 10_000, 'capped');
  });

  test('applies jitter in the [0.5, 1.0] band', () => {
    assert.equal(backoffDelay(1, backoff, new FakeClock(0, 0)), 1_000, 'half of 2000');
  });

  test('prefers Retry-After when present, still capped', () => {
    const clock = new FakeClock(0, 1);
    assert.equal(backoffDelay(0, backoff, clock, 5_000), 5_000);
    assert.equal(backoffDelay(0, backoff, clock, 999_000), 10_000);
  });
});
