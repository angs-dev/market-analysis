/**
 * 1-minute candle construction from a live tick stream:
 * creation, rollover, missing ticks, and validation against historical bars.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CandleBuilder, bucketStart, validateAgainstHistorical, MINUTE_MS,
} from '../src/technicals/candle-builder.ts';
import type { Tick } from '../src/market/tick.ts';
import type { Candle, Provenance } from '../src/market/types.ts';

const PROV: Provenance = { sourceId: 'upstox_feed_v3', latencyClass: 'REALTIME', fidelity: 'HIGH' };

/** Base time: 2026-08-13T05:33:00Z = 11:03 IST. */
const T0 = Date.parse('2026-08-13T05:33:00.000Z');

function tick(offsetMs: number, ltp: number, volumeToday: number | null = null): Tick {
  const ts = new Date(T0 + offsetMs).toISOString();
  return {
    symbol: 'RELIANCE', instrumentKey: 'NSE_EQ|INE002A01018',
    ltp, ltq: 1, volumeToday, atp: null, prevClose: null,
    exchangeTs: ts, receivedAt: ts, latencyMs: 0, isIndex: false, provenance: PROV,
  };
}

function candle(over: Partial<Candle>): Candle {
  return {
    symbol: 'RELIANCE', timeframe: '1m', ts: '2026-08-13T05:33:00.000Z',
    open: 100, high: 100, low: 100, close: 100, volume: null, vwap: null,
    provenance: PROV, ...over,
  };
}

describe('bucketStart', () => {
  test('floors to the minute', () => {
    assert.equal(bucketStart(T0 + 59_999), T0);
    assert.equal(bucketStart(T0 + 60_000), T0 + MINUTE_MS);
  });
});

describe('candle creation', () => {
  test('builds OHLC from the tick sequence', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    b.add(tick(1_000, 105));
    b.add(tick(2_000, 98));
    b.add(tick(3_000, 102));

    const partial = b.peek('RELIANCE')!;
    assert.equal(partial.open, 100, 'open is the first tick');
    assert.equal(partial.high, 105);
    assert.equal(partial.low, 98);
    assert.equal(partial.close, 102, 'close is the latest tick');
    assert.equal(partial.tickCount, 4);
    assert.equal(partial.ts, '2026-08-13T05:33:00.000Z');
  });

  test('a single tick makes a valid four-equal-price bar', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    const p = b.peek('RELIANCE')!;
    assert.equal(p.open, 100);
    assert.equal(p.high, 100);
    assert.equal(p.low, 100);
    assert.equal(p.close, 100);
  });

  // Cumulative volume must be differenced, not summed.
  test('derives volume from the cumulative-volume delta', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100, 1_000_000));
    b.add(tick(30_000, 101, 1_004_500));
    const [done] = b.flush();
    assert.equal(done!.volume, 4_500, 'volume is the delta, not the cumulative total');
  });

  test('volume is null when the feed carries no cumulative volume', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100, null));
    b.add(tick(1_000, 101, null));
    const [done] = b.flush();
    assert.equal(done!.volume, null, 'ltpc mode must not fabricate a volume');
  });

  test('builds separate bars per symbol', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    b.add({ ...tick(0, 24_000), symbol: 'NIFTY_50', instrumentKey: 'NSE_INDEX|Nifty 50' });
    assert.equal(b.openCount, 2);
    assert.equal(b.peek('NIFTY_50')!.open, 24_000);
  });

  test('tags a bar built from receive time when no exchange time exists', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add({ ...tick(0, 100), exchangeTs: null });
    assert.equal(b.peek('RELIANCE')!.usedReceiveTime, true);
  });

  test('carries the provenance of the live feed', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    const [done] = b.flush();
    assert.equal(done!.provenance.fidelity, 'HIGH');
    assert.equal(done!.timeframe, '1m');
  });
});

