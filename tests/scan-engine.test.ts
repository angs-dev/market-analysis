/**
 * ScanEngine: market session, two-stage screening, scan lock, extension risk,
 * data freshness, and the ScanResult contract.
 *
 * Everything here is deterministic — fixed clocks, fixture bars, no network.
 * Trading logic is never tested against live data.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestCandles } from '../src/ingest/candles.ts';
import { ingestAnnouncements } from '../src/ingest/events.ts';
import { loadUniverse, DEFAULT_LIQUIDITY } from '../src/ingest/universe.ts';
import { marketSession, toIst, loadHolidays, DEFAULT_SESSION } from '../src/market/session.ts';
import { acquireLock, releaseLock, readLock, withLock } from '../src/scan/lock.ts';
import { screen, symbolsWithOpenPositions } from '../src/scan/screener.ts';
import { assessExtension, EXTENSION_THRESHOLDS } from '../src/scan/extension.ts';
import { buildFreshness } from '../src/scan/freshness.ts';
import { ScanEngine } from '../src/scan/engine.ts';
import { loadConfig, DEFAULT_TRIGGERS } from '../src/config/index.ts';
import { emptyFeatures } from '../src/scoring/features.ts';
import { assessPricedIn } from '../src/pricedin/engine.ts';
import type { Candle, Provenance } from '../src/market/types.ts';
import type { ScanEnvelope } from '../src/scan/types.ts';

const PROV: Provenance = { sourceId: 'manual_csv', latencyClass: 'PERIODIC', fidelity: 'LOW' };
const REALTIME: Provenance = { sourceId: 'upstox_feed_v3', latencyClass: 'REALTIME', fidelity: 'HIGH' };

/** IST helper: builds a UTC instant for a given IST wall-clock time. */
function ist(date: string, hh: number, mm: number): Date {
  return new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
}

function series(symbol: string, n = 80, opts: { volumeSpikeAtEnd?: boolean } = {}): Candle[] {
  const out: Candle[] = [];
  let price = 500;
  for (let i = 0; i < n; i++) {
    price = Math.max(50, price + Math.sin(i / 6) * 3 + 0.4);
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const isLast = i === n - 1;
    out.push({
      symbol, timeframe: '1d', ts: date,
      open: price - 1, high: price + 4, low: price - 4, close: price,
      volume: isLast && opts.volumeSpikeAtEnd ? 3_000_000 : 500_000,
      vwap: null, provenance: PROV,
    });
  }
  return out;
}

function seeded(opts: { volumeSpike?: boolean } = {}): Db {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  const stock = series('TESTCO', 80, { volumeSpikeAtEnd: opts.volumeSpike ?? false });
  const bench = series('NIFTY_50', 80).map((c) => ({ ...c, symbol: 'NIFTY_50' }));
  ingestCandles(db, [...stock, ...bench]);
  loadUniverse(db, {
    instruments: [{ symbol: 'TESTCO', name: 'Test Company Limited' }, { symbol: 'NIFTY_50' }],
    candlesBySymbol: new Map([['TESTCO', stock], ['NIFTY_50', bench]]),
    config: { ...DEFAULT_LIQUIDITY, minAvgTurnover20d: 1_000_000 },
  });
  return db;
}

// ── Market session (§2, §41) ────────────────────────────────────────────────

