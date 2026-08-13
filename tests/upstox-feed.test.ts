/**
 * Feed client behaviour: normalisation, sequencing, reconnect, auth failure,
 * heartbeat, market-closed handling and token redaction.
 *
 * No network. The socket and the clock are injected, so every timing-dependent
 * behaviour is asserted deterministically.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  UpstoxFeedClient, type FeedSocket, type SocketHandlers,
} from '../src/adapters/tier1/upstox/feed-client.ts';
import { UpstoxCredentials, redact, redactUrl, TOKEN_ENV, CredentialError } from '../src/adapters/tier1/upstox/credentials.ts';
import { FEED_TYPE } from '../src/adapters/tier1/upstox/proto/feed.ts';
import { TickSequencer, type RejectedTick, type Tick } from '../src/market/tick.ts';
import { FakeClock } from '../src/sources/clock.ts';
import * as pb from './helpers/proto-encode.ts';

/** Flushes detached async work: WebSocket handlers are synchronous, so the
 *  reconnect chain they kick off settles on later ticks of the event loop. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.supersecrettokenvalue.signature123';
const KEY_RELIANCE = 'NSE_EQ|INE002A01018';
const KEY_NIFTY = 'NSE_INDEX|Nifty 50';

function credentials(token = TOKEN): UpstoxCredentials {
  return UpstoxCredentials.fromEnv({ [TOKEN_ENV]: token } as NodeJS.ProcessEnv);
}

/** Controllable fake socket. */
class FakeSocket implements FakeSocketApi {
  handlers: SocketHandlers;
  sent: (Uint8Array | string)[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;
  }
  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}
interface FakeSocketApi extends FeedSocket {
  handlers: SocketHandlers;
  sent: (Uint8Array | string)[];
  closed: { code?: number; reason?: string } | null;
}

interface Harness {
  client: UpstoxFeedClient;
  sockets: FakeSocket[];
  clock: FakeClock;
  ticks: Tick[];
  rejected: RejectedTick[];
  logs: string[];
  authCalls: number;
  latest(): FakeSocket;
}

function harness(opts: {
  authorize?: (n: number) => Promise<string>;
  heartbeatTimeoutMs?: number;
  maxAuthFailures?: number;
  maxAttempts?: number;
  instrumentMap?: Map<string, string>;
} = {}): Harness {
  const clock = new FakeClock(1_755_000_000_000, 0.5);
  const sockets: FakeSocket[] = [];
  const ticks: Tick[] = [];
  const rejected: RejectedTick[] = [];
  const logs: string[] = [];
  const state = { authCalls: 0 };

  const client = new UpstoxFeedClient({
    credentials: credentials(),
    clock,
    authorize: async () => {
      state.authCalls++;
      if (opts.authorize) return opts.authorize(state.authCalls);
      return `wss://feed.example.invalid/v3?token=${TOKEN}`;
    },
    socketFactory: (_url, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
    instrumentMap:
      opts.instrumentMap ??
      new Map([[KEY_RELIANCE, 'RELIANCE'], [KEY_NIFTY, 'NIFTY_50']]),
    mode: 'full',
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 30_000,
    maxAuthFailures: opts.maxAuthFailures ?? 5,
    reconnect: { baseMs: 1_000, maxMs: 60_000, maxAttempts: opts.maxAttempts ?? 0 },
    onTick: (t) => ticks.push(t),
    onRejected: (r) => rejected.push(r),
    onLog: (l) => logs.push(l),
  });

  const h: Harness = {
    client, sockets, clock, ticks, rejected, logs,
    get authCalls() { return state.authCalls; },
    latest: () => sockets[sockets.length - 1]!,
  } as Harness;
  return h;
}

function equityFrame(opts: {
  ltp: number; ltt?: number; ltq?: number; cp?: number; vtt?: number; currentTs?: number;
  key?: string;
}): Uint8Array {
  return pb.feedResponse({
    type: FEED_TYPE.live_feed,
    currentTs: opts.currentTs ?? 1_755_000_000_000,
    feeds: {
      [opts.key ?? KEY_RELIANCE]: pb.equityFeed({
        ltpc: { ltp: opts.ltp, ltt: opts.ltt, ltq: opts.ltq, cp: opts.cp },
        vtt: opts.vtt,
      }),
    },
  });
}

// ── 1. Valid tick normalisation ─────────────────────────────────────────────

describe('valid tick normalization', () => {
  test('maps a feed payload to the internal Tick shape', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.clock.advance(250); // simulate 250ms transit

    h.latest().handlers.onMessage(
      equityFrame({ ltp: 2456.75, ltt: 1_755_000_000_000, ltq: 42, cp: 2440.1, vtt: 1_250_000 }),
    );

    assert.equal(h.ticks.length, 1);
    const tick = h.ticks[0]!;
    assert.equal(tick.symbol, 'RELIANCE', 'instrument key resolved to internal symbol');
    assert.equal(tick.instrumentKey, KEY_RELIANCE);
    assert.equal(tick.ltp, 2456.75);
    assert.equal(tick.ltq, 42);
    assert.equal(tick.prevClose, 2440.1);
    assert.equal(tick.volumeToday, 1_250_000);
    assert.equal(tick.provenance.latencyClass, 'REALTIME');
    assert.equal(tick.provenance.fidelity, 'HIGH');
  });

  // Requirement 15.
  test('keeps exchange time and receive time separate, and derives latency', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.clock.advance(180);

    h.latest().handlers.onMessage(equityFrame({ ltp: 100, ltt: 1_755_000_000_000 }));

    const tick = h.ticks[0]!;
    assert.equal(tick.exchangeTs, '2025-08-12T12:00:00.000Z');
    assert.equal(tick.receivedAt, new Date(1_755_000_000_180).toISOString());
    assert.notEqual(tick.exchangeTs, tick.receivedAt, 'the two must not be conflated');
    assert.equal(tick.latencyMs, 180, 'latency is receive minus exchange time');
  });

  test('falls back to the frame timestamp when the trade time is absent', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, currentTs: 1_755_000_000_000 }));
    assert.equal(h.ticks[0]!.exchangeTs, '2025-08-12T12:00:00.000Z');
  });

  test('flags an index tick', async () => {
    const h = harness();
    await h.client.start([KEY_NIFTY]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(
      pb.feedResponse({ feeds: { [KEY_NIFTY]: pb.indexFeed({ ltpc: { ltp: 24_150.3 } }) } }),
    );
    assert.equal(h.ticks[0]!.isIndex, true);
    assert.equal(h.ticks[0]!.symbol, 'NIFTY_50');
  });
});

