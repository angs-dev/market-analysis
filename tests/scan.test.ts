/**
 * End-to-end: stored data through feature assembly, decision, and persistence.
 *
 * Asserts the property the validation loop depends on — that every candidate,
 * including rejects, lands in the database with its raw features and its full
 * explanation trail intact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestCandles } from '../src/ingest/candles.ts';
import { ingestAnnouncements } from '../src/ingest/events.ts';
import { loadUniverse, DEFAULT_LIQUIDITY } from '../src/ingest/universe.ts';
import { parseCandleCsv } from '../src/adapters/tier0/manual-csv.ts';
import { buildFeatures } from '../src/scoring/build-features.ts';
import { decide } from '../src/scoring/decide.ts';
import { saveCandidate, summariseCandidates, explanationsFor, loadFeaturesForRescore, gateHitCounts } from '../src/ingest/candidates.ts';
import { runScan } from '../src/jobs/scan.ts';
import type { FeatureVector } from '../src/scoring/features.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const candles = parseCandleCsv(readFileSync(join(FIXTURES, 'candles_daily.csv'), 'utf8'), 'fixture');

function seeded(): Db {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  ingestCandles(db, candles);
  loadUniverse(db, {
    instruments: [{ symbol: 'TESTCO', name: 'Test Company Limited', sector: 'Chemicals' }],
    candlesBySymbol: new Map([['TESTCO', candles]]),
    config: { ...DEFAULT_LIQUIDITY, minAvgTurnover20d: 10_000_000 },
  });
  ingestAnnouncements(db, [{
    dedupeKey: 'e1', symbol: 'TESTCO', exchange: 'BSE',
    headline: 'Q1 results: revenue up 16 percent',
    filedAt: '2026-02-12T05:33:00.000Z', detectedAt: '2026-02-12T05:34:00.000Z',
    sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
  }]);
  return db;
}

describe('feature assembly from stored data', () => {
  test('computes structure, momentum and candle features from real bars', () => {
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    assert.equal(f.meta.symbol, 'TESTCO');
    assert.ok(f.momentum.rsi14 !== null);
    assert.ok(f.momentum.atrPct !== null && f.momentum.atrPct > 0);
    assert.ok(f.volume.volumeRatio !== null);
    assert.ok(f.candle.pattern !== null);
    assert.ok(f.trend.pctFrom20Ema !== null);
  });

  test('records provenance from the candles it consumed', () => {
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    assert.equal(f.provenance['manual_csv'], 'PERIODIC');
  });

  test('leaves unavailable features null and lists them as missing', () => {
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    assert.equal(f.fundamental.patYoY, null);
    assert.equal(f.volume.vwapPosition, null, 'no VWAP at Tier 0');
    assert.ok(f.meta.missing.includes('fundamental.patYoY'));
    assert.ok(f.meta.missing.includes('volume.vwapPosition'));
  });

  // Misaligned series would silently produce a meaningless number.
  test('omits relative strength when the benchmark series does not align', () => {
    const f = buildFeatures({
      symbol: 'TESTCO', candles, benchmarkCloses: [1, 2, 3],
    });
    assert.equal(f.trend.rsVsNifty, null);
  });

  test('computes relative strength when the benchmark aligns bar for bar', () => {
    const bench = candles.map((_, i) => 24_000 + i * 10);
    const f = buildFeatures({ symbol: 'TESTCO', candles, benchmarkCloses: bench });
    assert.ok(f.trend.rsVsNifty !== null);
  });

  test('too little history yields an empty vector rather than a guess', () => {
    const f = buildFeatures({ symbol: 'TESTCO', candles: candles.slice(0, 1) });
    assert.equal(f.momentum.rsi14, null);
    assert.equal(f.entry.support, null);
  });
});

describe('candidate persistence', () => {
  test('stores the decision, raw features and every explanation row', () => {
    const db = seeded();
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    const d = decide(f, candles.at(-1)!.close);
    const saved = saveCandidate(db, d);

    assert.ok(saved.candidateId > 0);
    assert.equal(saved.contributionsStored, d.explanations.length);

    const stored = explanationsFor(db, saved.candidateId);
    assert.equal(stored.length, d.explanations.length);
    assert.ok(stored.every((e) => e.feature.length > 0 && e.rationale.length > 0));
    db.close();
  });

  // Without rejects, "was the gate right?" is unanswerable.
  test('rejected candidates are stored, not discarded', () => {
    const db = seeded();
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    f.liquidity = { avgTurnover20d: 1_000, isTradeable: false, exclusionReason: 'thin' };
    const d = decide(f, candles.at(-1)!.close);
    assert.equal(d.action, 'IGNORE');

    saveCandidate(db, d);
    const rows = summariseCandidates(db);
    assert.equal(rows.find((r) => r.action === 'IGNORE')?.count, 1);
    assert.equal(gateHitCounts(db)[0]!.veto_gate, 'POOR_LIQUIDITY');
    db.close();
  });

  // The property that makes offline weight optimisation possible at all.
  test('raw features round-trip so history can be re-scored under new weights', () => {
    const db = seeded();
    const original = buildFeatures({ symbol: 'TESTCO', candles });
    saveCandidate(db, decide(original, candles.at(-1)!.close));

    const [loaded] = loadFeaturesForRescore(db);
    const restored = loaded!.features as FeatureVector;

    assert.equal(restored.momentum.rsi14, original.momentum.rsi14);
    assert.equal(restored.volume.volumeRatio, original.volume.volumeRatio);
    assert.equal(restored.entry.support, original.entry.support);

    // Re-scoring the restored vector reproduces the original decision exactly.
    const rescored = decide(restored, candles.at(-1)!.close);
    assert.equal(rescored.eventQuality.total, decide(original, candles.at(-1)!.close).eventQuality.total);
    db.close();
  });

  test('a trade plan is stored only when one exists', () => {
    const db = seeded();
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    const d = decide(f, candles.at(-1)!.close);
    const saved = saveCandidate(db, d);

    const plan = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM trade_plans WHERE candidate_id = ?', saved.candidateId);
    assert.equal(plan!.n, d.plan === null ? 0 : 1);
    db.close();
  });
});

describe('scan job', () => {
  test('evaluates the universe and stores a candidate for each', () => {
    const db = seeded();
    const result = runScan(db);
    assert.equal(result.evaluated, 1);
    assert.equal(result.decisions[0]!.symbol, 'TESTCO');

    const stored = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM candidates');
    assert.equal(stored!.n, 1);
    db.close();
  });

  test('skips instruments with too little history, and says why', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    ingestCandles(db, candles.slice(0, 5));
    loadUniverse(db, {
      instruments: [{ symbol: 'TESTCO' }],
      candlesBySymbol: new Map([['TESTCO', candles.slice(0, 5)]]),
    });

    const result = runScan(db);
    assert.equal(result.evaluated, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /too little history/);
    db.close();
  });

  test('attaches the most recent event to the candidate', () => {
    const db = seeded();
    const result = runScan(db);
    assert.ok(result.decisions[0]!.features.meta.eventId !== null);
    assert.equal(result.decisions[0]!.features.event.sourceTier, 'PRIMARY_EXCHANGE');
    db.close();
  });

  test('every decision carries a human-readable summary', () => {
    const db = seeded();
    for (const d of runScan(db).decisions) {
      assert.ok(d.summary.length > 0);
      assert.ok(d.summary[0]!.length > 10);
    }
    db.close();
  });
});