describe('market session', () => {
  test('decomposes an instant into IST regardless of host timezone', () => {
    // 04:00 UTC on a Wednesday = 09:30 IST the same day.
    const parts = toIst(new Date('2026-08-12T04:00:00Z'));
    assert.equal(parts.date, '2026-08-12');
    assert.equal(parts.minutes, 9 * 60 + 30);
    assert.equal(parts.weekday, 3);
  });

  // The boundary GitHub Actions gets wrong: UTC evening is the next IST day.
  test('20:00 UTC belongs to the following IST date', () => {
    assert.equal(toIst(new Date('2026-08-12T20:00:00Z')).date, '2026-08-13');
  });

  test('is OPEN during the continuous session', () => {
    const s = marketSession(ist('2026-08-12', 11, 3));
    assert.equal(s.status, 'OPEN');
    assert.equal(s.isOpen, true);
    assert.equal(s.isScanWindow, true);
    assert.equal(s.minutesToClose, (15 * 60 + 30) - (11 * 60 + 3));
  });

  test('boundaries are exact at 09:15 and 15:30', () => {
    assert.equal(marketSession(ist('2026-08-12', 9, 14)).status, 'PRE_OPEN');
    assert.equal(marketSession(ist('2026-08-12', 9, 15)).status, 'OPEN');
    assert.equal(marketSession(ist('2026-08-12', 15, 29)).status, 'OPEN');
    assert.equal(marketSession(ist('2026-08-12', 15, 30)).status, 'POST_CLOSE');
  });

  // Results are commonly filed after the close, so events still matter.
  test('post-close remains a scan window but not an open market', () => {
    const s = marketSession(ist('2026-08-12', 15, 45));
    assert.equal(s.status, 'POST_CLOSE');
    assert.equal(s.isOpen, false);
    assert.equal(s.isScanWindow, true);
  });

  test('weekends are closed', () => {
    assert.equal(marketSession(ist('2026-08-15', 11, 0)).status, 'WEEKEND'); // Saturday
    assert.equal(marketSession(ist('2026-08-16', 11, 0)).status, 'WEEKEND'); // Sunday
  });

  test('a configured holiday closes an ordinary weekday', () => {
    const s = marketSession(ist('2026-08-12', 11, 0), {
      holidays: loadHolidays(['2026-08-12']),
    });
    assert.equal(s.status, 'HOLIDAY');
    assert.equal(s.isScanWindow, false);
  });

  test('a special session opens an otherwise closed day', () => {
    const s = marketSession(ist('2026-08-15', 18, 30), {
      window: { ...DEFAULT_SESSION, open: 18 * 60, close: 19 * 60 },
      specialSessions: loadHolidays(['2026-08-15']),
    });
    assert.equal(s.status, 'OPEN');
  });

  // Guessing dates would either skip a trading day or hammer a closed exchange.
  test('the holiday list is empty unless supplied, never invented', () => {
    assert.equal(loadHolidays().size, 0);
    assert.equal(loadHolidays(['nonsense', '2026-01-26']).size, 1);
  });
});

// ── Scan lock (§26, §41) ────────────────────────────────────────────────────

describe('scan lock', () => {
  test('a second caller cannot take a held lock', () => {
    const db = seeded();
    assert.equal(acquireLock(db, 'scheduler').acquired, true);
    const second = acquireLock(db, 'manual');
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy, 'scheduler');
    db.close();
  });

  test('releasing allows the next caller in', () => {
    const db = seeded();
    acquireLock(db, 'scheduler');
    releaseLock(db, 'scheduler');
    assert.equal(readLock(db).lockedBy, null);
    assert.equal(acquireLock(db, 'manual').acquired, true);
    db.close();
  });

  // A crashed scan must not wedge the scanner permanently.
  test('an expired lock is reclaimable', () => {
    const db = seeded();
    const t0 = new Date('2026-08-12T05:00:00Z');
    acquireLock(db, 'crashed', t0, 60_000);
    assert.equal(acquireLock(db, 'next', new Date(t0.getTime() + 30_000)).acquired, false);
    assert.equal(acquireLock(db, 'next', new Date(t0.getTime() + 61_000)).acquired, true);
    db.close();
  });

  test('only the holder can release', () => {
    const db = seeded();
    acquireLock(db, 'owner');
    assert.equal(releaseLock(db, 'someone-else'), false);
    assert.equal(readLock(db).lockedBy, 'owner');
    db.close();
  });

  test('withLock releases even when the body throws', async () => {
    const db = seeded();
    await assert.rejects(() =>
      withLock(db, 'owner', async () => { throw new Error('boom'); }),
    );
    assert.equal(readLock(db).lockedBy, null, 'lock released despite the failure');
    db.close();
  });

  test('withLock returns null rather than running concurrently', async () => {
    const db = seeded();
    acquireLock(db, 'holder');
    let ran = false;
    const result = await withLock(db, 'other', async () => { ran = true; return 1; });
    assert.equal(result, null);
    assert.equal(ran, false, 'the body must not run while another scan holds the lock');
    db.close();
  });
});

