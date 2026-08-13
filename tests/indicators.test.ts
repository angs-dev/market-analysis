/**
 * Indicator tests.
 *
 * Expected values marked REF were produced by an independent reference
 * implementation written separately from the TypeScript under test (plain
 * loops, no shared helpers), so a shared mistake cannot confirm itself. The
 * fixture is a synthetic 30-bar series — not real market data.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atr, closingStrength, ema, highest, latest, lowest, rateOfChange,
  relativeStrength, rsi, sma, trueRange, volumeRatio, vwap, wilderSmooth,
  type OHLCV,
} from '../src/technicals/indicators.ts';
import { parseCandleCsv } from '../src/adapters/tier0/manual-csv.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const candles = parseCandleCsv(
  readFileSync(join(FIXTURES, 'candles_daily.csv'), 'utf8'),
  'candles_daily.csv',
);

const closes = candles.map((c) => c.close);
const volumes = candles.map((c) => c.volume);
const bars: OHLCV[] = candles.map((c) => ({
  open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
}));

/** Compares to the reference value at the precision the reference was printed. */
function closeTo(actual: number | null, expected: number, places = 8): void {
  assert.ok(actual !== null, 'expected a value, got null');
  const delta = Math.abs(actual - expected);
  assert.ok(
    delta < 10 ** -places,
    `expected ${expected}, got ${actual} (delta ${delta.toExponential(3)})`,
  );
}

describe('fixture', () => {
  test('loads 30 daily bars', () => {
    assert.equal(candles.length, 30);
    assert.equal(candles[0]!.ts, '2026-01-01');
    assert.equal(candles.at(-1)!.ts, '2026-02-12');
  });
});

describe('sma', () => {
  test('is null during warm-up and defined from period-1', () => {
    const out = sma(closes, 20);
    assert.equal(out[18], null);
    assert.notEqual(out[19], null);
  });

  test('matches the reference at the final bar', () => {
    closeTo(latest(sma(closes, 20)), 104.115); // REF
  });

  test('a flat series averages to its own value', () => {
    assert.deepEqual(sma([5, 5, 5, 5], 2), [null, 5, 5, 5]);
  });

  test('rejects a non-positive period', () => {
    assert.throws(() => sma(closes, 0), /positive integer/);
  });
});

describe('ema', () => {
  test('seeds on the SMA of the first period values', () => {
    const out = ema(closes, 20);
    closeTo(out[19] ?? null, 102.91); // REF — equals SMA(20) at the seed bar
    closeTo(sma(closes, 20)[19] ?? null, 102.91);
  });

  test('matches the reference at the final bar', () => {
    closeTo(latest(ema(closes, 20)), 104.3866282929); // REF
    closeTo(latest(ema(closes, 9)), 105.1534042608); // REF
  });

  test('returns all null when the series is shorter than the period', () => {
    assert.deepEqual(ema([1, 2, 3], 5), [null, null, null]);
  });
});

describe('wilderSmooth', () => {
  test('is not the same as ema of the same period', () => {
    const w = latest(wilderSmooth(closes, 14));
    const e = latest(ema(closes, 14));
    assert.notEqual(w, e, 'Wilder smoothing uses k = 1/period, not 2/(period+1)');
  });
});

describe('rsi', () => {
  test('first defined value is at index period', () => {
    const out = rsi(closes, 14);
    assert.equal(out[13], null);
    assert.notEqual(out[14], null);
  });

  test('matches the reference across the series', () => {
    const out = rsi(closes, 14);
    closeTo(out[14] ?? null, 55.4545454545); // REF
    closeTo(out[20] ?? null, 53.0301322764); // REF
    closeTo(latest(out), 54.4829319116); // REF
  });

  test('a monotonically rising series pins at 100', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    assert.equal(latest(rsi(rising, 14)), 100, 'zero average loss yields 100');
  });

  test('a monotonically falling series approaches 0', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 200 - i);
    const value = latest(rsi(falling, 14));
    assert.ok(value !== null && value < 1e-9, `expected ~0, got ${value}`);
  });

  test('stays within 0..100 for every bar', () => {
    for (const v of rsi(closes, 14)) {
      if (v === null) continue;
      assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
    }
  });
});

describe('trueRange / atr', () => {
  test('first bar TR is simply high minus low', () => {
    closeTo(trueRange(bars)[0] ?? null, 3.3); // REF
  });

  test('TR uses the previous close when it extends the range', () => {
    const tr = trueRange(bars);
    closeTo(tr[1] ?? null, 2.3); // REF
    closeTo(tr[4] ?? null, 4.5); // REF — gap bar, prev close extends the range
  });

  test('matches the reference ATR', () => {
    const out = atr(bars, 14);
    closeTo(out[13] ?? null, 2.7571428571); // REF
    closeTo(latest(out), 2.474447899); // REF
  });

  test('ATR is never negative', () => {
    for (const v of atr(bars, 14)) {
      if (v !== null) assert.ok(v >= 0);
    }
  });
});

