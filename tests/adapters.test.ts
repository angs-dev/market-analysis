import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ManualCsvProvider, parseCandleCsv, parseEventCsv, parseUniverseCsv,
} from '../src/adapters/tier0/manual-csv.ts';
import {
  RssAdapter, buildSymbolIndex, matchSymbols, parseFeed,
} from '../src/adapters/tier0/rss.ts';
import { SourceGovernor } from '../src/sources/governor.ts';
import { normalizePolicy } from '../src/sources/policy.ts';
import { FakeClock } from '../src/sources/clock.ts';
import { HttpStatusError, SourceBlockedError } from '../src/sources/errors.ts';
import { assertTimeframe, supportsIntraday, supportsStreaming } from '../src/market/provider.ts';
import { CsvError } from '../src/parse/csv.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'swing10-'));
  mkdirSync(join(dir, 'candles'), { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  cpSync(join(FIXTURES, 'candles_daily.csv'), join(dir, 'candles', 'testco.csv'));
  writeFileSync(
    join(dir, 'universe.csv'),
    'symbol,name,isin,sector\nTESTCO,Test Company Limited,INE000A01001,Chemicals\n' +
      'OTHERCO,Other Co Ltd,INE000A01002,Cement\n',
  );
  writeFileSync(
    join(dir, 'events', 'e1.csv'),
    'symbol,date,headline,url\n' +
      'TESTCO,2026-08-13T11:03:00Z,Q1 results: revenue up 16%,https://example.invalid/1\n',
  );
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('MarketDataProvider contract', () => {
  test('ManualCsvProvider declares daily-only, no quotes, no streaming', () => {
    const p = new ManualCsvProvider({ dir });
    assert.deepEqual(p.capabilities.timeframes, ['1d']);
    assert.equal(p.capabilities.supportsStreaming, false);
    assert.equal(p.capabilities.latencyClass, 'PERIODIC');
    assert.equal(p.capabilities.fidelity, 'LOW');
    assert.equal(supportsIntraday(p), false);
    assert.equal(supportsStreaming(p), false);
  });

  // Structural guarantee: the seam has no way to trade.
  test('exposes no order, position, or funds method', () => {
    const p = new ManualCsvProvider({ dir }) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'placeOrder', 'modifyOrder', 'cancelOrder', 'getPositions',
      'getHoldings', 'getFunds', 'getMargins', 'squareOff',
    ]) {
      assert.equal(p[forbidden], undefined, `provider must not expose ${forbidden}`);
    }
  });

  test('assertTimeframe names the real limits instead of returning nothing', () => {
    const p = new ManualCsvProvider({ dir });
    assert.doesNotThrow(() => assertTimeframe(p, '1d'));
    assert.throws(() => assertTimeframe(p, '5m'), /does not support timeframe '5m'/);
  });
});