// ── Stage 1 screening (§2) ──────────────────────────────────────────────────

describe('light screener', () => {
  const since = '2026-01-01T00:00:00.000Z';
  const base = {
    triggers: DEFAULT_TRIGGERS, since, maxDeep: 25,
    maxEventAgeMinutes: 240, now: new Date('2026-03-21T05:00:00Z'),
  };

  test('promotes a symbol on unusual volume', () => {
    const db = seeded({ volumeSpike: true });
    const hits = screen(db, base);
    const hit = hits.find((h) => h.symbol === 'TESTCO');
    assert.ok(hit, 'volume spike should promote the symbol');
    assert.ok(hit!.reasons.includes('UNUSUAL_VOLUME'));
    db.close();
  });

  test('does not promote a quiet symbol', () => {
    const db = seeded({ volumeSpike: false });
    const hits = screen(db, base);
    assert.equal(hits.find((h) => h.symbol === 'TESTCO'), undefined);
    db.close();
  });

  test('promotes on a fresh material event', () => {
    const db = seeded();
    ingestAnnouncements(db, [{
      dedupeKey: 'e1', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Unaudited financial results for the quarter ended 31 December 2026',
      filedAt: '2026-03-21T04:50:00.000Z', detectedAt: '2026-03-21T04:51:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
    }]);
    const hit = screen(db, base).find((h) => h.symbol === 'TESTCO');
    assert.ok(hit);
    assert.ok(hit!.reasons.includes('NEW_EVENT'));
    db.close();
  });

  // A filing from days ago is not a live catalyst.
  test('ignores an event older than the configured age limit', () => {
    const db = seeded();
    ingestAnnouncements(db, [{
      dedupeKey: 'old', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Unaudited financial results for the quarter ended 30 September 2026',
      filedAt: '2026-03-18T04:00:00.000Z', detectedAt: '2026-03-18T04:01:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
    }]);
    const hit = screen(db, base).find((h) => h.symbol === 'TESTCO');
    assert.equal(hit?.reasons.includes('NEW_EVENT') ?? false, false);
    db.close();
  });

  test('routine disclosures never promote a symbol', () => {
    const db = seeded();
    ingestAnnouncements(db, [{
      dedupeKey: 'routine', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Newspaper publication of unaudited financial results',
      filedAt: '2026-03-21T04:50:00.000Z', detectedAt: '2026-03-21T04:51:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
    }]);
    const hit = screen(db, base).find((h) => h.symbol === 'TESTCO');
    assert.equal(hit?.reasons.includes('NEW_EVENT') ?? false, false);
    db.close();
  });

  test('agreeing signals outrank a single signal', () => {
    const db = seeded({ volumeSpike: true });
    ingestAnnouncements(db, [{
      dedupeKey: 'e1', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Receipt of order worth Rs 450 crore',
      filedAt: '2026-03-21T04:50:00.000Z', detectedAt: '2026-03-21T04:51:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
    }]);
    const hit = screen(db, base).find((h) => h.symbol === 'TESTCO')!;
    assert.ok(hit.reasons.length >= 2, 'both signals recorded');
    assert.ok(hit.priority > 100);
    db.close();
  });

  test('caps promotions at the configured budget', () => {
    const db = seeded({ volumeSpike: true });
    assert.ok(screen(db, { ...base, maxDeep: 1 }).length <= 1);
    db.close();
  });

  test('open positions are always promoted', () => {
    const db = seeded();
    const hits = screen(db, { ...base, alwaysInclude: ['TESTCO'] });
    const hit = hits.find((h) => h.symbol === 'TESTCO')!;
    assert.ok(hit.reasons.includes('OPEN_POSITION'));
    assert.equal(symbolsWithOpenPositions(db).length, 0, 'none open in a fresh database');
    db.close();
  });
});

