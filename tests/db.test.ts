import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/driver.ts';
import { currentVersion, migrate } from '../src/db/migrate.ts';
import { SourceRegistry } from '../src/sources/registry.ts';
import { resolveCapabilities } from '../src/sources/capabilities.ts';
import { SOURCES_CONFIG } from '../src/paths.ts';

function fresh() {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  return db;
}

describe('migrations', () => {
  test('apply from empty and are idempotent', () => {
    const db = openDb({ path: ':memory:' });
    const first = migrate(db);
    assert.ok(first.applied.length > 0);
    assert.equal(first.alreadyAtVersion, 0);

    const second = migrate(db);
    assert.equal(second.applied.length, 0, 'already-applied migrations do not re-run');
    assert.equal(currentVersion(db), first.applied.at(-1)!.version);
    db.close();
  });

  test('create the full table inventory', () => {
    const db = fresh();
    const names = new Set(
      db
        .all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .map((r) => r.name),
    );
    for (const expected of [
      'data_sources', 'source_requests', 'instruments', 'candles', 'market_context',
      'events', 'fundamentals_quarterly', 'price_reactions', 'reaction_profiles',
      'priced_in_assessments', 'candidates', 'candidate_features',
      'score_contributions', 'trade_plans', 'paper_trades', 'outcome_labels',
    ]) {
      assert.ok(names.has(expected), `missing table: ${expected}`);
    }
    db.close();
  });
});

describe('schema constraints', () => {
  test('candidates.action is restricted to the four states', () => {
    const db = fresh();
    for (const action of ['PAPER_BUY', 'WATCH', 'IGNORE', 'NO_TRADE']) {
      db.run('INSERT INTO candidates (ts, symbol, action) VALUES (?, ?, ?)',
        '2026-08-13T10:00:00Z', 'TEST', action);
    }
    assert.throws(() =>
      db.run('INSERT INTO candidates (ts, symbol, action) VALUES (?, ?, ?)',
        '2026-08-13T10:00:00Z', 'TEST', 'BUY'),
    );
    db.close();
  });

  test('rejected candidates are storable with their reason', () => {
    const db = fresh();
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO candidates (ts, symbol, action, event_quality, trade_quality,
         gates_passed, veto_gate, gate_results_json)
       VALUES (?, ?, 'IGNORE', 88, 41, 0, 'PRICED_IN_EXTREME', ?)`,
      '2026-08-13T11:03:00Z', 'TEST',
      JSON.stringify([{ id: 'PRICED_IN_EXTREME', passed: false }]),
    );
    const row = db.get<{ action: string; veto_gate: string }>(
      'SELECT action, veto_gate FROM candidates WHERE id = ?', id);
    assert.equal(row?.action, 'IGNORE');
    assert.equal(row?.veto_gate, 'PRICED_IN_EXTREME');
    db.close();
  });

  test('explanations are queryable per feature, not just per candidate', () => {
    const db = fresh();
    const { lastInsertRowid: id } = db.run(
      `INSERT INTO candidates (ts, symbol, action) VALUES (?, 'TEST', 'IGNORE')`,
      '2026-08-13T11:03:00Z');
    db.run(
      `INSERT INTO score_contributions
         (candidate_id, dimension, bucket, feature, raw_value, comparator,
          threshold, points, points_max, direction, rationale, source_ref, confidence)
       VALUES (?, 'PRICED_IN', 'pricedIn', 'priced_in_ratio', '1.33', '>', '1.20',
               -28, 0, 'DEDUCT', 'Move exceeds expected for this event class',
               'pricedin/engine', 0.6)`,
      id);
    const rows = db.all<{ points: number; direction: string }>(
      `SELECT points, direction FROM score_contributions
        WHERE feature = 'priced_in_ratio' AND direction = 'DEDUCT'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.points, -28);
    db.close();
  });

  test('foreign keys are enforced', () => {
    const db = fresh();
    assert.throws(() =>
      db.run(
        `INSERT INTO candidate_features (candidate_id, features_json, schema_version)
         VALUES (99999, '{}', 1)`,
      ),
    );
    db.close();
  });

  test('transactions roll back on throw', () => {
    const db = fresh();
    assert.throws(() =>
      db.transaction(() => {
        db.run(`INSERT INTO candidates (ts, symbol, action) VALUES ('t', 'A', 'WATCH')`);
        throw new Error('boom');
      }),
    );
    const row = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM candidates');
    assert.equal(row?.n, 0);
    db.close();
  });
});