// ── 2. Malformed tick ───────────────────────────────────────────────────────

describe('malformed tick', () => {
  test('a corrupt frame is dropped without killing the stream', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();

    h.latest().handlers.onMessage(new Uint8Array([0x12, 0xff, 0x7f, 0x01]));
    assert.equal(h.client.health.decodeErrors, 1);
    assert.equal(h.ticks.length, 0);

    // The very next good frame must still be processed.
    h.latest().handlers.onMessage(equityFrame({ ltp: 101, ltt: 1_755_000_000_001 }));
    assert.equal(h.ticks.length, 1, 'one bad frame must not break the stream');
    assert.equal(h.client.health.state, 'CONNECTED');
  });

  test('a feed with no price is rejected, not defaulted to zero', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(
      pb.feedResponse({ feeds: { [KEY_RELIANCE]: pb.equityFeed({ ltpc: { ltp: 0 } }) } }),
    );
    assert.equal(h.ticks.length, 0);
    assert.equal(h.rejected[0]!.reason, 'NON_POSITIVE_PRICE');
  });

  test('an unknown instrument key is rejected rather than guessed', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, key: 'NSE_EQ|UNKNOWN' }));
    assert.equal(h.ticks.length, 0);
    assert.equal(h.rejected[0]!.reason, 'UNKNOWN_INSTRUMENT');
  });

  test('rejections are counted by reason in health', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, key: 'NSE_EQ|UNKNOWN' }));
    assert.equal(h.client.health.rejectionsByReason['UNKNOWN_INSTRUMENT'], 1);
  });
});

// ── 3 & 4. Duplicate and out-of-order ticks ─────────────────────────────────

