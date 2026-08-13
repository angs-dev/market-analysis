import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, type BreakerAlert } from '../src/sources/breaker.ts';
import { FakeClock } from '../src/sources/clock.ts';
import type { CircuitBreakerPolicy } from '../src/sources/types.ts';

const POLICY: CircuitBreakerPolicy = {
  failureThreshold: 3,
  cooldownMs: 60_000,
  hardStopOn: [403],
  hardStopThreshold: 3,
};

function make(policy: Partial<CircuitBreakerPolicy> = {}) {
  const clock = new FakeClock();
  const alerts: BreakerAlert[] = [];
  const breaker = new CircuitBreaker('test', { ...POLICY, ...policy }, clock, (a) =>
    alerts.push(a),
  );
  return { breaker, clock, alerts };
}

describe('CircuitBreaker', () => {
  test('starts closed and permits attempts', () => {
    const { breaker } = make();
    assert.equal(breaker.state, 'CLOSED');
    assert.equal(breaker.canAttempt(), true);
  });

  test('opens after the configured number of consecutive soft failures', () => {
    const { breaker, alerts } = make();
    breaker.recordFailure(500);
    breaker.recordFailure(500);
    assert.equal(breaker.state, 'CLOSED', 'should not open before the threshold');
    breaker.recordFailure(500);
    assert.equal(breaker.state, 'OPEN');
    assert.equal(breaker.canAttempt(), false);
    assert.equal(alerts.length, 1);
  });

  test('a success resets the consecutive failure count', () => {
    const { breaker } = make();
    breaker.recordFailure(500);
    breaker.recordFailure(500);
    breaker.recordSuccess();
    breaker.recordFailure(500);
    breaker.recordFailure(500);
    assert.equal(breaker.state, 'CLOSED');
  });

  test('moves OPEN -> HALF_OPEN once the cooldown elapses, and closes on success', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure(503);
    assert.equal(breaker.canAttempt(), false);

    clock.advance(59_999);
    assert.equal(breaker.canAttempt(), false, 'still cooling down');

    clock.advance(1);
    assert.equal(breaker.canAttempt(), true);
    assert.equal(breaker.state, 'HALF_OPEN');

    breaker.recordSuccess();
    assert.equal(breaker.state, 'CLOSED');
  });

  // The rule that matters most.
  describe('hard stop (403)', () => {
    test('identifies stop statuses distinctly from soft failures', () => {
      const { breaker } = make();
      assert.equal(breaker.isHardStop(403), true);
      assert.equal(breaker.isHardStop(500), false);
      assert.equal(breaker.isHardStop(undefined), false);
    });

    test('hard-stops after the threshold and never recovers on its own', () => {
      const { breaker, clock, alerts } = make();
      breaker.recordFailure(403);
      breaker.recordFailure(403);
      assert.equal(breaker.state, 'CLOSED', 'below threshold');

      breaker.recordFailure(403);
      assert.equal(breaker.state, 'HARD_STOPPED');
      assert.equal(breaker.canAttempt(), false);

      // No amount of waiting reopens a hard stop.
      clock.advance(365 * 24 * 3_600_000);
      assert.equal(breaker.canAttempt(), false);
      assert.equal(breaker.state, 'HARD_STOPPED');

      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!.reason, /refusing automated access/);
    });

    test('403s do not count towards the soft-failure threshold', () => {
      const { breaker } = make({ hardStopThreshold: 10 });
      for (let i = 0; i < 5; i++) breaker.recordFailure(403);
      assert.equal(
        breaker.snapshot().consecutiveFailures,
        0,
        'a stop instruction is not a transient failure',
      );
      assert.equal(breaker.state, 'CLOSED');
      assert.equal(breaker.snapshot().hardStopHits, 5);
    });

    test('only a manual reset clears a hard stop', () => {
      const { breaker } = make();
      for (let i = 0; i < 3; i++) breaker.recordFailure(403);
      assert.equal(breaker.state, 'HARD_STOPPED');
      breaker.reset();
      assert.equal(breaker.state, 'CLOSED');
      assert.equal(breaker.canAttempt(), true);
    });
  });
});