// ── Extension risk (§7) ─────────────────────────────────────────────────────

describe('extension risk', () => {
  function featuresWith(over: {
    sinceEvent?: number; vwapDist?: number; fromEma?: number;
    dayChange?: number; atrPct?: number; volumeRatio?: number;
    upperWick?: number; toResistance?: number; atrBurn?: number;
  }) {
    const f = emptyFeatures('X', '2026-08-12T05:33:00.000Z', 1);
    f.momentum.changeSinceEventPct = over.sinceEvent ?? 1;
    f.momentum.dayChangePct = over.dayChange ?? 1;
    f.momentum.atrPct = over.atrPct ?? 2;
    f.volume.vwapDistPct = over.vwapDist ?? 0.5;
    f.volume.volumeRatio = over.volumeRatio ?? 2;
    f.trend.pctFrom20Ema = over.fromEma ?? 1;
    f.candle.upperWickPct = over.upperWick ?? 10;
    f.entry.distanceToResistancePct = over.toResistance ?? 6;
    f.entry.atrBurnRatio = over.atrBurn ?? 0.8;
    return f;
  }

  const early = assessPricedIn({
    eventType: 'RESULTS', moveSinceEventPct: 1, preEventDrift5dPct: 0,
    preEventDriftVsSectorPct: 0, preEventVolumeAnomaly: 1, gapPct: null,
    gapFilledPct: null, atrPct: 2, atrBurnRatio: 0.8, pctFrom20Ema: 1,
    distanceToResistancePct: 6, pctOf52wRange: 60,
  });

  test('an early, contained reaction is LOW risk', () => {
    const a = assessExtension(featuresWith({}), early);
    assert.equal(a.risk, 'LOW');
    assert.ok(a.factors.length >= 6, 'all available factors considered');
  });

  // The core "don't chase" case.
  test('a stock already +10% with every factor stretched is EXTREME', () => {
    const a = assessExtension(
      featuresWith({
        sinceEvent: 10, vwapDist: 5, fromEma: 11, dayChange: 10,
        atrPct: 2, volumeRatio: 12, upperWick: 55, toResistance: 0.3, atrBurn: 2.6,
      }),
      early,
    );
    assert.equal(a.risk, 'EXTREME');
    assert.ok(a.score >= EXTENSION_THRESHOLDS.extreme);
  });

  test('the priced-in verdict can raise risk but never lower it', () => {
    const overextended = assessPricedIn({
      eventType: 'RESULTS', moveSinceEventPct: 12, preEventDrift5dPct: 0,
      preEventDriftVsSectorPct: 0, preEventVolumeAnomaly: 1, gapPct: null,
      gapFilledPct: null, atrPct: 2, atrBurnRatio: 2.5, pctFrom20Ema: 11,
      distanceToResistancePct: 0.5, pctOf52wRange: 98,
    });
    // Technically calm inputs, but the event is fully priced in.
    const a = assessExtension(featuresWith({}), overextended);
    assert.equal(a.risk, 'EXTREME');
  });

  test('every factor carries a value and a human note', () => {
    for (const factor of assessExtension(featuresWith({}), early).factors) {
      assert.ok(factor.name.length > 0);
      assert.ok(factor.note.length > 0);
      assert.ok(factor.weight >= 0 && factor.weight <= 1);
    }
  });

  // Absence of data must not read as absence of risk.
  test('no inputs yields MEDIUM rather than LOW', () => {
    const bare = emptyFeatures('X', '2026-08-12T00:00:00.000Z');
    assert.equal(assessExtension(bare, early).risk, 'MEDIUM');
  });
});

// ── Data freshness (§36) ────────────────────────────────────────────────────