describe('duplicate and out-of-order ticks', () => {
  test('an identical repeated tick is rejected as a duplicate', () => {
    const seq = new TickSequencer();
    const tick: Tick = {
      symbol: 'RELIANCE', instrumentKey: KEY_RELIANCE, ltp: 100, ltq: 5,
      volumeToday: 1000, atp: null, prevClose: null,
      exchangeTs: '2026-08-13T05:33:00.000Z', receivedAt: '2026-08-13T05:33:00.100Z',
      latencyMs: 100, isIndex: false,
      provenance: { sourceId: 'x', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    };
    assert.equal(seq.accept(tick), null);
    assert.equal(seq.accept({ ...tick })?.reason, 'DUPLICATE');
  });

  test('a changed price at the same timestamp is not a duplicate', () => {
    const seq = new TickSequencer();
    const base: Tick = {
      symbol: 'RELIANCE', instrumentKey: KEY_RELIANCE, ltp: 100, ltq: 5,
      volumeToday: 1000, atp: null, prevClose: null,
      exchangeTs: '2026-08-13T05:33:00.000Z', receivedAt: '2026-08-13T05:33:00.100Z',
      latencyMs: 100, isIndex: false,
      provenance: { sourceId: 'x', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    };
    assert.equal(seq.accept(base), null);
    assert.equal(seq.accept({ ...base, ltp: 101 }), null);
  });

  test('a tick older than the last seen is rejected as out of order', () => {
    const seq = new TickSequencer();
    const base: Tick = {
      symbol: 'RELIANCE', instrumentKey: KEY_RELIANCE, ltp: 100, ltq: 1,
      volumeToday: 1000, atp: null, prevClose: null,
      exchangeTs: '2026-08-13T05:33:10.000Z', receivedAt: '2026-08-13T05:33:10.100Z',
      latencyMs: 100, isIndex: false,
      provenance: { sourceId: 'x', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    };
    assert.equal(seq.accept(base), null);
    const late = seq.accept({ ...base, ltp: 99, exchangeTs: '2026-08-13T05:33:05.000Z' });
    assert.equal(late?.reason, 'OUT_OF_ORDER');
  });

  test('ordering is tracked per instrument, not globally', () => {
    const seq = new TickSequencer();
    const mk = (key: string, ts: string): Tick => ({
      symbol: key, instrumentKey: key, ltp: 100, ltq: 1, volumeToday: null,
      atp: null, prevClose: null, exchangeTs: ts, receivedAt: ts, latencyMs: 0,
      isIndex: false,
      provenance: { sourceId: 'x', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    });
    assert.equal(seq.accept(mk('A', '2026-08-13T05:33:10.000Z')), null);
    assert.equal(seq.accept(mk('B', '2026-08-13T05:33:05.000Z')), null,
      'B is not out of order merely because A is ahead');
  });

  test('reconnect replay is admitted again, but ordering still applies', () => {
    const seq = new TickSequencer();
    const tick: Tick = {
      symbol: 'RELIANCE', instrumentKey: KEY_RELIANCE, ltp: 100, ltq: 1,
      volumeToday: 1000, atp: null, prevClose: null,
      exchangeTs: '2026-08-13T05:33:00.000Z', receivedAt: '2026-08-13T05:33:00.100Z',
      latencyMs: 100, isIndex: false,
      provenance: { sourceId: 'x', latencyClass: 'REALTIME', fidelity: 'HIGH' },
    };
    assert.equal(seq.accept(tick), null);
    seq.softResetForReconnect();
    assert.equal(seq.accept({ ...tick }), null, 'replayed state is new to the rebuilt candle');
    assert.equal(
      seq.accept({ ...tick, ltp: 99, exchangeTs: '2026-08-13T05:32:00.000Z' })?.reason,
      'OUT_OF_ORDER',
    );
  });

  test('the client applies the sequencer to live frames', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    const frame = equityFrame({ ltp: 100, ltt: 1_755_000_000_000, vtt: 500 });
    h.latest().handlers.onMessage(frame);
    h.latest().handlers.onMessage(frame);
    assert.equal(h.ticks.length, 1);
    assert.equal(h.client.health.rejectionsByReason['DUPLICATE'], 1);
  });
});

// ── 5. Reconnect ────────────────────────────────────────────────────────────

describe('reconnect', () => {
  test('reconnects after an unexpected close and counts it', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    assert.equal(h.sockets.length, 1);

    h.latest().handlers.onClose(1006, 'abnormal closure');
    await flush();

    assert.equal(h.sockets.length, 2, 'a new socket was created');
    assert.equal(h.client.health.reconnectCount, 1);
  });

  test('backoff grows exponentially with jitter and is capped', async () => {
    const h = harness({ authorize: async () => { throw new Error('down'); } });
    await h.client.start([KEY_RELIANCE]);
    // baseMs 1000, jitter factor 0.5 + 0.5*0.5 = 0.75 with FakeClock random 0.5
    assert.deepEqual(h.clock.sleeps.slice(0, 4), [750, 1500, 3000, 6000]);
  });

  test('re-subscribes to every instrument after reconnecting', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE, KEY_NIFTY]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onClose(1006, '');
    await flush();
    h.latest().handlers.onOpen();

    const sent = h.latest().sent[0];
    assert.ok(sent instanceof Uint8Array, 'V3 requires binary subscribe frames');
    const payload = JSON.parse(new TextDecoder().decode(sent));
    assert.equal(payload.method, 'sub');
    assert.equal(payload.data.mode, 'full');
    assert.deepEqual(payload.data.instrumentKeys, [KEY_RELIANCE, KEY_NIFTY]);
  });

  test('stops retrying when a finite attempt limit is reached', async () => {
    const h = harness({
      authorize: async () => { throw new Error('down'); },
      maxAttempts: 3,
    });
    await h.client.start([KEY_RELIANCE]);
    assert.equal(h.client.health.state, 'STOPPED');
    assert.equal(h.client.health.reconnectCount, 3);
  });

  test('stop() prevents any further reconnection', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.client.stop();
    const before = h.sockets.length;
    h.latest().handlers.onClose(1006, '');
    await flush();
    assert.equal(h.sockets.length, before);
    assert.equal(h.client.health.state, 'STOPPED');
  });
});