describe('source registry', () => {
  test('the shipped config is valid and TOS_GREY sources are off by default', () => {
    const registry = SourceRegistry.fromFile(SOURCES_CONFIG);
    assert.ok(registry.all().length > 0);
    for (const { policy, enabled } of registry.all()) {
      if (policy.legalBasis === 'TOS_GREY') {
        assert.equal(enabled, false, `${policy.id} must not be enabled without opt-in`);
      }
    }
  });

  test('opt-in enables a TOS_GREY source', () => {
    const config = {
      optIn: ['grey_one'],
      sources: [
        { id: 'grey_one', tier: 0 as const, latencyClass: 'PERIODIC' as const,
          legalBasis: 'TOS_GREY' as const },
        { id: 'grey_two', tier: 0 as const, latencyClass: 'PERIODIC' as const,
          legalBasis: 'TOS_GREY' as const },
      ],
    };
    const registry = SourceRegistry.fromConfig(config);
    assert.equal(registry.get('grey_one')?.enabled, true);
    assert.equal(registry.get('grey_two')?.enabled, false);
    assert.match(registry.get('grey_two')!.disabledReason!, /explicit opt-in/);
  });

  test('persists the register into data_sources', () => {
    const db = fresh();
    SourceRegistry.fromFile(SOURCES_CONFIG).persist(db);
    const rows = db.all<{ id: string; enabled: number }>('SELECT id, enabled FROM data_sources');
    assert.ok(rows.length > 0);

    // Idempotent: a second persist updates rather than duplicating.
    SourceRegistry.fromFile(SOURCES_CONFIG).persist(db);
    const after = db.all<{ id: string }>('SELECT id FROM data_sources');
    assert.equal(after.length, rows.length);
    db.close();
  });
});

describe('capabilities', () => {
  test('no broker resolves to Tier 0 EOD_PROXY with t0 only', () => {
    const caps = resolveCapabilities(SourceRegistry.fromFile(SOURCES_CONFIG));
    assert.equal(caps.tier, 0);
    assert.equal(caps.reactionMode, 'EOD_PROXY');
    assert.equal(caps.intradayReaction, 'LOW');
    assert.equal(caps.liveScanning, false);
    assert.deepEqual(caps.availableHorizons, ['t0']);
    assert.ok(caps.degradations.length > 0, 'degradation must be stated, not silent');
  });

  test('a broker source unlocks Tier 1 and all horizons', () => {
    const registry = SourceRegistry.fromConfig({
      sources: [
        { id: 'broker_ws', tier: 1, latencyClass: 'REALTIME',
          legalBasis: 'BROKER_LICENSED', enabledByDefault: true,
          poll: { intervalMs: 1_000, minIntervalMsFloor: 1_000 } },
      ],
    });
    const caps = resolveCapabilities(registry);
    assert.equal(caps.tier, 1);
    assert.equal(caps.reactionMode, 'LIVE');
    assert.equal(caps.intradayReaction, 'HIGH');
    assert.equal(caps.liveScanning, true);
    assert.equal(caps.availableHorizons.length, 8);
  });

  test('delayed-only intraday is Tier 2 replay, never live', () => {
    const registry = SourceRegistry.fromConfig({
      optIn: ['yahoo_intraday'],
      sources: [
        { id: 'yahoo_intraday', tier: 2, latencyClass: 'DELAYED', legalBasis: 'TOS_GREY',
          poll: { intervalMs: 900_000, minIntervalMsFloor: 300_000 } },
      ],
    });
    const caps = resolveCapabilities(registry);
    assert.equal(caps.tier, 2);
    assert.equal(caps.reactionMode, 'REPLAY');
    assert.equal(caps.liveScanning, false);
    assert.match(caps.degradations.join(' '), /must not be pooled/);
  });
});
