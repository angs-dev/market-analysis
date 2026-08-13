/**
 * The validation loop: point-in-time replay, outcome labelling, metrics.
 *
 * The most important assertions here are the negative ones — that the replay
 * cannot see the future, that the trade simulator resolves ambiguity against
 * itself, and that the metrics refuse to conclude on a small sample. A
 * validation harness that flatters the strategy is worse than none.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestCandles } from '../src/ingest/candles.ts';
import { loadUniverse, DEFAULT_LIQUIDITY } from '../src/ingest/universe.ts';
import { saveCandidate } from '../src/ingest/candidates.ts';
import { barsAsOf, runReplay } from '../src/jobs/replay.ts';
import { labelCandidates, simulateTrade, DEFAULT_HORIZONS } from '../src/validation/labeller.ts';
import {
  buildReport, maxDrawdown, tradeMetrics, wilsonInterval, assessSeparation,
  UNDERPOWERED_BELOW, type BucketMetrics,
} from '../src/validation/metrics.ts';
import { chronologicalSplit, expandingFolds, assessOverfittingRisk } from '../src/validation/walk-forward.ts';
import { renderHtml } from '../src/validation/report.ts';
import { decide } from '../src/scoring/decide.ts';
import { buildFeatures } from '../src/scoring/build-features.ts';
import type { Candle, Provenance } from '../src/market/types.ts';

const PROV: Provenance = { sourceId: 'manual_csv', latencyClass: 'PERIODIC', fidelity: 'LOW' };

/** Deterministic synthetic series: a slow uptrend with a shock at bar 70. */
function series(symbol: string, n = 120): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = i === 70 ? -8 : Math.sin(i / 5) * 0.8 + 0.15;
    price = Math.max(5, price + drift);
    const date = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      symbol, timeframe: '1d', ts: date,
      open: price - 0.3, high: price + 1.2, low: price - 1.1, close: price,
      volume: 200_000 + (i % 7) * 20_000, vwap: null, provenance: PROV,
    });
  }
  return out;
}

function seeded(): { db: Db; candles: Candle[] } {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  const candles = series('TESTCO');
  const bench = series('NIFTY_50').map((c) => ({ ...c, symbol: 'NIFTY_50' }));
  ingestCandles(db, [...candles, ...bench]);
  loadUniverse(db, {
    instruments: [{ symbol: 'TESTCO' }, { symbol: 'NIFTY_50' }],
    candlesBySymbol: new Map([['TESTCO', candles], ['NIFTY_50', bench]]),
    config: { ...DEFAULT_LIQUIDITY, minAvgTurnover20d: 1_000_000 },
  });
  return { db, candles };
}

// ── The property everything else depends on ─────────────────────────────────