// ── 6. Authentication failure ───────────────────────────────────────────────

describe('authentication failure', () => {
  test('retries a failing authorization without throwing', async () => {
    let calls = 0;
    const h = harness({
      authorize: async (n) => {
        calls = n;
        if (n < 3) throw new Error('401 Unauthorized');
        return 'wss://feed.example.invalid/v3';
      },
    });
    await h.client.start([KEY_RELIANCE]);
    assert.equal(calls, 3);
    assert.equal(h.sockets.length, 1, 'connected on the third attempt');
  });

  // Requirement 10 — this must never take down the process.
  test('gives up after the auth-failure limit but keeps the process alive', async () => {
    const h = harness({
      authorize: async () => { throw new Error('401 Unauthorized: token expired'); },
      maxAuthFailures: 3,
    });
    await h.client.start([KEY_RELIANCE]);

    assert.equal(h.client.health.state, 'AUTH_FAILED');
    assert.equal(h.client.health.consecutiveAuthFailures, 3);
    assert.match(h.logs.join('\n'), /likely expired or revoked/);
    assert.match(h.logs.join('\n'), /process stays alive/);
  });

  test('a policy close code is treated as auth failure, not transport failure', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onClose(4401, 'unauthorized');
    await flush();
    assert.ok(h.client.health.consecutiveAuthFailures >= 1);
  });

  test('a successful connection clears the auth-failure counter', async () => {
    const h = harness({
      authorize: async (n) => {
        if (n === 1) throw new Error('401');
        return 'wss://feed.example.invalid/v3';
      },
    });
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    assert.equal(h.client.health.consecutiveAuthFailures, 0);
  });
});

// ── 7. Heartbeat timeout ────────────────────────────────────────────────────

describe('heartbeat timeout', () => {
  test('does not fire while messages keep arriving', async () => {
    const h = harness({ heartbeatTimeoutMs: 30_000 });
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.clock.advance(20_000);
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, ltt: 1_755_000_020_000 }));
    h.clock.advance(20_000);
    assert.equal(h.client.checkHeartbeat(), false, 'a recent message resets the clock');
  });

  // A half-open TCP connection looks healthy; silence is the only signal.
  test('forces a reconnect when the socket goes silent', async () => {
    const h = harness({ heartbeatTimeoutMs: 30_000 });
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    const first = h.latest();

    h.clock.advance(31_000);
    assert.equal(h.client.checkHeartbeat(), true);

    assert.equal(first.closed?.code, 4000);
    assert.match(first.closed?.reason ?? '', /heartbeat/);
    assert.equal(h.client.health.reconnectCount, 1);
    assert.match(h.logs.join('\n'), /forcing reconnect/);
  });
});

// ── 8. Market closed ────────────────────────────────────────────────────────

describe('market closed', () => {
  test('records closed status without disconnecting', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();

    h.latest().handlers.onMessage(
      pb.feedResponse({ type: FEED_TYPE.market_info, segmentStatus: { NSE_EQ: 3, NSE_FO: 3 } }),
    );

    assert.equal(h.client.health.marketStatus, 'CLOSED');
    assert.equal(h.client.health.state, 'CONNECTED', 'a closed market is not a fault');
    assert.equal(h.sockets.length, 1, 'must not reconnect just because the market closed');
  });

  test('a market_info frame produces no ticks', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(
      pb.feedResponse({ type: FEED_TYPE.market_info, segmentStatus: { NSE_EQ: 2 } }),
    );
    assert.equal(h.ticks.length, 0);
    assert.equal(h.client.health.marketStatus, 'NORMAL_OPEN');
  });

  test('silence outside market hours still counts as a heartbeat timeout', async () => {
    // Documents real behaviour: the client cannot distinguish a closed market
    // from a dead socket by silence alone, so it reconnects either way. The
    // scheduler is responsible for not running outside market hours.
    const h = harness({ heartbeatTimeoutMs: 10_000 });
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.clock.advance(11_000);
    assert.equal(h.client.checkHeartbeat(), true);
  });
});

