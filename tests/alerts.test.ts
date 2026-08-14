/**
 * Signal transitions, alert deduplication, and the two execution modes.
 *
 * The behaviours that matter most here are the negative ones: a scanner that
 * re-alerts every cycle gets muted, and a muted scanner is worthless.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, type Db } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestCandles } from '../src/ingest/candles.ts';
import { loadUniverse, DEFAULT_LIQUIDITY } from '../src/ingest/universe.ts';
import {
  observeSignal, readSignal, invalidateMissing, signalsInState,
} from '../src/alerts/state.ts';
import { AlertEngine, formatTransition, type AlertChannel, type AlertMessage } from '../src/alerts/engine.ts';
import { TelegramChannel, redactTelegram, TOKEN_ENV, CHAT_ENV } from '../src/alerts/telegram.ts';
import { scanOnce, startScanner, ScanBus } from '../src/jobs/scanner.ts';
import { runScanCycle } from '../src/jobs/scan-cycle.ts';
import { acquireLock } from '../src/scan/lock.ts';
import { loadConfig, DEFAULT_ALERTS } from '../src/config/index.ts';
import type { Candle, Provenance } from '../src/market/types.ts';
import type { ScanCandidate } from '../src/scan/types.ts';

const PROV: Provenance = { sourceId: 'manual_csv', latencyClass: 'PERIODIC', fidelity: 'LOW' };

function ist(date: string, hh: number, mm: number): Date {
  return new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
}

function series(symbol: string, n = 80): Candle[] {
  const out: Candle[] = [];
  let price = 500;
  for (let i = 0; i < n; i++) {
    price = Math.max(50, price + Math.sin(i / 6) * 3 + 0.4);
    out.push({
      symbol, timeframe: '1d',
      ts: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      open: price - 1, high: price + 4, low: price - 4, close: price,
      volume: 500_000, vwap: null, provenance: PROV,
    });
  }
  return out;
}

function seeded(): Db {
  const db = openDb({ path: ':memory:' });
  migrate(db);
  const stock = series('TESTCO');
  const bench = series('NIFTY_50').map((c) => ({ ...c, symbol: 'NIFTY_50' }));
  ingestCandles(db, [...stock, ...bench]);
  loadUniverse(db, {
    instruments: [{ symbol: 'TESTCO' }, { symbol: 'NIFTY_50' }],
    candlesBySymbol: new Map([['TESTCO', stock], ['NIFTY_50', bench]]),
    config: { ...DEFAULT_LIQUIDITY, minAvgTurnover20d: 1_000_000 },
  });
  return db;
}

/** Records every message instead of sending it. */
class RecordingChannel implements AlertChannel {
  readonly name = 'recording';
  readonly messages: AlertMessage[] = [];
  #configured: boolean;
  constructor(configured = true) { this.#configured = configured; }
  isConfigured(): boolean { return this.#configured; }
  async send(message: AlertMessage): Promise<void> { this.messages.push(message); }
}

// ── Signal state transitions (§30) ──────────────────────────────────────────

describe('signal state', () => {
  const at = '2026-08-12T05:33:00.000Z';

  test('first observation is a transition from nothing', () => {
    const db = seeded();
    const t = observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    assert.equal(t?.from, null);
    assert.equal(t?.to, 'WATCH');
    assert.equal(readSignal(db, 'TESTCO')?.action, 'WATCH');
    db.close();
  });

  // The core deduplication property.
  test('an unchanged state produces no transition', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    const second = observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at: '2026-08-12T05:38:00.000Z' });
    assert.equal(second, null, 'seeing the same state again is not news');
    db.close();
  });