describe('data freshness', () => {
  const openSession = marketSession(ist('2026-08-12', 11, 0));
  const closedSession = marketSession(ist('2026-08-12', 18, 0));

  function bar(latency: Provenance): Candle {
    return {
      symbol: 'X', timeframe: '1d', ts: '2026-08-12T05:30:00.000Z',
      open: 100, high: 101, low: 99, close: 100, volume: 1000, vwap: null,
      provenance: latency,
    };
  }

  test('a stale real-time feed degrades the candidate during market hours', () => {
    const f = buildFreshness({
      candles: [bar(REALTIME)],
      now: new Date('2026-08-12T05:40:00Z'), // 10 minutes later
      session: openSession, staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.price.stale, true);
    assert.equal(f.degraded, true);
    assert.match(f.notes.join(' '), /PAPER_BUY is disabled/);
  });

  test('a fresh feed is not degraded', () => {
    const f = buildFreshness({
      candles: [bar(REALTIME)],
      now: new Date('2026-08-12T05:30:30Z'),
      session: openSession, staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.price.stale, false);
    assert.equal(f.degraded, false);
  });

  // Outside session hours the latest bar is legitimately old.
  test('an old bar outside market hours is not flagged stale', () => {
    const f = buildFreshness({
      candles: [bar(REALTIME)],
      now: new Date('2026-08-12T12:30:00Z'),
      session: closedSession, staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.price.stale, false, 'staleness is meaningless when the market is shut');
  });

  test('non-realtime data during market hours is noted, not silently accepted', () => {
    const f = buildFreshness({
      candles: [bar(PROV)],
      now: new Date('2026-08-12T05:31:00Z'),
      session: openSession, staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.match(f.notes.join(' '), /not real-time/);
  });

  test('missing price data degrades the candidate', () => {
    const f = buildFreshness({
      candles: [], now: new Date(), session: openSession,
      staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.degraded, true);
    assert.match(f.notes.join(' '), /no price data/);
  });

  test('news detection lag is measured and classified', () => {
    const f = buildFreshness({
      candles: [bar(REALTIME)],
      event: { filed_at: '2026-08-12T05:30:00Z', detected_at: '2026-08-12T05:30:48Z' },
      now: new Date('2026-08-12T05:31:00Z'),
      session: openSession, staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.news.detectionLagSeconds, 48);
    assert.equal(f.news.latency, 'NEAR_REALTIME');
  });

  test('absent fundamentals report UNAVAILABLE rather than a value', () => {
    const f = buildFreshness({
      candles: [bar(REALTIME)], now: new Date(), session: closedSession,
      staleFeedMs: 120_000, fundamentalsAsOf: null,
    });
    assert.equal(f.fundamentals.label, 'UNAVAILABLE');
    assert.equal(f.fundamentals.asOf, null);
  });
});

// ── ScanEngine (§1, §15) ────────────────────────────────────────────────────

describe('ScanEngine', () => {
  function engineFor(db: Db, at: Date, emit?: (e: ScanEnvelope) => void): ScanEngine {
    const deps: ConstructorParameters<typeof ScanEngine>[0] = {
      db, config: loadConfig(), now: () => at,
    };
    if (emit) deps.emit = emit;
    return new ScanEngine(deps);
  }

  test('returns a complete ScanResult and records the run', async () => {
    const db = seeded({ volumeSpike: true });
    const engine = engineFor(db, ist('2026-08-12', 11, 0));
    const result = await engine.scanNow({ mode: 'ONCE', trigger: 'MANUAL' });

    assert.equal(result.marketStatus, 'OPEN');
    assert.equal(result.marketOpen, true);
    assert.ok(result.scanRunId !== null);
    assert.ok(Array.isArray(result.candidates));
    assert.ok(Array.isArray(result.rejectedCandidates));
    assert.ok(result.stats.durationMs >= 0);

    const run = db.get<{ finished_at: string | null; mode: string }>(
      'SELECT finished_at, mode FROM scan_runs WHERE id = ?', result.scanRunId!,
    );
    assert.ok(run!.finished_at !== null, 'the run is closed out');
    assert.equal(run!.mode, 'ONCE');
    db.close();
  });

  test('refuses to scan outside the window and says why', async () => {
    const db = seeded();
    const result = await engineFor(db, ist('2026-08-16', 11, 0)).scanNow({
      mode: 'ONCE', trigger: 'SCHEDULE',
    });
    assert.equal(result.marketStatus, 'WEEKEND');
    assert.match(result.noTradeReason ?? '', /weekend/i);
    assert.equal(result.candidates.length, 0);
    db.close();
  });

  test('an explicit symbol list bypasses stage 1', async () => {
    const db = seeded({ volumeSpike: false });
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'MANUAL', trigger: 'MANUAL', symbols: ['TESTCO'],
    });
    assert.equal(result.stats.symbolsDeepAnalysed, 1);
    assert.equal(result.candidates[0]!.triggeredBy[0], 'MANUAL');
    db.close();
  });

  test('every candidate carries freshness, reasons and an audit trail', async () => {
    const db = seeded();
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'MANUAL', trigger: 'MANUAL', symbols: ['TESTCO'],
    });
    const c = result.candidates[0]!;
    assert.ok(c.dataFreshness !== undefined);
    assert.ok(c.explanations.length > 0);
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'EXTREME'].includes(c.extensionRisk));
    assert.ok(['PAPER_BUY', 'WATCH', 'IGNORE', 'NO_TRADE'].includes(c.action));
    assert.ok(c.candidateId !== null, 'persisted for later re-scoring');
    db.close();
  });

  test('candidates are ranked by opportunity quality, not by percentage gain', async () => {
    const db = seeded();
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'MANUAL', trigger: 'MANUAL', symbols: ['TESTCO', 'NIFTY_50'],
    });
    for (let i = 1; i < result.candidates.length; i++) {
      assert.ok(
        result.candidates[i - 1]!.swing10Score >= result.candidates[i]!.swing10Score,
        'ordered by score descending',
      );
    }
    db.close();
  });

  test('emits progress envelopes for the real-time channel', async () => {
    const db = seeded();
    const seen: string[] = [];
    const engine = engineFor(db, ist('2026-08-12', 11, 0), (e) => seen.push(e.name));
    await engine.scanNow({ mode: 'MANUAL', trigger: 'MANUAL', symbols: ['TESTCO'] });
    assert.ok(seen.includes('scan:started'));
    assert.ok(seen.includes('scan:completed'));
    db.close();
  });

  test('links every candidate to its scan run', async () => {
    const db = seeded();
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'MANUAL', trigger: 'MANUAL', symbols: ['TESTCO'],
    });
    const linked = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM scan_candidates WHERE scan_run_id = ?', result.scanRunId!,
    );
    assert.equal(linked!.n, result.candidates.length);
    db.close();
  });

  test('stores a market snapshot per run', async () => {
    const db = seeded();
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'ONCE', trigger: 'SCHEDULE',
    });
    const snap = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM market_snapshots WHERE scan_run_id = ?', result.scanRunId!,
    );
    assert.equal(snap!.n, 1);
    db.close();
  });

  test('reports partial regime data rather than inventing it', async () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'ONCE', trigger: 'SCHEDULE',
    });
    assert.equal(result.marketRegime.label, null);
    assert.ok(result.marketRegime.missing.length > 0);
    assert.match(result.marketRegime.reasons.join(' '), /insufficient benchmark history/);
    db.close();
  });

  test('a failure is returned in the result rather than thrown', async () => {
    const db = seeded();
    db.run('DROP TABLE candles');
    const result = await engineFor(db, ist('2026-08-12', 11, 0)).scanNow({
      mode: 'ONCE', trigger: 'SCHEDULE',
    });
    assert.ok(result.error !== undefined, 'the scanner reports failure, it does not crash');
    db.close();
  });
});