describe('manual CSV candles', () => {
  test('parses with provenance attached to every bar', () => {
    const candles = parseCandleCsv(
      readFileSync(join(FIXTURES, 'candles_daily.csv'), 'utf8'), 'fixture');
    assert.equal(candles.length, 30);
    assert.equal(candles[0]!.provenance.sourceId, 'manual_csv');
    assert.equal(candles[0]!.provenance.fidelity, 'LOW');
    assert.equal(candles[0]!.timeframe, '1d');
  });

  test('rejects a bar whose high is below its low', () => {
    assert.throws(
      () => parseCandleCsv('symbol,date,open,high,low,close,volume\nX,2026-01-01,10,9,11,10,100\n', 'f'),
      /high 9 is below low 11/,
    );
  });

  test('rejects a close outside the bar range', () => {
    assert.throws(
      () => parseCandleCsv('symbol,date,open,high,low,close,volume\nX,2026-01-01,10,12,9,15,100\n', 'f'),
      /close 15 is outside the bar range/,
    );
  });

  test('accepts a missing volume as null rather than zero', () => {
    const c = parseCandleCsv('symbol,date,open,high,low,close,volume\nX,2026-01-01,10,12,9,11,\n', 'f');
    assert.equal(c[0]!.volume, null, 'unknown volume must not become 0');
  });

  test('filters by date range inclusively', async () => {
    const p = new ManualCsvProvider({ dir });
    const out = await p.getDailyCandles('testco', { from: '2026-01-05', to: '2026-01-08' });
    assert.deepEqual(out.map((c) => c.ts), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']);
  });

  test('returns empty for an unknown symbol rather than throwing', async () => {
    const p = new ManualCsvProvider({ dir });
    assert.deepEqual(await p.getDailyCandles('NOSUCH', { from: '2020-01-01', to: '2030-01-01' }), []);
  });

  // A duplicated date silently corrupts every downstream indicator.
  test('rejects duplicate dates for the same symbol', () => {
    const dupDir = mkdtempSync(join(tmpdir(), 'swing10-dup-'));
    mkdirSync(join(dupDir, 'candles'), { recursive: true });
    writeFileSync(
      join(dupDir, 'candles', 'a.csv'),
      'symbol,date,open,high,low,close,volume\n' +
        'X,2026-01-01,10,12,9,11,100\nX,2026-01-01,10,12,9,11,100\n',
    );
    assert.throws(() => new ManualCsvProvider({ dir: dupDir }).loadAllCandles(),
      /duplicate candle for X on 2026-01-01/);
    rmSync(dupDir, { recursive: true, force: true });
  });
});

describe('manual CSV universe and events', () => {
  test('reads instruments with aliased column names', () => {
    const refs = parseUniverseCsv(
      'Symbol,Company Name,ISIN Code,Industry\nABC,Alpha Beta Ltd,INE1,Auto\n', 'f');
    assert.deepEqual(refs, [
      { symbol: 'ABC', isin: 'INE1', name: 'Alpha Beta Ltd', sector: 'Auto' },
    ]);
  });

  test('lists instruments through the provider', async () => {
    const refs = await new ManualCsvProvider({ dir }).listInstruments();
    assert.equal(refs.length, 2);
    assert.equal(refs[0]!.symbol, 'TESTCO');
  });

  test('reads events as PRIMARY_EXCHANGE with a stable dedupe key', () => {
    const events = parseEventCsv(
      'symbol,date,headline\nX,2026-08-13T11:03:00Z,Results out\n', 'f');
    assert.equal(events[0]!.sourceTier, 'PRIMARY_EXCHANGE');
    assert.equal(events[0]!.filedAt, '2026-08-13T11:03:00.000Z');
    const again = parseEventCsv(
      'symbol,date,headline\nX,2026-08-13T11:03:00Z,Results out\n', 'f');
    assert.equal(events[0]!.dedupeKey, again[0]!.dedupeKey, 'dedupe key must be stable');
  });

  test('requires a headline', () => {
    assert.throws(() => parseEventCsv('symbol,date,headline\nX,2026-08-13,\n', 'f'), CsvError);
  });
});

describe('RSS parsing', () => {
  const rssXml = readFileSync(join(FIXTURES, 'feed_rss.xml'), 'utf8');
  const atomXml = readFileSync(join(FIXTURES, 'feed_atom.xml'), 'utf8');

  test('parses RSS 2.0 items including CDATA and entities', () => {
    const items = parseFeed(rssXml);
    assert.equal(items.length, 3);
    assert.equal(items[0]!.title, 'Astral Limited reports Q1 revenue growth of 16%');
    assert.equal(items[0]!.link, 'https://example.invalid/news/1');
    assert.match(items[0]!.description!, /revenue rose 16% & PAT climbed 48%/);
    assert.equal(items[0]!.publishedAt, '2026-08-13T05:33:00.000Z');
    assert.equal(items[0]!.guid, 'news-0001');
  });

  test('parses Atom entries, taking the link from the href attribute', () => {
    const items = parseFeed(atomXml);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.link, 'https://example.invalid/atom/1');
    assert.equal(items[0]!.publishedAt, '2026-08-13T05:30:00.000Z');
  });
});

