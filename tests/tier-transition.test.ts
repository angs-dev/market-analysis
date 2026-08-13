/**
 * Two things Milestone 2 has to prove:
 *
 *  1. Attaching a broker source flips Tier 0 to Tier 1 with no change to any
 *     other code — the seam either works or it does not.
 *  2. The 403 rule differs by source, and the two never get conflated. On a
 *     public endpoint 403 means "stop"; on an authenticated broker API it
 *     means "your token expired", and hard-stopping there would take the feed
 *     down for a whole session on a routine credential renewal.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SourceRegistry } from '../src/sources/registry.ts';
import { resolveCapabilities } from '../src/sources/capabilities.ts';
import { SourceGovernor } from '../src/sources/governor.ts';
import { normalizePolicy } from '../src/sources/policy.ts';
import { FakeClock } from '../src/sources/clock.ts';
import { HttpStatusError, SourceBlockedError, SourceExhaustedError } from '../src/sources/errors.ts';
import { SOURCES_CONFIG } from '../src/paths.ts';
import { UpstoxProvider, toUnitInterval } from '../src/adapters/tier1/upstox/provider.ts';
import { UpstoxCredentials, TOKEN_ENV } from '../src/adapters/tier1/upstox/credentials.ts';
import { assertTimeframe, supportsIntraday, supportsStreaming } from '../src/market/provider.ts';
import { resolveUniverse, DEFAULT_INDEX_KEYS } from '../src/adapters/tier1/upstox/instruments.ts';

const credentials = (): UpstoxCredentials =>
  UpstoxCredentials.fromEnv({ [TOKEN_ENV]: 'test-token-value' } as NodeJS.ProcessEnv);

describe('403 semantics differ by source', () => {
  function governorFor(hardStopOn: number[]) {
    const clock = new FakeClock();
    const governor = new SourceGovernor({ clock });
    governor.register(
      normalizePolicy({
        id: 'src', tier: 0, latencyClass: 'PERIODIC', legalBasis: 'PUBLISHED_FILE',
        enabledByDefault: true,
        rateLimit: { maxPerMinute: 100, maxPerHour: 1000, minGapMs: 0, maxConcurrent: 2 },
        backoff: { maxRetries: 2, baseMs: 10, on: [429, 503] },
        circuitBreaker: { hardStopOn, hardStopThreshold: 3, failureThreshold: 10 },
      }),
    );
    return governor;
  }

  test('a public source hard-stops after repeated 403s', async () => {
    const governor = governorFor([403]);
    const fail = async () => { throw new HttpStatusError(403); };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => governor.execute('src', fail), SourceBlockedError);
    }
    assert.equal(governor.health('src').breakerState, 'HARD_STOPPED');
  });

  test('a broker source does not hard-stop on 403 — it stays recoverable', async () => {
    const governor = governorFor([]);
    const fail = async () => { throw new HttpStatusError(403); };
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => governor.execute('src', fail));
    }
    assert.notEqual(
      governor.health('src').breakerState,
      'HARD_STOPPED',
      'a broker 403 is an expired token, not an instruction to stop for the session',
    );
    // And the source still works once the credential is renewed.
    assert.equal(await governor.execute('src', async () => 'ok'), 'ok');
  });

  test('the shipped Upstox config carries the empty hardStopOn exception', () => {
    const registry = SourceRegistry.fromFile(SOURCES_CONFIG);
    for (const id of ['upstox_feed_v3', 'upstox_rest']) {
      const entry = registry.get(id);
      assert.ok(entry, `${id} must be registered`);
      assert.deepEqual(entry.policy.circuitBreaker.hardStopOn, [],
        `${id} must not hard-stop on 403`);
      assert.equal(entry.policy.legalBasis, 'BROKER_LICENSED');
    }
  });

  test('Tier 0 public sources keep the 403 hard stop', () => {
    const registry = SourceRegistry.fromFile(SOURCES_CONFIG);
    for (const { policy } of registry.byTier(0)) {
      assert.ok(policy.circuitBreaker.hardStopOn.includes(403),
        `${policy.id} must still treat 403 as a stop instruction`);
    }
  });

  test('a broker source may still exhaust retries on a genuine outage', async () => {
    const governor = governorFor([]);
    await assert.rejects(
      () => governor.execute('src', async () => { throw new HttpStatusError(503); }),
      SourceExhaustedError,
    );
  });
});

describe('Tier 0 to Tier 1 transition', () => {
  test('the shipped config resolves to Tier 0 with Upstox off', () => {
    const caps = resolveCapabilities(SourceRegistry.fromFile(SOURCES_CONFIG));
    assert.equal(caps.tier, 0);
    assert.equal(caps.reactionMode, 'EOD_PROXY');
    assert.deepEqual(caps.availableHorizons, ['t0']);
    assert.equal(caps.liveScanning, false);
  });

  // The whole point of the seam: opting in is the only change required.
  test('opting Upstox in flips to Tier 1 and unlocks every horizon', () => {
    const config = JSON.parse(
      JSON.stringify({
        optIn: ['upstox_feed_v3'],
        sources: SourceRegistry.fromFile(SOURCES_CONFIG).all().map((s) => s.policy),
      }),
    );
    const caps = resolveCapabilities(SourceRegistry.fromConfig(config));

    assert.equal(caps.tier, 1);
    assert.equal(caps.reactionMode, 'LIVE');
    assert.equal(caps.intradayReaction, 'HIGH');
    assert.equal(caps.liveScanning, true);
    assert.deepEqual(caps.availableHorizons,
      ['t0', '1m', '3m', '5m', '10m', '15m', '30m', '60m']);
    assert.equal(caps.degradations.length, 0, 'nothing is degraded at Tier 1');
  });
});

describe('UpstoxProvider satisfies the provider contract', () => {
  function provider() {
    return new UpstoxProvider({
      credentials: credentials(),
      clock: new FakeClock(),
      authorize: async () => 'wss://feed.example.invalid/v3',
      socketFactory: () => ({ send: () => {}, close: () => {} }),
      restFetcher: async () => ({
        data: {
          candles: [
            ['2026-08-13T09:15:00+05:30', 100, 110, 99, 105, 5000, 0],
            ['2026-08-13T09:16:00+05:30', 105, 108, 104, 107, 3000, 0],
          ],
        },
      }),
      keyToSymbol: new Map([['NSE_EQ|INE002A01018', 'RELIANCE']]),
      symbolToKey: new Map([['RELIANCE', 'NSE_EQ|INE002A01018']]),
    });
  }

  // Requirement 3, enforced structurally rather than by convention.
  test('exposes no order, position, or funds method', () => {
    const p = provider() as unknown as Record<string, unknown>;
    for (const forbidden of [
      'placeOrder', 'modifyOrder', 'cancelOrder', 'squareOff', 'exitPosition',
      'getPositions', 'getHoldings', 'getFunds', 'getMargins', 'getOrderBook',
      'getTradeBook', 'getProfile',
    ]) {
      assert.equal(p[forbidden], undefined, `provider must not expose ${forbidden}`);
    }
  });

  test('declares realtime streaming and full intraday capability', () => {
    const p = provider();
    assert.equal(p.capabilities.latencyClass, 'REALTIME');
    assert.equal(p.capabilities.supportsStreaming, true);
    assert.equal(supportsIntraday(p), true);
    assert.equal(supportsStreaming(p), true);
    assert.doesNotThrow(() => assertTimeframe(p, '1m'));
  });

  test('parses historical candles into the internal shape, ascending', async () => {
    const candles = await provider().getIntradayCandles('RELIANCE', '1m', {
      from: '2026-08-13', to: '2026-08-13',
    });
    assert.equal(candles.length, 2);
    assert.equal(candles[0]!.symbol, 'RELIANCE');
    assert.equal(candles[0]!.open, 100);
    assert.equal(candles[0]!.volume, 5000);
    assert.ok(candles[0]!.ts < candles[1]!.ts, 'ascending — Upstox returns newest first');
    assert.equal(candles[0]!.provenance.latencyClass, 'PERIODIC',
      'a REST pull is not a realtime tick and must not claim to be');
  });

  test('refuses a symbol with no resolved instrument key rather than guessing', async () => {
    await assert.rejects(
      () => provider().getDailyCandles('UNKNOWNCO', { from: '2026-01-01', to: '2026-01-31' }),
      /No instrument key for 'UNKNOWNCO'/,
    );
  });

  test('maps timeframes to the V3 unit/interval pairs', () => {
    assert.deepEqual(toUnitInterval('1m'), { unit: 'minutes', interval: '1' });
    assert.deepEqual(toUnitInterval('15m'), { unit: 'minutes', interval: '15' });
    assert.deepEqual(toUnitInterval('60m'), { unit: 'hours', interval: '1' });
    assert.deepEqual(toUnitInterval('1d'), { unit: 'days', interval: '1' });
  });
});

describe('instrument resolution', () => {
  const master = [
    { instrumentKey: 'NSE_EQ|INE002A01018', tradingSymbol: 'RELIANCE', name: 'Reliance',
      exchange: 'NSE', segment: 'NSE_EQ', instrumentType: 'EQ' },
    { instrumentKey: 'BSE_EQ|INE002A01018', tradingSymbol: 'RELIANCE', name: 'Reliance',
      exchange: 'BSE', segment: 'BSE_EQ', instrumentType: 'EQ' },
  ];

  test('resolves an equity symbol within its segment', () => {
    const out = resolveUniverse({ equities: ['RELIANCE'], indices: [], master });
    assert.equal(out.symbolToKey.get('RELIANCE'), 'NSE_EQ|INE002A01018');
    assert.equal(out.keyToSymbol.get('NSE_EQ|INE002A01018'), 'RELIANCE');
    assert.equal(out.unresolved.length, 0);
  });

  test('resolves the three required indices', () => {
    const out = resolveUniverse({
      equities: [], indices: ['NIFTY_50', 'NIFTY_BANK', 'INDIA_VIX'], master,
    });
    assert.equal(out.symbolToKey.get('NIFTY_50'), DEFAULT_INDEX_KEYS['NIFTY_50']);
    assert.equal(out.symbolToKey.size, 3);
    assert.equal(out.unresolved.length, 0);
  });

  // Subscribing to a wrong key yields confidently wrong data — worse than a gap.
  test('reports an unknown symbol rather than guessing a key', () => {
    const out = resolveUniverse({ equities: ['NOSUCHCO'], indices: [], master });
    assert.equal(out.symbolToKey.size, 0);
    assert.equal(out.unresolved[0]!.reason, 'not found in segment NSE_EQ');
  });

  test('reports ambiguity instead of picking one arbitrarily', () => {
    const ambiguous = [master[0]!, { ...master[0]!, instrumentKey: 'NSE_EQ|OTHER' }];
    const out = resolveUniverse({ equities: ['RELIANCE'], indices: [], master: ambiguous });
    assert.equal(out.symbolToKey.size, 0);
    assert.match(out.unresolved[0]!.reason, /ambiguous: 2 matches/);
  });

  test('says so plainly when no instrument master is loaded', () => {
    const out = resolveUniverse({ equities: ['RELIANCE'], indices: [] });
    assert.equal(out.unresolved[0]!.reason, 'no instrument master loaded');
  });
});