  test('WATCH to PAPER_BUY is notable', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    const t = observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    assert.equal(t?.notable, true);
    assert.equal(t?.kind, 'WATCH>PAPER_BUY');
    db.close();
  });

  test('IGNORE to WATCH is a transition but not notable', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'IGNORE', at });
    const t = observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    assert.equal(t !== null, true);
    assert.equal(t?.notable, false, 'drift between IGNORE and WATCH is noise');
    db.close();
  });

  test('losing a PAPER_BUY is notable', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    assert.equal(observeSignal(db, { symbol: 'TESTCO', action: 'IGNORE', at })?.notable, true);
    db.close();
  });

  test('invalidation records its reason and timestamp', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    observeSignal(db, {
      symbol: 'TESTCO', action: 'INVALIDATED', at, reason: 'breakout failed',
    });
    const stored = readSignal(db, 'TESTCO')!;
    assert.equal(stored.action, 'INVALIDATED');
    assert.equal(stored.invalidationReason, 'breakout failed');
    assert.ok(stored.invalidatedAt !== null);
    db.close();
  });

  test('first-seen time is preserved across updates', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at: '2026-08-12T06:00:00.000Z' });
    const stored = readSignal(db, 'TESTCO')!;
    assert.equal(stored.firstSeenAt, at);
    assert.equal(stored.updatedAt, '2026-08-12T06:00:00.000Z');
    db.close();
  });

  test('a re-examined PAPER_BUY that no longer qualifies is invalidated', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    const transitions = invalidateMissing(db, [], ['TESTCO'], at);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0]!.to, 'INVALIDATED');
    db.close();
  });

  // Absence from a screened-out symbol is not evidence the setup failed.
  test('a symbol that was never examined is not invalidated', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'PAPER_BUY', at });
    assert.equal(invalidateMissing(db, [], [], at).length, 0);
    assert.equal(readSignal(db, 'TESTCO')?.action, 'PAPER_BUY');
    db.close();
  });

  test('a dropped WATCH is not invalidated', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'TESTCO', action: 'WATCH', at });
    assert.equal(invalidateMissing(db, [], ['TESTCO'], at).length, 0);
    db.close();
  });

  test('signals can be listed by state', () => {
    const db = seeded();
    observeSignal(db, { symbol: 'AAA', action: 'PAPER_BUY', at });
    observeSignal(db, { symbol: 'BBB', action: 'WATCH', at });
    assert.equal(signalsInState(db, 'PAPER_BUY').length, 1);
    assert.equal(signalsInState(db, 'WATCH').length, 1);
    db.close();
  });
});

// ── Alert deduplication (§30) ───────────────────────────────────────────────