describe('vwap', () => {
  test('a single-bar session equals that bar typical price', () => {
    const one: OHLCV[] = [{ open: 10, high: 12, low: 8, close: 11, volume: 100 }];
    closeTo(vwap(one, () => 'D1')[0] ?? null, (12 + 8 + 11) / 3);
  });

  test('accumulates within a session and resets at the boundary', () => {
    const two: OHLCV[] = [
      { open: 10, high: 12, low: 8, close: 10, volume: 100 }, // typical 10
      { open: 10, high: 22, low: 18, close: 20, volume: 100 }, // typical 20
    ];
    const sameSession = vwap(two, () => 'D1');
    closeTo(sameSession[1] ?? null, 15, 6); // volume-weighted mean of 10 and 20

    const split = vwap(two, (i) => `D${i}`);
    closeTo(split[1] ?? null, 20, 6); // reset — second session sees only bar 2
  });

  test('is null when the bar has no volume', () => {
    const noVol: OHLCV[] = [{ open: 10, high: 12, low: 8, close: 11, volume: null }];
    assert.equal(vwap(noVol, () => 'D1')[0], null);
  });

  test('weights by volume rather than averaging typical prices', () => {
    const weighted: OHLCV[] = [
      { open: 10, high: 10, low: 10, close: 10, volume: 900 },
      { open: 20, high: 20, low: 20, close: 20, volume: 100 },
    ];
    closeTo(latest(vwap(weighted, () => 'D1')), 11, 6);
  });
});

describe('volumeRatio', () => {
  test('matches the reference', () => {
    const out = volumeRatio(volumes, 20);
    closeTo(out[20] ?? null, 1.286573978); // REF
    closeTo(latest(out), 0.8901578771); // REF
  });

  test('excludes the current bar from its own baseline', () => {
    // Ten bars of 100, then one of 1000. Baseline must be 100, ratio 10 -
    // including the spike in its own average would give ~5.5.
    const v = [...Array<number>(10).fill(100), 1000];
    closeTo(latest(volumeRatio(v, 10)), 10, 6);
  });

  test('is null before enough history exists', () => {
    assert.equal(volumeRatio([100, 200, 300], 20)[2], null);
  });
});

describe('rateOfChange / relativeStrength', () => {
  test('rate of change is a percentage over the lookback', () => {
    closeTo(rateOfChange([100, 105, 110], 2)[2] ?? null, 10, 6);
  });

  test('relative strength is the outperformance in percentage points', () => {
    const stock = [100, 100, 110]; // +10%
    const bench = [100, 100, 104]; // +4%
    closeTo(relativeStrength(stock, bench, 2)[2] ?? null, 6, 6);
  });

  test('negative when the stock lags its benchmark', () => {
    const value = relativeStrength([100, 100, 102], [100, 100, 108], 2)[2];
    assert.ok(value !== null && value !== undefined && value < 0);
  });

  // Misaligned series would silently produce nonsense.
  test('throws when the series lengths differ', () => {
    assert.throws(() => relativeStrength([1, 2, 3], [1, 2], 1), /lengths differ/);
  });
});

describe('highest / lowest', () => {
  test('track the trailing extremes inclusive of the current bar', () => {
    const v = [3, 1, 4, 1, 5];
    assert.deepEqual(highest(v, 3), [null, null, 4, 4, 5]);
    assert.deepEqual(lowest(v, 3), [null, null, 1, 1, 1]);
  });
});

describe('closingStrength', () => {
  test('1 on the high, 0 on the low, 0.5 mid-range', () => {
    assert.equal(closingStrength({ open: 5, high: 10, low: 0, close: 10, volume: 1 }), 1);
    assert.equal(closingStrength({ open: 5, high: 10, low: 0, close: 0, volume: 1 }), 0);
    assert.equal(closingStrength({ open: 5, high: 10, low: 0, close: 5, volume: 1 }), 0.5);
  });

  test('a zero-range bar is neutral rather than dividing by zero', () => {
    assert.equal(closingStrength({ open: 7, high: 7, low: 7, close: 7, volume: 1 }), 0.5);
  });
});

describe('null discipline', () => {
  test('every series function returns an array the length of its input', () => {
    for (const out of [
      sma(closes, 20), ema(closes, 20), rsi(closes, 14),
      atr(bars, 14), volumeRatio(volumes, 20), rateOfChange(closes, 5),
      highest(closes, 10), lowest(closes, 10),
    ]) {
      assert.equal(out.length, closes.length);
    }
  });

  test('latest ignores trailing nulls', () => {
    assert.equal(latest([1, 2, null]), 2);
    assert.equal(latest([null, null]), null);
  });
});