describe('candle rollover', () => {
  test('closes the previous bar when a tick lands in the next minute', () => {
    const emitted: Candle[] = [];
    const b = new CandleBuilder({ provenance: PROV, onCandle: (c) => emitted.push(c) });

    b.add(tick(0, 100, 1_000));
    b.add(tick(30_000, 110, 1_500));
    const rolled = b.add(tick(60_000, 111, 1_800));

    assert.ok(rolled, 'the boundary tick returns the completed bar');
    assert.equal(rolled!.ts, '2026-08-13T05:33:00.000Z');
    assert.equal(rolled!.open, 100);
    assert.equal(rolled!.high, 110);
    assert.equal(rolled!.close, 110, 'the new minute tick does not close the old bar');
    assert.equal(rolled!.volume, 500);
    assert.equal(emitted.length, 1);

    const next = b.peek('RELIANCE')!;
    assert.equal(next.ts, '2026-08-13T05:34:00.000Z');
    assert.equal(next.open, 111);
  });

  test('a tick at exactly the boundary opens the new bar', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    const rolled = b.add(tick(MINUTE_MS, 200));
    assert.ok(rolled);
    assert.equal(b.peek('RELIANCE')!.ts, '2026-08-13T05:34:00.000Z');
  });

  test('a tick at 59.999s stays in the same bar', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    assert.equal(b.add(tick(59_999, 200)), null);
    assert.equal(b.peek('RELIANCE')!.high, 200);
  });

  test('rolls multiple minutes in sequence', () => {
    const emitted: Candle[] = [];
    const b = new CandleBuilder({ provenance: PROV, onCandle: (c) => emitted.push(c) });
    for (let i = 0; i < 5; i++) b.add(tick(i * MINUTE_MS, 100 + i));
    assert.equal(emitted.length, 4, 'four bars closed, the fifth is still open');
    assert.deepEqual(emitted.map((c) => c.close), [100, 101, 102, 103]);
  });

  test('flush closes the final open bar', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100));
    const flushed = b.flush();
    assert.equal(flushed.length, 1);
    assert.equal(b.openCount, 0);
  });

  // Late data must never mutate a bar that has already been published.
  test('a tick for an already-closed bar is dropped', () => {
    const emitted: Candle[] = [];
    const b = new CandleBuilder({ provenance: PROV, onCandle: (c) => emitted.push(c) });
    b.add(tick(0, 100));
    b.add(tick(MINUTE_MS, 200));
    assert.equal(b.add(tick(10_000, 999)), null, 'late tick rejected');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.high, 100, 'the published bar was not mutated');
  });
});

describe('missing ticks', () => {
  test('a minute with no ticks produces no bar — gaps are visible, not invented', () => {
    const emitted: Candle[] = [];
    const b = new CandleBuilder({ provenance: PROV, onCandle: (c) => emitted.push(c) });

    b.add(tick(0, 100));                 // 05:33
    b.add(tick(3 * MINUTE_MS, 105));     // 05:36 — 05:34 and 05:35 had no trades
    b.flush();

    assert.deepEqual(
      emitted.map((c) => c.ts),
      ['2026-08-13T05:33:00.000Z', '2026-08-13T05:36:00.000Z'],
    );
    assert.equal(emitted.length, 2, 'no synthetic bars are fabricated for empty minutes');
  });

  test('an illiquid instrument with one tick still yields one honest bar', () => {
    const b = new CandleBuilder({ provenance: PROV });
    b.add(tick(0, 100, 500));
    const [done] = b.flush();
    assert.equal(done!.open, done!.close);
    assert.equal(done!.volume, 0, 'a single tick shows no volume delta within the bar');
  });

  test('a tick with an unparseable timestamp is ignored', () => {
    const b = new CandleBuilder({ provenance: PROV });
    assert.equal(b.add({ ...tick(0, 100), exchangeTs: 'not-a-date' }), null);
    assert.equal(b.openCount, 0);
  });
});

describe('validation against historical bars', () => {
  test('reports a clean match', () => {
    const bars = [candle({ ts: '2026-08-13T05:33:00.000Z', open: 100, high: 110, low: 99, close: 105, volume: 500 })];
    const report = validateAgainstHistorical(bars, bars);
    assert.equal(report.compared, 1);
    assert.equal(report.matched, 1);
    assert.equal(report.mismatches.length, 0);
    assert.equal(report.maxRelDiffPct, 0);
  });

  test('flags a field that differs beyond tolerance', () => {
    const live = [candle({ high: 110, close: 105 })];
    const hist = [candle({ high: 112, close: 105 })];
    const report = validateAgainstHistorical(live, hist, 0.1);
    assert.equal(report.matched, 0);
    assert.equal(report.mismatches.length, 1);
    assert.equal(report.mismatches[0]!.field, 'high');
    assert.ok(report.mismatches[0]!.relDiffPct! > 1.7);
  });

  test('tolerates a difference within the configured band', () => {
    const live = [candle({ close: 105.0 })];
    const hist = [candle({ close: 105.05 })];
    assert.equal(validateAgainstHistorical(live, hist, 0.1).matched, 1);
  });

  // A sampled tick stream legitimately misses extremes traded between ticks.
  test('separates bars present on only one side', () => {
    const live = [candle({ ts: '2026-08-13T05:33:00.000Z' }), candle({ ts: '2026-08-13T05:34:00.000Z' })];
    const hist = [candle({ ts: '2026-08-13T05:34:00.000Z' }), candle({ ts: '2026-08-13T05:35:00.000Z' })];
    const report = validateAgainstHistorical(live, hist);
    assert.deepEqual(report.onlyLive, ['2026-08-13T05:33:00.000Z']);
    assert.deepEqual(report.onlyHistorical, ['2026-08-13T05:35:00.000Z']);
    assert.equal(report.compared, 1);
  });

  test('skips comparison where either side has null volume', () => {
    const live = [candle({ volume: null })];
    const hist = [candle({ volume: 5000 })];
    const report = validateAgainstHistorical(live, hist);
    assert.equal(report.matched, 1, 'unknown volume is not a mismatch');
  });
});