describe('alert engine', () => {
  const enabled = { ...DEFAULT_ALERTS, enabled: true, minIntervalMs: 15 * 60_000 };
  const at = new Date('2026-08-12T05:33:00.000Z');

  function engineWith(db: Db, channel: RecordingChannel, now = at, config = enabled): AlertEngine {
    return new AlertEngine({ db, config, channels: [channel], now: () => now });
  }

  test('sends on a notable transition', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const decision = await engineWith(db, channel).consider({
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'now qualifies',
    });
    assert.equal(decision.sent, true);
    assert.equal(channel.messages.length, 1);
    db.close();
  });

  test('suppresses a non-notable transition', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const decision = await engineWith(db, channel).consider({
      symbol: 'TESTCO', kind: 'IGNORE>WATCH', from: 'IGNORE', to: 'WATCH',
      notable: false, reason: 'drifted',
    });
    assert.equal(decision.sent, false);
    assert.match(decision.suppressedReason!, /not notable/);
    assert.equal(channel.messages.length, 0);
    db.close();
  });

  // The 5-minute-workflow problem.
  test('a repeated alert for the same symbol is suppressed by cooldown', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const transition = {
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY' as const, from: 'WATCH' as const,
      to: 'PAPER_BUY' as const, notable: true, reason: 'qualifies',
    };

    assert.equal((await engineWith(db, channel, at).consider(transition)).sent, true);

    const fiveMinutesLater = new Date(at.getTime() + 5 * 60_000);
    const second = await engineWith(db, channel, fiveMinutesLater).consider(transition);
    assert.equal(second.sent, false);
    assert.match(second.suppressedReason!, /cooldown/);
    assert.equal(channel.messages.length, 1);
    db.close();
  });

  test('the cooldown expires', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const transition = {
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY' as const, from: 'WATCH' as const,
      to: 'PAPER_BUY' as const, notable: true, reason: 'qualifies',
    };
    await engineWith(db, channel, at).consider(transition);
    const later = new Date(at.getTime() + 20 * 60_000);
    assert.equal((await engineWith(db, channel, later).consider(transition)).sent, true);
    db.close();
  });

  test('nothing is sent when alerts are disabled', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const engine = engineWith(db, channel, at, { ...enabled, enabled: false });
    const decision = await engine.consider({
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'qualifies',
    });
    assert.equal(decision.sent, false);
    assert.match(decision.suppressedReason!, /disabled/);
    db.close();
  });

  test('an unconfigured channel suppresses rather than failing', async () => {
    const db = seeded();
    const channel = new RecordingChannel(false);
    const decision = await engineWith(db, channel).consider({
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'qualifies',
    });
    assert.equal(decision.sent, false);
    assert.match(decision.suppressedReason!, /no alert channel/);
    db.close();
  });

  // "Why didn't I get an alert?" must always be answerable.
  test('every decision is logged, sent or suppressed', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const engine = engineWith(db, channel);
    await engine.consider({
      symbol: 'AAA', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'ok',
    });
    await engine.consider({
      symbol: 'BBB', kind: 'IGNORE>WATCH', from: 'IGNORE', to: 'WATCH',
      notable: false, reason: 'noise',
    });
    const rows = db.all<{ sent: number; suppressed_reason: string | null }>(
      'SELECT sent, suppressed_reason FROM alert_log',
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.sent === 1));
    assert.ok(rows.some((r) => r.sent === 0 && r.suppressed_reason !== null));
    db.close();
  });

  test('a channel failure is recorded rather than thrown', async () => {
    const db = seeded();
    const failing: AlertChannel = {
      name: 'failing', isConfigured: () => true,
      send: async () => { throw new Error('network down'); },
    };
    const engine = new AlertEngine({ db, config: enabled, channels: [failing], now: () => at });
    const decision = await engine.consider({
      symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
      notable: true, reason: 'qualifies',
    });
    assert.equal(decision.sent, false);
    assert.match(decision.error!, /network down/);
    db.close();
  });
});

// ── Message formatting ──────────────────────────────────────────────────────

describe('alert formatting', () => {
  const candidate = {
    symbol: 'TESTCO', companyName: 'Test Company Limited',
    event: { id: 1, type: 'RESULTS', headline: 'Q1 results', filedAt: null, detectedAt: null,
             ageMinutes: 3, materiality: 0.9, sourceTier: 'PRIMARY_EXCHANGE' as const },
    eventQualityScore: 94, tradeQualityScore: 91, swing10Score: 92,
    currentPrice: 1000, priceChangePct: 1.8, priceSinceEventPct: 1.8,
    volumeRatio: 4.1, vwapState: 'ABOVE' as const,
    entry: 1000, target: 1040, stopLoss: 980, riskReward: 2, quantity: 10,
    extensionRisk: 'LOW' as const, warnings: [],
  } as unknown as ScanCandidate;

  test('a PAPER_BUY message carries the full trade plan', () => {
    const message = formatTransition(
      { symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
        notable: true, reason: 'qualifies' },
      candidate,
    );
    assert.match(message.title, /PAPER BUY/);
    assert.match(message.body, /Event Quality: 94/);
    assert.match(message.body, /Entry:  ₹1000\.00/);
    assert.match(message.body, /R:R:    2\.00/);
  });

  // The disclaimer is not optional.
  test('every PAPER_BUY message states it is unvalidated paper trading', () => {
    const message = formatTransition(
      { symbol: 'TESTCO', kind: 'WATCH>PAPER_BUY', from: 'WATCH', to: 'PAPER_BUY',
        notable: true, reason: 'qualifies' },
      candidate,
    );
    assert.match(message.body, /PAPER TRADING ONLY/);
    assert.match(message.body, /STRATEGY NOT VALIDATED/);
  });

  test('invalidation and system messages render distinctly', () => {
    const invalid = formatTransition({
      symbol: 'TESTCO', kind: 'PAPER_BUY>INVALIDATED', from: 'PAPER_BUY',
      to: 'INVALIDATED', notable: true, reason: 'breakout failed',
    });
    assert.match(invalid.title, /INVALIDATED/);

    const risk = formatTransition({
      symbol: '', kind: 'MARKET_HIGH_RISK', from: null, to: 'NO_TRADE',
      notable: true, reason: 'VIX spiked',
    });
    assert.match(risk.title, /MARKET HIGH RISK/);
    assert.equal(risk.symbol, null);
  });
});