describe('no lookahead', () => {
  const candles = series('X', 50);

  test('barsAsOf never returns a bar after the as-of date', () => {
    const cut = candles[20]!.ts;
    const sliced = barsAsOf(candles, cut);
    assert.equal(sliced.length, 21);
    assert.equal(sliced.at(-1)!.ts, cut);
    for (const bar of sliced) assert.ok(bar.ts <= cut);
  });

  test('barsAsOf is inclusive of the as-of bar itself', () => {
    assert.equal(barsAsOf(candles, candles[0]!.ts).length, 1);
  });

  test('a date before all history yields nothing rather than the earliest bar', () => {
    assert.equal(barsAsOf(candles, '2020-01-01').length, 0);
  });

  test('a full ISO timestamp is compared by date', () => {
    assert.equal(
      barsAsOf(candles, `${candles[10]!.ts}T23:59:59Z`).length,
      barsAsOf(candles, candles[10]!.ts).length,
    );
  });

  // The decisive test: a decision made mid-series must be identical whether or
  // not the future exists in the database.
  test('a replayed decision is unchanged by future bars being present', () => {
    const full = series('X', 120);
    const truncated = full.slice(0, 80);
    const asOf = full[79]!.ts;

    const fromFull = buildFeatures({ symbol: 'X', candles: barsAsOf(full, asOf) });
    const fromTruncated = buildFeatures({ symbol: 'X', candles: truncated });

    const a = decide(fromFull, full[79]!.close);
    const b = decide(fromTruncated, truncated[79]!.close);

    assert.equal(a.action, b.action);
    assert.equal(a.eventQuality.total, b.eventQuality.total);
    assert.equal(a.tradeQuality.total, b.tradeQuality.total);
    assert.deepEqual(a.plan, b.plan);
  });

  test('replay stamps each candidate with its as-of date, not today', () => {
    const { db } = seeded();
    const result = runReplay(db, { from: '2026-03-01', to: '2026-03-10', minHistoryBars: 50 });
    assert.ok(result.decisionsMade > 0);
    for (const d of result.decisions) {
      assert.ok(d.ts >= '2026-03-01' && d.ts <= '2026-03-10', `stamped ${d.ts}`);
    }
    db.close();
  });

  test('replay only considers events filed on or before the as-of date', () => {
    const { db } = seeded();
    db.run(
      `INSERT INTO events (symbol, filed_at, detected_at, headline, source_id,
                           source_tier, event_type, dedupe_key)
       VALUES ('TESTCO', '2026-04-20T05:30:00Z', '2026-04-20T05:31:00Z',
               'later results', 'manual_csv', 'PRIMARY_EXCHANGE', 'RESULTS', 'k1')`,
    );
    const before = runReplay(db, {
      from: '2026-03-01', to: '2026-03-05', minHistoryBars: 50, persist: false,
    });
    for (const d of before.decisions) {
      assert.equal(d.features.meta.eventId, null, 'a future event must be invisible');
    }
    db.close();
  });
});

// ── Trade simulation ────────────────────────────────────────────────────────

describe('trade simulation', () => {
  function bar(ts: string, high: number, low: number, close: number): Candle {
    return {
      symbol: 'X', timeframe: '1d', ts, open: close, high, low, close,
      volume: 1000, vwap: null, provenance: PROV,
    };
  }
  const plan = { entryPrice: 100, quantity: 100, stopLoss: 95, target: 110 };

  test('exits at the target when it is reached', () => {
    const t = simulateTrade([bar('2026-01-02', 112, 99, 111)], plan, 10)!;
    assert.equal(t.exitReason, 'TARGET');
    assert.equal(t.exitPrice, 110);
    assert.equal(t.result, 'WIN');
  });

  test('exits at the stop when it is hit', () => {
    const t = simulateTrade([bar('2026-01-02', 101, 94, 96)], plan, 10)!;
    assert.equal(t.exitReason, 'STOP');
    assert.equal(t.exitPrice, 95);
    assert.equal(t.result, 'LOSS');
  });

  // Daily bars do not record intrabar ordering. Assuming the favourable side is
  // exactly how a backtest invents an edge it does not have.
  test('assumes the stop first when one bar spans both stop and target', () => {
    const t = simulateTrade([bar('2026-01-02', 115, 90, 105)], plan, 10)!;
    assert.equal(t.exitReason, 'STOP', 'ambiguity must resolve against the strategy');
  });

  test('exits on time when neither level is reached', () => {
    const bars = [bar('2026-01-02', 102, 99, 101), bar('2026-01-05', 103, 100, 102)];
    const t = simulateTrade(bars, plan, 2)!;
    assert.equal(t.exitReason, 'TIME');
    assert.equal(t.exitPrice, 102);
    assert.equal(t.barsHeld, 2);
  });

  test('records maximum favourable and adverse excursion', () => {
    const bars = [bar('2026-01-02', 108, 97, 104), bar('2026-01-05', 109, 96, 103)];
    const t = simulateTrade(bars, plan, 5)!;
    assert.ok(Math.abs(t.mfePct - 9) < 0.001, `MFE ${t.mfePct}`);
    assert.ok(Math.abs(t.maePct - -4) < 0.001, `MAE ${t.maePct}`);
  });

  // Cost drag is the reason evaluation is on percentages net of cost.
  test('net P&L is below gross by the modelled cost', () => {
    const t = simulateTrade([bar('2026-01-02', 112, 99, 111)], plan, 10)!;
    assert.ok(t.costs > 0);
    assert.ok(t.netPnl < t.grossPnl);
    assert.ok(Math.abs(t.netPnl - (t.grossPnl - t.costs)) < 1e-9);
  });

  test('a marginal winner can be a net loser after costs', () => {
    const t = simulateTrade(
      [bar('2026-01-02', 100.1, 99.9, 100.05)],
      { entryPrice: 100, quantity: 100, stopLoss: 95, target: 200 },
      1,
    )!;
    assert.equal(t.exitReason, 'TIME');
    assert.ok(t.grossPnl > 0, 'gross is positive');
    assert.equal(t.result, 'LOSS', 'but costs turn it into a loss');
  });

  test('no bars yields no trade rather than a fabricated one', () => {
    assert.equal(simulateTrade([], plan, 10), null);
  });
});

