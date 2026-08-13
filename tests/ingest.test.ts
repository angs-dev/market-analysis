import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestCandles, readCandles, findGaps } from '../src/ingest/candles.ts';
import { ingestAnnouncements, crossSourceKey } from '../src/ingest/events.ts';
import {
  assessLiquidity, avgTurnover20d, loadUniverse, tradeableSymbols, DEFAULT_LIQUIDITY,
} from '../src/ingest/universe.ts';
import { parseCandleCsv } from '../src/adapters/tier0/manual-csv.ts';
import type { Candle, RawAnnouncement } from '../src/market/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixtureCandles = parseCandleCsv(
  readFileSync(join(FIXTURES, 'candles_daily.csv'), 'utf8'), 'fixture');

function fresh(): Db {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  return db;
}

function candle(over: Partial<Candle> = {}): Candle {
  return {
    symbol: 'TESTCO', timeframe: '1d', ts: '2026-01-01',
    open: 100, high: 102, low: 99, close: 101, volume: 150000, vwap: null,
    provenance: { sourceId: 'manual_csv', latencyClass: 'PERIODIC', fidelity: 'LOW' },
    ...over,
  };
}

describe('candle ingest', () => {
  test('inserts and reads back with provenance intact', () => {
    const db = fresh();
    const stats = ingestCandles(db, fixtureCandles);
    assert.equal(stats.inserted, 30);

    const back = readCandles(db, 'TESTCO', '1d');
    assert.equal(back.length, 30);
    assert.equal(back[0]!.provenance.sourceId, 'manual_csv');
    assert.equal(back[0]!.provenance.fidelity, 'LOW');
    db.close();
  });

  test('re-ingesting the same bars is idempotent', () => {
    const db = fresh();
    ingestCandles(db, fixtureCandles);
    const second = ingestCandles(db, fixtureCandles);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 30);
    assert.equal(readCandles(db, 'TESTCO', '1d').length, 30);
    db.close();
  });

  // The rule that stops a delayed backfill overwriting real-time bars.
  test('higher fidelity upgrades a bar, lower fidelity does not', () => {
    const db = fresh();
    ingestCandles(db, [candle({ close: 101 })]);

    const upgrade = ingestCandles(db, [candle({
      close: 999,
      provenance: { sourceId: 'broker_ws', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    })]);
    assert.equal(upgrade.upgraded, 1);
    assert.equal(readCandles(db, 'TESTCO', '1d')[0]!.close, 999);

    const downgrade = ingestCandles(db, [candle({ close: 5 })]);
    assert.equal(downgrade.skipped, 1);
    assert.equal(readCandles(db, 'TESTCO', '1d')[0]!.close, 999,
      'a LOW-fidelity write must not clobber HIGH-fidelity data');
    db.close();
  });

  test('filters reads by range', () => {
    const db = fresh();
    ingestCandles(db, fixtureCandles);
    const out = readCandles(db, 'TESTCO', '1d', { from: '2026-01-05', to: '2026-01-07' });
    assert.deepEqual(out.map((c) => c.ts), ['2026-01-05', '2026-01-06', '2026-01-07']);
    db.close();
  });

  test('findGaps reports missing trading days inside the covered span', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    const have = [candle({ ts: '2026-01-01' }), candle({ ts: '2026-01-04' })];
    assert.deepEqual(findGaps(have, days), ['2026-01-02', '2026-01-03']);
  });
});

describe('liquidity assessment', () => {
  test('computes 20-day average turnover as close x volume', () => {
    const bars = [candle({ close: 100, volume: 1000 }), candle({ close: 200, volume: 1000 })];
    assert.equal(avgTurnover20d(bars, 2), 150_000);
  });

  test('returns null when history is too short to judge', () => {
    assert.equal(avgTurnover20d([candle()], 20), null);
  });

  // The fixture trades ~3.16 cr/day, which is deliberately just under the
  // 5 cr default. Both sides of that boundary are asserted.
  test('accepts an instrument that clears the configured threshold', () => {
    const v = assessLiquidity(fixtureCandles, {
      ...DEFAULT_LIQUIDITY,
      minAvgTurnover20d: 10_000_000, // 1 cr
    });
    assert.equal(v.tradeable, true);
    assert.equal(v.reason, undefined);
    assert.ok(v.avgTurnover! > 0);
  });

  test('rejects the same instrument under the stricter default threshold', () => {
    const v = assessLiquidity(fixtureCandles, DEFAULT_LIQUIDITY);
    assert.equal(v.tradeable, false, '3.16 cr/day is below the 5 cr default');
    assert.match(v.reason!, /avg turnover 3\.16 cr below minimum 5\.00 cr/);
  });

  test('rejects insufficient history, with the reason stated', () => {
    const v = assessLiquidity(fixtureCandles.slice(0, 5));
    assert.equal(v.tradeable, false);
    assert.match(v.reason!, /insufficient history: 5 bars/);
  });

  test('rejects a low-priced scrip', () => {
    const penny = fixtureCandles.map((c) => ({ ...c, close: 5, high: 6, low: 4 }));
    const v = assessLiquidity(penny);
    assert.equal(v.tradeable, false);
    assert.match(v.reason!, /below minimum 20/);
  });

  test('rejects thin turnover', () => {
    const thin = fixtureCandles.map((c) => ({ ...c, volume: 10 }));
    const v = assessLiquidity(thin);
    assert.equal(v.tradeable, false);
    assert.match(v.reason!, /avg turnover .* below minimum/);
  });

  test('treats missing volume as not assessable rather than as zero', () => {
    const noVol = fixtureCandles.map((c) => ({ ...c, volume: null }));
    const v = assessLiquidity(noVol);
    assert.equal(v.tradeable, false);
    assert.match(v.reason!, /no volume data/);
  });
});