// ── Telegram (§37) ──────────────────────────────────────────────────────────

describe('telegram channel', () => {
  test('is unconfigured without credentials', () => {
    assert.equal(new TelegramChannel({ token: undefined, chatId: undefined }).isConfigured(), false);
    assert.equal(new TelegramChannel({ token: 'x', chatId: undefined }).isConfigured(), false);
    assert.equal(new TelegramChannel({ token: 'x', chatId: 'y' }).isConfigured(), true);
  });

  test('reads credentials from the environment', () => {
    const saved = { t: process.env[TOKEN_ENV], c: process.env[CHAT_ENV] };
    process.env[TOKEN_ENV] = '123456:abcdefghijklmnopqrstuvwxyz012345';
    process.env[CHAT_ENV] = '999';
    try {
      assert.equal(new TelegramChannel().isConfigured(), true);
    } finally {
      if (saved.t === undefined) delete process.env[TOKEN_ENV]; else process.env[TOKEN_ENV] = saved.t;
      if (saved.c === undefined) delete process.env[CHAT_ENV]; else process.env[CHAT_ENV] = saved.c;
    }
  });

  test('sends a formatted message', async () => {
    const calls: { url: string; body: string }[] = [];
    const channel = new TelegramChannel({
      token: 'tok', chatId: '42',
      fetcher: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response('{"ok":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await channel.send({ title: 'T', body: 'B', symbol: 'X', transition: 'k' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.body, /"chat_id":"42"/);
    assert.match(calls[0]!.body, /T\\n\\nB/);
  });

  // A token must never reach a log, even through an error body.
  test('an error response cannot leak the token', async () => {
    const token = '123456:secretsecretsecretsecret';
    const channel = new TelegramChannel({
      token, chatId: '42',
      fetcher: (async () =>
        new Response(`bad token ${token}`, { status: 401 })) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => channel.send({ title: 'T', body: 'B', symbol: null, transition: 'k' }),
      (err: Error) => !err.message.includes(token) && /401/.test(err.message),
    );
  });

  test('redaction strips bot-token shapes', () => {
    const token = '123456789:AAEwZ0abcdefghijklmnopqrstuvwxyz123';
    assert.ok(!redactTelegram(`failed with ${token}`, token).includes(token));
    assert.ok(!redactTelegram(`url https://api.telegram.org/bot${token}/x`).includes(token));
  });
});

// ── Execution modes (§41) ───────────────────────────────────────────────────

describe('scan:once', () => {
  const config = loadConfig();

  test('runs exactly one cycle during market hours', async () => {
    const db = seeded();
    const outcome = await scanOnce(
      { db, config, now: () => ist('2026-08-12', 11, 0) },
      { symbols: ['TESTCO'] },
    );
    assert.ok(outcome.result !== null);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scan_runs')!.n, 1);
    db.close();
  });

  // The market-hours guard lives in the application, not in cron.
  test('skips on a weekend without running a scan', async () => {
    const db = seeded();
    const outcome = await scanOnce({ db, config, now: () => ist('2026-08-16', 11, 0) });
    assert.equal(outcome.result, null);
    assert.match(outcome.skippedReason!, /WEEKEND/);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scan_runs')!.n, 0);
    db.close();
  });

  test('skips outside session hours on a weekday', async () => {
    const db = seeded();
    const outcome = await scanOnce({ db, config, now: () => ist('2026-08-12', 20, 0) });
    assert.equal(outcome.result, null);
    assert.match(outcome.skippedReason!, /CLOSED/);
    db.close();
  });

  test('force overrides the market-hours guard', async () => {
    const db = seeded();
    const outcome = await scanOnce(
      { db, config, now: () => ist('2026-08-16', 11, 0) },
      { force: true, symbols: ['TESTCO'] },
    );
    assert.ok(outcome.result !== null, 'a manual trigger can scan a closed market');
    db.close();
  });

  test('refuses to overlap another running scan', async () => {
    const db = seeded();
    acquireLock(db, 'other-process');
    const outcome = await scanOnce(
      { db, config, now: () => ist('2026-08-12', 11, 0) },
      { symbols: ['TESTCO'] },
    );
    assert.equal(outcome.result, null);
    assert.match(outcome.skippedReason!, /already running/);
    db.close();
  });

  test('records transitions and considers alerts in one cycle', async () => {
    const db = seeded();
    const channel = new RecordingChannel();
    const outcome = await runScanCycle(
      {
        db,
        config: { ...config, alerts: { ...config.alerts, enabled: true } },
        channels: [channel],
        now: () => ist('2026-08-12', 11, 0),
      },
      { mode: 'ONCE', trigger: 'MANUAL', symbols: ['TESTCO'] },
    );
    assert.ok(outcome.result !== null);
    assert.ok(outcome.transitions.length > 0, 'a first observation is a transition');
    assert.ok(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM signal_state')!.n > 0);
    db.close();
  });

  // Running twice in a row must not re-alert.
  test('a second identical cycle produces no new transitions', async () => {
    const db = seeded();
    const deps = { db, config, now: () => ist('2026-08-12', 11, 0) };
    await runScanCycle(deps, { mode: 'ONCE', trigger: 'SCHEDULE', symbols: ['TESTCO'] });
    const second = await runScanCycle(deps, { mode: 'ONCE', trigger: 'SCHEDULE', symbols: ['TESTCO'] });
    assert.equal(second.transitions.length, 0, 'steady state is not news');
    db.close();
  });
});

describe('local scanner loop', () => {
  const config = loadConfig();

  test('runs cycles during market hours and stops on request', async () => {
    const db = seeded();
    const lines: string[] = [];
    const handle = startScanner(
      { db, config, now: () => ist('2026-08-12', 11, 0) },
      config,
      { intervalMs: 30_000, maxCycles: 2, log: (l) => lines.push(l) },
    );
    await handle.done;
    assert.equal(handle.cycles(), 2);
    assert.ok(lines.some((l) => /screened/.test(l)));
    db.close();
  });

  test('does not scan outside the window but keeps the loop alive', async () => {
    const db = seeded();
    const lines: string[] = [];
    const handle = startScanner(
      { db, config, now: () => ist('2026-08-16', 11, 0) },
      config,
      { intervalMs: 30_000, maxCycles: 1, log: (l) => lines.push(l) },
    );
    // The loop only counts scan cycles, so stop it explicitly.
    handle.stop();
    await handle.done;
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scan_runs')!.n, 0);
    assert.ok(lines.some((l) => /WEEKEND/.test(l)));
    db.close();
  });

  test('the interval cannot be set below the configured floor', async () => {
    const db = seeded();
    const lines: string[] = [];
    const handle = startScanner(
      { db, config, now: () => ist('2026-08-16', 11, 0) },
      config,
      { intervalMs: 1, maxCycles: 1, log: (l) => lines.push(l) },
    );
    handle.stop();
    await handle.done;
    assert.match(lines[0]!, new RegExp(`interval ${Math.round(config.scan.minIntervalMs / 1000)}s`));
    db.close();
  });
});

describe('scan bus', () => {
  test('fans envelopes out and unsubscribes cleanly', () => {
    const bus = new ScanBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.name));
    bus.emit({ name: 'scan:started', ts: 'now', payload: {} });
    off();
    bus.emit({ name: 'scan:completed', ts: 'now', payload: {} });
    assert.deepEqual(seen, ['scan:started']);
    assert.equal(bus.size, 0);
  });

  test('a broken subscriber cannot break the scan', () => {
    const bus = new ScanBus();
    bus.subscribe(() => { throw new Error('subscriber exploded'); });
    let reached = false;
    bus.subscribe(() => { reached = true; });
    assert.doesNotThrow(() => bus.emit({ name: 'scan:started', ts: 'now', payload: {} }));
    assert.equal(reached, true);
  });
});