// ── Labelling ───────────────────────────────────────────────────────────────

describe('outcome labelling', () => {
  test('labels every candidate at every horizon with forward data', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-02-28', minHistoryBars: 50 });
    const stats = labelCandidates(db);

    assert.ok(stats.labelled > 0);
    const rows = db.all<{ horizon: string; n: number }>(
      'SELECT horizon, COUNT(*) AS n FROM outcome_labels GROUP BY horizon',
    );
    assert.deepEqual(
      rows.map((r) => r.horizon).sort(),
      Object.keys(DEFAULT_HORIZONS).sort(),
    );
    db.close();
  });

  // Without this, "were the rejects actually bad?" is unanswerable.
  test('rejected candidates are labelled too, not just the buys', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-02-28', minHistoryBars: 50 });
    labelCandidates(db);

    const byAction = db.all<{ action: string; n: number }>(
      `SELECT c.action, COUNT(DISTINCT o.candidate_id) AS n
         FROM outcome_labels o JOIN candidates c ON c.id = o.candidate_id
        GROUP BY c.action`,
    );
    assert.ok(byAction.length > 0);
    assert.ok(
      byAction.some((r) => r.action === 'IGNORE' || r.action === 'WATCH'),
      'non-buy candidates must carry outcomes',
    );
    db.close();
  });

  test('candidates at the end of history are skipped, not labelled with zeros', () => {
    const { db, candles } = seeded();
    const f = buildFeatures({ symbol: 'TESTCO', candles });
    saveCandidate(db, decide(f, candles.at(-1)!.close));

    const stats = labelCandidates(db);
    assert.equal(stats.skippedNoForwardData, 1, 'the future has not happened yet');
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outcome_labels')!.n, 0);
    db.close();
  });

  test('labelling is idempotent', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-02-25', minHistoryBars: 50 });
    labelCandidates(db);
    const first = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outcome_labels')!.n;
    labelCandidates(db, { force: true });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outcome_labels')!.n, first);
    db.close();
  });

  test('records the weakest fidelity of the bars used', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-02-25', minHistoryBars: 50 });
    labelCandidates(db);
    const row = db.get<{ fidelity: string }>('SELECT fidelity FROM outcome_labels LIMIT 1');
    assert.equal(row!.fidelity, 'LOW', 'manual CSV bars are LOW fidelity');
    db.close();
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe('metrics', () => {
  test('Wilson interval widens as the sample shrinks', () => {
    const small = wilsonInterval(6, 10);
    const large = wilsonInterval(600, 1000);
    assert.ok(small.high - small.low > large.high - large.low);
    assert.ok(small.low < 0.6 && small.high > 0.6);
  });

  test('an empty sample yields the full interval, not a false certainty', () => {
    assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
  });

  test('max drawdown compounds rather than summing', () => {
    assert.equal(maxDrawdown([]), 0);
    assert.equal(maxDrawdown([10, 10]), 0, 'a rising series has no drawdown');
    const dd = maxDrawdown([10, -20, 5]);
    assert.ok(dd > 19 && dd < 21, `expected ~20%, got ${dd}`);
  });

  test('profit factor is gross profit over gross loss', () => {
    const m = tradeMetrics([
      { return_pct: 4, result: 'WIN', exit_reason: 'TARGET', time_to_target_min: 3, time_to_stop_min: null },
      { return_pct: 2, result: 'WIN', exit_reason: 'TARGET', time_to_target_min: 5, time_to_stop_min: null },
      { return_pct: -3, result: 'LOSS', exit_reason: 'STOP', time_to_target_min: null, time_to_stop_min: 2 },
    ]);
    assert.equal(m.profitFactor, 2);
    assert.ok(Math.abs(m.winRate - 2 / 3) < 1e-9);
    assert.equal(m.avgWinPct, 3);
    assert.equal(m.avgLossPct, -3);
    assert.equal(m.expectancyPct, 1);
  });

  test('a small sample is flagged underpowered', () => {
    const rows = Array.from({ length: 5 }, () => ({
      return_pct: 1, result: 'WIN', exit_reason: 'TARGET',
      time_to_target_min: 1, time_to_stop_min: null,
    }));
    assert.equal(tradeMetrics(rows).underpowered, true);
    assert.ok(UNDERPOWERED_BELOW >= 30);
  });

  test('exit reasons are broken down', () => {
    const m = tradeMetrics([
      { return_pct: 4, result: 'WIN', exit_reason: 'TARGET', time_to_target_min: 3, time_to_stop_min: null },
      { return_pct: -3, result: 'LOSS', exit_reason: 'STOP', time_to_target_min: null, time_to_stop_min: 2 },
      { return_pct: 0.2, result: 'WIN', exit_reason: 'TIME', time_to_target_min: null, time_to_stop_min: null },
    ]);
    assert.deepEqual(m.exitBreakdown, { TARGET: 1, STOP: 1, TIME: 1 });
  });
});

// ── The exit criterion, stated conservatively ───────────────────────────────

describe('separation verdict', () => {
  function bucket(action: string, n: number, avgReturnPct: number): BucketMetrics {
    return {
      action, candidates: n,
      byHorizon: [{
        horizon: '5d', n, avgReturnPct, medianReturnPct: avgReturnPct,
        avgReturnVsNiftyPct: null, positiveRate: 0.5,
        positiveRateInterval: { low: 0.3, high: 0.7 }, avgMfePct: 2, avgMaePct: -2,
      }],
      trades: null,
    };
  }

  test('refuses to conclude on a small sample even when the gap looks large', () => {
    const r = assessSeparation([bucket('PAPER_BUY', 5, 4), bucket('IGNORE', 5, -2)], '5d')!;
    assert.equal(r.verdict, 'INSUFFICIENT_DATA');
    assert.match(r.rationale, /At least 30/);
  });

  test('reports no separation when buys did not beat rejects', () => {
    const r = assessSeparation([bucket('PAPER_BUY', 50, 0.4), bucket('IGNORE', 50, 1.2)], '5d')!;
    assert.equal(r.verdict, 'NO_SEPARATION');
    assert.match(r.rationale, /not adding information/);
  });

  test('calls a sub-1-point gap weak rather than proven', () => {
    const r = assessSeparation([bucket('PAPER_BUY', 50, 1.2), bucket('IGNORE', 50, 0.7)], '5d')!;
    assert.equal(r.verdict, 'WEAK_SEPARATION');
    assert.match(r.rationale, /noise at this sample size/);
  });

  test('a material gap on adequate data is still not called proof', () => {
    const r = assessSeparation([bucket('PAPER_BUY', 60, 3.5), bucket('IGNORE', 60, 0.2)], '5d')!;
    assert.equal(r.verdict, 'SEPARATION_PRESENT');
    assert.match(r.rationale, /not yet proof/);
  });

  test('no PAPER_BUY candidates means insufficient data, not success', () => {
    const r = assessSeparation([bucket('IGNORE', 100, -1)], '5d')!;
    assert.equal(r.verdict, 'INSUFFICIENT_DATA');
  });
});

// ── Report assembly ─────────────────────────────────────────────────────────

describe('report', () => {
  test('builds end to end from replayed and labelled data', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-03-15', minHistoryBars: 50 });
    labelCandidates(db);

    const report = buildReport(db, '5d');
    assert.ok(report.totalCandidates > 0);
    assert.ok(report.buckets.length > 0);
    assert.ok(report.separation !== null);
    assert.ok(report.notes.some((n) => /edge/.test(n)), 'carries the honesty note');
    db.close();
  });

  test('warns when cohorts of differing fidelity are present', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-02-25', minHistoryBars: 50 });
    labelCandidates(db);
    db.run(`UPDATE outcome_labels SET fidelity = 'HIGH'
              WHERE candidate_id = (SELECT MIN(candidate_id) FROM outcome_labels)`);

    const report = buildReport(db, '5d');
    assert.ok(report.mixedFidelityWarning !== null);
    assert.match(report.mixedFidelityWarning!, /not directly comparable/);
    db.close();
  });

  test('renders self-contained HTML with no external requests', () => {
    const { db } = seeded();
    runReplay(db, { from: '2026-02-20', to: '2026-03-05', minHistoryBars: 50 });
    labelCandidates(db);

    const html = renderHtml(buildReport(db, '5d'));
    assert.match(html, /<!doctype html>/i);
    assert.ok(!/src="http/.test(html), 'no external scripts');
    assert.ok(!/href="http/.test(html), 'no external stylesheets');
    assert.match(html, /Exit criterion/);
    db.close();
  });
});

// ── Overfitting discipline ──────────────────────────────────────────────────

describe('walk-forward', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
    value: i,
  }));

  test('splits chronologically, never at random', () => {
    const split = chronologicalSplit(rows, { trainFraction: 0.6 });
    assert.equal(split.usable, true);
    assert.equal(split.train.length, 120);
    assert.equal(split.test.length, 80);
    assert.ok(
      split.train.at(-1)!.ts < split.test[0]!.ts,
      'every training row must precede every test row',
    );
  });

  test('sorts before splitting so caller ordering cannot corrupt the boundary', () => {
    const shuffled = [...rows].reverse();
    const split = chronologicalSplit(shuffled);
    assert.ok(split.train.at(-1)!.ts < split.test[0]!.ts);
  });

  test('marks a split unusable when either side is too thin', () => {
    const split = chronologicalSplit(rows.slice(0, 20));
    assert.equal(split.usable, false);
    assert.match(split.reason!, /at least 30/i);
  });

  test('expanding folds only ever train on the past', () => {
    const folds = expandingFolds(rows, { folds: 3, minTrain: 50, minTest: 20 });
    assert.ok(folds.length > 0);
    for (const fold of folds) {
      assert.ok(fold.train.at(-1)!.ts < fold.test[0]!.ts);
    }
    for (let i = 1; i < folds.length; i++) {
      assert.ok(folds[i]!.train.length > folds[i - 1]!.train.length, 'window expands');
    }
  });

  test('flags a poor observations-per-parameter ratio as severe', () => {
    assert.equal(assessOverfittingRisk(20, 100).severity, 'SEVERE');
    assert.equal(assessOverfittingRisk(3, 100).severity, 'MARGINAL');
    assert.equal(assessOverfittingRisk(1, 100).severity, 'OK');
    assert.match(assessOverfittingRisk(20, 100).message, /fitting noise/);
  });
});