// ── Health snapshot (requirement 13) ────────────────────────────────────────

describe('connection health record', () => {
  test('reports every required field', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE, KEY_NIFTY]);
    h.latest().handlers.onOpen();
    h.clock.advance(120);
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, ltt: 1_755_000_000_000 }));

    const health = h.client.health;
    assert.equal(health.state, 'CONNECTED');
    assert.equal(health.subscribedInstruments, 2);
    assert.equal(health.ticksReceived, 1);
    assert.equal(health.reconnectCount, 0);
    assert.ok(health.lastTickAt !== null);
    assert.ok(health.connectedAt !== null);
    assert.equal(health.meanLatencyMs, 120);
    assert.equal(health.maxLatencyMs, 120);
  });

  test('averages latency across ticks', async () => {
    const h = harness();
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.clock.advance(100);
    h.latest().handlers.onMessage(equityFrame({ ltp: 100, ltt: 1_755_000_000_000 }));
    h.clock.advance(200);
    h.latest().handlers.onMessage(equityFrame({ ltp: 101, ltt: 1_755_000_000_100 }));

    // Latencies: 100ms and (1_755_000_000_300 - 1_755_000_000_100) = 200ms.
    assert.equal(h.client.health.meanLatencyMs, 150);
    assert.equal(h.client.health.maxLatencyMs, 200);
  });
});

// ── Credential safety (requirements 7 and 8) ────────────────────────────────

describe('token never leaks', () => {
  test('loads only from the environment and fails loudly when absent', () => {
    assert.throws(() => UpstoxCredentials.fromEnv({} as NodeJS.ProcessEnv), CredentialError);
    assert.throws(
      () => UpstoxCredentials.fromEnv({ [TOKEN_ENV]: '   ' } as NodeJS.ProcessEnv),
      CredentialError,
    );
  });

  test('is not exposed by toString, JSON, or template interpolation', () => {
    const c = credentials();
    assert.ok(!String(c).includes(TOKEN));
    assert.ok(!JSON.stringify(c).includes(TOKEN));
    assert.ok(!JSON.stringify({ c }).includes(TOKEN));
    assert.ok(!`${c}`.includes(TOKEN));
    assert.match(String(c), /^UpstoxCredentials\(tok_[0-9a-f]{8}\)$/);
  });

  test('reveal() is the only path to the raw value', () => {
    assert.equal(credentials().reveal(), TOKEN);
    assert.equal(credentials().authHeader().Authorization, `Bearer ${TOKEN}`);
  });

  test('fingerprints differ between tokens but never contain them', () => {
    const a = credentials('token-aaaa').fingerprint();
    const b = credentials('token-bbbb').fingerprint();
    assert.notEqual(a, b);
    assert.ok(!a.includes('aaaa'));
  });

  test('redact strips bearer, JWT and query-parameter token shapes', () => {
    assert.equal(redact(`Authorization: Bearer ${TOKEN}`), 'Authorization: Bearer [REDACTED]');
    assert.ok(!redact(`failed with ${TOKEN}`, credentials()).includes(TOKEN));
    assert.ok(!redact('access_token=abcdef1234567890').includes('abcdef1234567890'));
  });

  test('redactUrl removes credential query parameters', () => {
    const url = `wss://feed.example.invalid/v3?token=${TOKEN}&x=1`;
    const safe = redactUrl(url, credentials());
    assert.ok(!safe.includes(TOKEN));
    assert.ok(safe.includes('x=1'), 'non-secret parameters are preserved');
  });

  // The end-to-end guarantee: nothing the client logs can carry the token.
  test('no emitted log line contains the token, even on failure', async () => {
    const h = harness({
      authorize: async (n) => {
        if (n < 2) throw new Error(`auth rejected for Bearer ${TOKEN}`);
        return `wss://feed.example.invalid/v3?token=${TOKEN}`;
      },
      maxAuthFailures: 2,
    });
    await h.client.start([KEY_RELIANCE]);
    h.latest().handlers.onOpen();
    h.latest().handlers.onMessage(new Uint8Array([0xff, 0xff]));
    h.latest().handlers.onClose(4401, `rejected ${TOKEN}`);
    await flush();

    const combined = h.logs.join('\n');
    assert.ok(h.logs.length > 0, 'the client did log');
    assert.ok(!combined.includes(TOKEN), `token leaked into logs:\n${combined}`);
    assert.ok(!JSON.stringify(h.client.health).includes(TOKEN), 'token leaked into health');
  });
});
