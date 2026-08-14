/**
 * State persistence for ephemeral runners.
 *
 * The property that matters: losing the snapshot must cost one duplicate
 * alert, never a corrupted record and never a skipped scan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { observeSignal, readSignal } from '../src/alerts/state.ts';
import { AlertEngine, type AlertChannel, type AlertMessage } from '../src/alerts/engine.ts';
import {
  exportState, importState, readSnapshot, writeSnapshot, SNAPSHOT_VERSION,
} from '../src/state/snapshot.ts';
import { DEFAULT_ALERTS } from '../src/config/index.ts';

function fresh(): Db {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  return db;
}

class RecordingChannel implements AlertChannel {
  readonly name = 'recording';
  readonly messages: AlertMessage[] = [];
  isConfigured(): boolean { return true; }
  async send(m: AlertMessage): Promise<void> { this.messages.push(m); }
}

describe('state snapshot', () => {
  const at = '2026-08-12T05:33:00.000Z';

  test('round-trips signal state', () => {
    const source = fresh();
    observeSignal(source, {
      symbol: 'TESTCO', action: 'PAPER_BUY', swing10Score: 91,
      eventQuality: 94, tradeQuality: 91, at,
    });
    const snapshot = exportState(source, { now: new Date(at) });
    source.close();

    const target = fresh();
    const result = importState(target, snapshot);
    assert.equal(result.signalsRestored, 1);
    assert.equal(result.warning, null);

    const restored = readSignal(target, 'TESTCO')!;
    assert.equal(restored.action, 'PAPER_BUY');
    assert.equal(restored.swing10Score, 91);
    target.close();
  });

  // The point of the whole mechanism.
  test('a restored snapshot prevents the same signal re-announcing', () => {
    const first = fresh();
    observeSignal(first, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    const snapshot = exportState(first, { now: new Date(at) });
    first.close();

    // A fresh runner, as GitHub Actions would give us.
    const second = fresh();
    importState(second, snapshot);
    const transition = observeSignal(second, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    assert.equal(transition, null, 'the state is already known, so this is not news');
    second.close();
  });

  // And the honest cost of losing it.
  test('without the snapshot the signal is re-announced once', () => {
    const runner = fresh();
    const transition = observeSignal(runner, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    assert.ok(transition !== null, 'state loss costs exactly one duplicate alert');
    assert.equal(transition!.from, null);
    runner.close();
  });

  test('recent sent alerts carry the cooldown across runs', async () => {
    const first = fresh();
    const channel = new RecordingChannel();
    const config = { ...DEFAULT_ALERTS, enabled: true, minIntervalMs: 15 * 60_000 };
    const engine = new AlertEngine({
      db: first, config, channels: [channel], now: () => new Date(at),
    });
    await engine.consider({
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'qualifies',
    });
    const snapshot = exportState(first, { now: new Date(at) });
    first.close();

    const second = fresh();
    importState(second, snapshot);
    const secondChannel = new RecordingChannel();
    const secondEngine = new AlertEngine({
      db: second, config, channels: [secondChannel],
      now: () => new Date(Date.parse(at) + 5 * 60_000),
    });
    const decision = await secondEngine.consider({
      symbol: 'TESTCO', kind: 'IGNORE>PAPER_BUY', from: 'IGNORE', to: 'PAPER_BUY',
      notable: true, reason: 'qualifies again',
    });

    assert.equal(decision.sent, false);
    assert.match(decision.suppressedReason!, /cooldown/);
    assert.equal(secondChannel.messages.length, 0);
    second.close();
  });

  test('alerts older than the window are not carried', () => {
    const db = fresh();
    db.run(
      `INSERT INTO alert_log (ts, symbol, transition, channel, sent)
       VALUES ('2026-08-01T00:00:00.000Z', 'OLD', 'X>Y', 'test', 1)`,
    );
    db.run(
      `INSERT INTO alert_log (ts, symbol, transition, channel, sent)
       VALUES (?, 'NEW', 'X>Y', 'test', 1)`, at,
    );
    const snapshot = exportState(db, { now: new Date(at), alertWindowHours: 24 });
    assert.deepEqual(snapshot.recentAlerts.map((a) => a.symbol), ['NEW']);
    db.close();
  });

  test('only alert state travels, never prices or scores history', () => {
    const db = fresh();
    observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    const snapshot = exportState(db, { now: new Date(at) });
    assert.deepEqual(
      Object.keys(snapshot).sort(),
      ['exportedAt', 'processedEventKeys', 'recentAlerts', 'signals', 'version'],
    );
    db.close();
  });

  // A bad snapshot must never stop the scan.
  test('a malformed snapshot is a warning, not a failure', () => {
    const db = fresh();
    for (const bad of [null, 'not an object', 42, []]) {
      const result = importState(db, bad);
      assert.equal(result.signalsRestored, 0);
      assert.ok(result.warning !== null, `expected a warning for ${JSON.stringify(bad)}`);
    }
    db.close();
  });

  test('a version mismatch is ignored rather than misread', () => {
    const db = fresh();
    const result = importState(db, {
      version: SNAPSHOT_VERSION + 99, exportedAt: at,
      signals: [{ symbol: 'X', action: 'PAPER_BUY' }], recentAlerts: [], processedEventKeys: [],
    });
    assert.equal(result.signalsRestored, 0);
    assert.match(result.warning!, /does not match/);
    assert.equal(readSignal(db, 'X'), undefined);
    db.close();
  });

  test('malformed individual entries are skipped, not fatal', () => {
    const db = fresh();
    const result = importState(db, {
      version: SNAPSHOT_VERSION, exportedAt: at, processedEventKeys: [],
      signals: [
        { symbol: 'GOOD', action: 'WATCH', updatedAt: at, firstSeenAt: at },
        { symbol: '', action: 'WATCH' },
        { action: 'WATCH' },
        null,
      ],
      recentAlerts: [{ transition: 'X>Y', ts: at, symbol: 'GOOD' }, { ts: at }, null],
    });
    assert.equal(result.signalsRestored, 1);
    assert.equal(result.alertsRestored, 1);
    assert.equal(readSignal(db, 'GOOD')?.action, 'WATCH');
    db.close();
  });

  test('writes and reads a snapshot file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swing10-state-'));
    try {
      const db = fresh();
      observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
      const path = join(dir, 'nested', 'state.json');
      writeSnapshot(path, exportState(db, { now: new Date(at) }));

      const read = readSnapshot(path) as { signals: { symbol: string }[] };
      assert.equal(read.signals[0]!.symbol, 'TESTCO');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing or corrupt file reads as null rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swing10-state-'));
    try {
      assert.equal(readSnapshot(join(dir, 'absent.json')), null);
      const corrupt = join(dir, 'corrupt.json');
      writeFileSync(corrupt, '{ not json');
      assert.equal(readSnapshot(corrupt), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