describe('universe loader', () => {
  test('stores excluded instruments with a reason rather than dropping them', () => {
    const db = fresh();
    const stats = loadUniverse(db, {
      instruments: [
        { symbol: 'TESTCO', name: 'Test Company Limited', sector: 'Chemicals' },
        { symbol: 'THINCO', name: 'Thin Co' },
      ],
      candlesBySymbol: new Map([
        ['TESTCO', fixtureCandles],
        ['THINCO', fixtureCandles.map((c) => ({ ...c, volume: 5 }))],
      ]),
      config: { ...DEFAULT_LIQUIDITY, minAvgTurnover20d: 10_000_000 },
      inNifty500: true,
    });

    assert.equal(stats.total, 2);
    assert.equal(stats.tradeable, 1);
    assert.equal(stats.excluded, 1);

    const rows = db.all<{ symbol: string; is_tradeable: number; exclusion_reason: string | null }>(
      'SELECT symbol, is_tradeable, exclusion_reason FROM instruments ORDER BY symbol');
    assert.equal(rows.length, 2, 'excluded instruments stay in the table');
    const thin = rows.find((r) => r.symbol === 'THINCO')!;
    assert.equal(thin.is_tradeable, 0);
    assert.match(thin.exclusion_reason!, /avg turnover/);

    assert.deepEqual(tradeableSymbols(db), ['TESTCO']);
    db.close();
  });

  test('an instrument with no candles is excluded, not silently skipped', () => {
    const db = fresh();
    const stats = loadUniverse(db, {
      instruments: [{ symbol: 'NODATA' }],
      candlesBySymbol: new Map(),
    });
    assert.equal(stats.excluded, 1);
    const row = db.get<{ exclusion_reason: string }>(
      'SELECT exclusion_reason FROM instruments WHERE symbol = ?', 'NODATA');
    assert.match(row!.exclusion_reason, /insufficient history: 0 bars/);
    db.close();
  });

  test('re-running updates in place and preserves earlier metadata', () => {
    const db = fresh();
    const candlesBySymbol = new Map([['TESTCO', fixtureCandles]]);
    loadUniverse(db, {
      instruments: [{ symbol: 'TESTCO', name: 'Test Company Limited', isin: 'INE1' }],
      candlesBySymbol,
    });
    loadUniverse(db, { instruments: [{ symbol: 'TESTCO' }], candlesBySymbol });

    const rows = db.all<{ isin: string | null; name: string | null }>(
      'SELECT isin, name FROM instruments');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.isin, 'INE1', 'a later row without ISIN must not erase it');
    db.close();
  });
});

describe('event ingest', () => {
  function announcement(over: Partial<RawAnnouncement> = {}): RawAnnouncement {
    return {
      dedupeKey: 'k1', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Q1 results revenue up 16 percent',
      filedAt: '2026-08-13T05:33:00.000Z',
      detectedAt: '2026-08-13T05:34:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
      ...over,
    };
  }

  test('inserts and records our detection lag', () => {
    const db = fresh();
    assert.equal(ingestAnnouncements(db, [announcement()]).inserted, 1);
    const row = db.get<{ detection_lag_sec: number }>(
      'SELECT detection_lag_sec FROM events');
    assert.equal(row!.detection_lag_sec, 60);
    db.close();
  });

  test('the same dedupe key is not inserted twice', () => {
    const db = fresh();
    ingestAnnouncements(db, [announcement()]);
    const again = ingestAnnouncements(db, [announcement()]);
    assert.equal(again.duplicates, 1);
    assert.equal(again.inserted, 0);
    db.close();
  });

  test('a primary filing upgrades an earlier secondary report of the same event', () => {
    const db = fresh();
    ingestAnnouncements(db, [announcement({
      dedupeKey: 'rss:1', sourceId: 'rss_news', sourceTier: 'SECONDARY_NEWS',
    })]);
    const stats = ingestAnnouncements(db, [announcement({
      dedupeKey: 'bse:1', sourceId: 'bse_announcements', sourceTier: 'PRIMARY_EXCHANGE',
    })]);

    assert.equal(stats.upgraded, 1);
    const rows = db.all<{ source_tier: string }>('SELECT source_tier FROM events');
    assert.equal(rows.length, 1, 'the event is stored once');
    assert.equal(rows[0]!.source_tier, 'PRIMARY_EXCHANGE');
    db.close();
  });

  test('a secondary report does not downgrade an existing primary filing', () => {
    const db = fresh();
    ingestAnnouncements(db, [announcement({ dedupeKey: 'bse:1' })]);
    const stats = ingestAnnouncements(db, [announcement({
      dedupeKey: 'rss:1', sourceId: 'rss_news', sourceTier: 'SECONDARY_NEWS',
    })]);
    assert.equal(stats.duplicates, 1);
    assert.equal(stats.upgraded, 0);
    const row = db.get<{ source_tier: string }>('SELECT source_tier FROM events');
    assert.equal(row!.source_tier, 'PRIMARY_EXCHANGE');
    db.close();
  });

  test('different events on the same day are both kept', () => {
    const db = fresh();
    ingestAnnouncements(db, [
      announcement({ dedupeKey: 'a', headline: 'Q1 results revenue up 16 percent' }),
      announcement({ dedupeKey: 'b', headline: 'Board approves buyback of equity shares' }),
    ]);
    const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');
    assert.equal(row!.n, 2);
    db.close();
  });

  test('crossSourceKey is null without a symbol, so unmatched news never merges', () => {
    assert.equal(crossSourceKey(announcement({ symbol: null })), null);
  });
});
