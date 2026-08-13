import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SourceGovernor, type RequestLog } from '../src/sources/governor.ts';
import { normalizePolicy } from '../src/sources/policy.ts';
import { FakeClock } from '../src/sources/clock.ts';
import {
  HttpStatusError,
  SourceBlockedError,
  SourceExhaustedError,
  SourceNotPermittedError,
  SourceUnavailableError,
} from '../src/sources/errors.ts';
import type { PartialPolicy } from '../src/sources/policy.ts';

const BASE: PartialPolicy = {
  id: 'test',
  tier: 0,
  latencyClass: 'PERIODIC',
  legalBasis: 'PUBLISHED_FILE',
  enabledByDefault: true,
  poll: { intervalMs: 60_000, minIntervalMsFloor: 30_000 },
  rateLimit: { maxPerMinute: 3, maxPerHour: 100, minGapMs: 1_000, maxConcurrent: 2 },
  backoff: { baseMs: 1_000, maxMs: 10_000, maxRetries: 2, on: [429, 503] },
  circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000, hardStopOn: [403], hardStopThreshold: 3 },
};

function make(overrides: Partial<PartialPolicy> = {}) {
  const clock = new FakeClock();
  const logs: RequestLog[] = [];
  const governor = new SourceGovernor({ clock, onRequest: (l) => logs.push(l) });
  governor.register(normalizePolicy({ ...BASE, ...overrides } as PartialPolicy));
  return { governor, clock, logs };
}

describe('SourceGovernor', () => {
  test('executes and returns the value', async () => {
    const { governor } = make();
    assert.equal(await governor.execute('test', async () => 42), 42);
  });

  test('refuses unregistered and disabled sources', async () => {
    const { governor } = make();
    await assert.rejects(
      () => governor.execute('nope', async () => 1),
      SourceNotPermittedError,
    );
    governor.setEnabled('test', false);
    await assert.rejects(
      () => governor.execute('test', async () => 1),
      SourceNotPermittedError,
    );
  });

  describe('rate limiting', () => {
    test('enforces the minimum gap between consecutive requests', async () => {
      const { governor, clock } = make();
      await governor.execute('test', async () => 1);
      const before = clock.now();
      await governor.execute('test', async () => 2);
      assert.equal(clock.now() - before, 1_000, 'second request waits minGapMs');
    });

    test('enforces the per-minute ceiling by waiting for the window to roll', async () => {
      const { governor, clock } = make({
        rateLimit: { maxPerMinute: 3, maxPerHour: 100, minGapMs: 0, maxConcurrent: 2 },
      });
      for (let i = 0; i < 3; i++) await governor.execute('test', async () => i);
      assert.equal(clock.now(), 0, 'first three are immediate');

      await governor.execute('test', async () => 4);
      assert.equal(clock.now(), 60_000, 'fourth waits for the oldest to age out');
    });

    test('reports request counts in health', async () => {
      const { governor } = make({
        rateLimit: { maxPerMinute: 5, maxPerHour: 100, minGapMs: 0, maxConcurrent: 2 },
      });
      await governor.execute('test', async () => 1);
      await governor.execute('test', async () => 2);
      const health = governor.health('test');
      assert.equal(health.requestsThisMinute, 2);
      assert.equal(health.requestsThisHour, 2);
      assert.equal(health.breakerState, 'CLOSED');
    });
  });

  describe('backoff', () => {
    test('retries a retryable status and succeeds', async () => {
      const { governor, clock } = make();
      let calls = 0;
      const result = await governor.execute('test', async () => {
        calls++;
        if (calls < 3) throw new HttpStatusError(503);
        return 'ok';
      });
      assert.equal(result, 'ok');
      assert.equal(calls, 3);
      assert.equal(clock.sleeps.length > 0, true, 'backoff slept between attempts');
    });

    test('honours Retry-After when the policy says to', async () => {
      const { governor, clock } = make({
        rateLimit: { maxPerMinute: 10, maxPerHour: 100, minGapMs: 0, maxConcurrent: 2 },
      });
      let calls = 0;
      await governor.execute('test', async () => {
        calls++;
        if (calls === 1) throw new HttpStatusError(429, 5_000);
        return 'ok';
      });
      assert.ok(clock.sleeps.includes(5_000), `expected a 5000ms wait, got ${clock.sleeps}`);
    });

    test('gives up with SourceExhaustedError after maxRetries', async () => {
      const { governor } = make();
      let calls = 0;
      await assert.rejects(
        () =>
          governor.execute('test', async () => {
            calls++;
            throw new HttpStatusError(503);
          }),
        SourceExhaustedError,
      );
      assert.equal(calls, 3, 'initial attempt plus two retries');
    });

    test('does not retry a non-retryable status', async () => {
      const { governor } = make();
      let calls = 0;
      await assert.rejects(
        () =>
          governor.execute('test', async () => {
            calls++;
            throw new HttpStatusError(404);
          }),
        HttpStatusError,
      );
      assert.equal(calls, 1);
    });
  });

  // The behaviour this whole layer exists to guarantee.
  describe('403 handling', () => {
    test('never retries a 403 and surfaces SourceBlockedError immediately', async () => {
      const { governor, clock } = make();
      let calls = 0;
      await assert.rejects(
        () =>
          governor.execute('test', async () => {
            calls++;
            throw new HttpStatusError(403);
          }),
        SourceBlockedError,
      );
      assert.equal(calls, 1, 'a stop instruction must be obeyed on the first response');
      assert.equal(clock.sleeps.length, 0, 'no backoff sleep before giving up');
    });

    test('repeated 403s hard-stop the source for the session', async () => {
      const { governor, clock } = make();
      const fail = async () => {
        throw new HttpStatusError(403);
      };

      for (let i = 0; i < 3; i++) {
        await assert.rejects(() => governor.execute('test', fail), SourceBlockedError);
        clock.advance(2_000);
      }
      assert.equal(governor.health('test').breakerState, 'HARD_STOPPED');

      // Subsequent calls are refused without touching the network at all.
      let attempted = false;
      await assert.rejects(
        () =>
          governor.execute('test', async () => {
            attempted = true;
            return 1;
          }),
        SourceUnavailableError,
      );
      assert.equal(attempted, false, 'hard-stopped source is never contacted again');
    });
  });

  describe('request logging', () => {
    test('logs every attempt including retries, with status and retry count', async () => {
      const { governor, logs } = make();
      let calls = 0;
      await governor.execute(
        'test',
        async () => {
          calls++;
          if (calls === 1) throw new HttpStatusError(503);
          return 'ok';
        },
        { urlHash: 'abc123' },
      );

      assert.equal(logs.length, 2);
      assert.equal(logs[0]!.httpStatus, 503);
      assert.equal(logs[0]!.retryCount, 0);
      assert.equal(logs[1]!.httpStatus, 200);
      assert.equal(logs[1]!.retryCount, 1);
      assert.equal(logs[1]!.urlHash, 'abc123');
    });
  });
});