describe('symbol matching', () => {
  const index = buildSymbolIndex([
    { symbol: 'ASTRAL', name: 'Astral Limited' },
    { symbol: 'TESTCO', name: 'Test Company Limited' },
  ]);

  test('matches on ticker and on company name with suffixes stripped', () => {
    assert.deepEqual(matchSymbols('Astral reports strong Q1', index), ['ASTRAL']);
    assert.deepEqual(matchSymbols('TESTCO wins order', index), ['TESTCO']);
  });

  test('matches whole words only', () => {
    assert.deepEqual(matchSymbols('Astrally speaking, nothing here', index), []);
  });

  // Attributing news to the wrong company is worse than attributing it to none.
  test('returns nothing rather than guessing', () => {
    assert.deepEqual(matchSymbols('Broad market rallies on global cues', index), []);
  });
});

describe('RssAdapter', () => {
  function makeAdapter(fetcher: (url: string) => Promise<string>) {
    const clock = new FakeClock();
    const governor = new SourceGovernor({ clock });
    governor.register(
      normalizePolicy({
        id: 'rss_news', tier: 0, latencyClass: 'PERIODIC',
        legalBasis: 'RSS_SYNDICATION', enabledByDefault: true,
        poll: { intervalMs: 300_000, minIntervalMsFloor: 120_000 },
        rateLimit: { maxPerMinute: 10, maxPerHour: 100, minGapMs: 0, maxConcurrent: 2 },
        backoff: { maxRetries: 1, baseMs: 100, on: [429, 503] },
      }),
    );
    const adapter = new RssAdapter({
      governor,
      feeds: [{ url: 'https://example.invalid/feed', publisher: 'Test' }],
      fetcher,
    });
    return { adapter, governor, clock };
  }

  const index = buildSymbolIndex([
    { symbol: 'ASTRAL', name: 'Astral Limited' },
    { symbol: 'TESTCO', name: 'Test Company Limited' },
  ]);

  test('produces SECONDARY_NEWS announcements, never primary', async () => {
    const xml = readFileSync(join(FIXTURES, 'feed_rss.xml'), 'utf8');
    const { adapter } = makeAdapter(async () => xml);
    const { announcements, failures } = await adapter.fetchAll(index);

    assert.equal(failures.length, 0);
    for (const a of announcements) {
      assert.equal(a.sourceTier, 'SECONDARY_NEWS', 'news must never rank as a primary filing');
      assert.equal(a.sourceId, 'rss_news');
    }
    assert.equal(announcements.find((a) => a.symbol === 'ASTRAL')?.headline,
      'Astral Limited reports Q1 revenue growth of 16%');
  });

  test('keeps unmatched items with a null symbol rather than discarding them', async () => {
    const xml = readFileSync(join(FIXTURES, 'feed_rss.xml'), 'utf8');
    const { adapter } = makeAdapter(async () => xml);
    const { announcements } = await adapter.fetchAll(index);
    assert.equal(announcements.filter((a) => a.symbol === null).length, 1);
  });

  test('one failing feed does not abort the others', async () => {
    const { adapter } = makeAdapter(async () => {
      throw new HttpStatusError(500);
    });
    const { announcements, failures } = await adapter.fetchAll(index);
    assert.equal(announcements.length, 0);
    assert.equal(failures.length, 1, 'failure is reported, not swallowed');
  });

  test('routes through the governor, so a 403 hard-stops the source', async () => {
    let calls = 0;
    const { adapter, governor } = makeAdapter(async () => {
      calls++;
      throw new HttpStatusError(403);
    });
    for (let i = 0; i < 3; i++) await adapter.fetchAll(index);
    assert.equal(calls, 3, 'each 403 is a single attempt, never retried');
    assert.equal(governor.health('rss_news').breakerState, 'HARD_STOPPED');

    const before = calls;
    await adapter.fetchAll(index);
    assert.equal(calls, before, 'no further network calls after a hard stop');
    assert.ok(new SourceBlockedError('rss_news', 403) instanceof Error);
  });
});
