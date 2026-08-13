/**
 * Live connectivity smoke test.
 *
 * Connects to the Upstox Market Data Feed V3 with the read-only Analytics
 * Token, subscribes to the small test universe, runs for a fixed period, then
 * prints connection health, measured latency and the 1-minute candles built
 * from the tick stream.
 *
 * This exists because the development sandbox cannot reach upstox.com. It is
 * how the numbers that could not be measured there get measured here.
 *
 * Places no orders and reads no positions. Data only.
 */

import { join } from 'node:path';
import { openDb } from '../db/driver.ts';
import { migrate } from '../db/migrate.ts';
import { systemClock } from '../sources/clock.ts';
import { UpstoxCredentials } from '../adapters/tier1/upstox/credentials.ts';
import { UpstoxFeedClient } from '../adapters/tier1/upstox/feed-client.ts';
import { authorizeV3, createSocketFactory } from '../adapters/tier1/upstox/live.ts';
import {
  loadInstrumentMaster, loadTestUniverse, resolveUniverse,
} from '../adapters/tier1/upstox/instruments.ts';
import { CandleBuilder } from '../technicals/candle-builder.ts';
import { ingestCandles } from '../ingest/candles.ts';
import { recordFeedHealth, recordTickRejection } from '../ingest/feed-health.ts';
import { UPSTOX_SOURCE_ID } from '../adapters/tier1/upstox/provider.ts';
import { CONFIG_DIR, DATA_DIR, dbPath } from '../paths.ts';
import type { Candle } from '../market/types.ts';
import type { Tick } from '../market/tick.ts';
import type { InstrumentMasterRow } from '../adapters/tier1/upstox/instruments.ts';

const MASTER_PATH = join(DATA_DIR, 'manual', 'upstox_instruments.json');

export async function runFeedSmoke(seconds: number): Promise<void> {
  const credentials = UpstoxCredentials.fromEnv();
  console.log(`Using Analytics Token ${credentials.fingerprint()} (value never printed)\n`);

  const universe = loadTestUniverse(join(CONFIG_DIR, 'universe.test.json'));

  let master: InstrumentMasterRow[];
  try {
    master = loadInstrumentMaster(MASTER_PATH);
    console.log(`Instrument master: ${master.length} rows from ${MASTER_PATH}`);
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    console.error(
      'Equity instrument keys embed ISINs and are never guessed. Download the\n' +
        'Upstox instrument master to the path above, then re-run. Indices alone\n' +
        'can still be tested without it.',
    );
    master = [];
  }

  const resolved = resolveUniverse({
    equities: universe.equities,
    indices: universe.indices,
    master,
  });

  console.log(
    `Resolved ${resolved.symbolToKey.size} of ` +
      `${universe.equities.length + universe.indices.length} instruments`,
  );
  for (const { symbol, reason } of resolved.unresolved) {
    console.log(`  unresolved: ${symbol} — ${reason}`);
  }
  if (resolved.symbolToKey.size === 0) {
    console.error('Nothing to subscribe to. Aborting.');
    process.exitCode = 1;
    return;
  }

  const db = openDb({ path: dbPath() });
  migrate(db);

  const candles: Candle[] = [];
  const latencies: number[] = [];
  const perSymbolTicks = new Map<string, number>();

  const builder = new CandleBuilder({
    provenance: { sourceId: UPSTOX_SOURCE_ID, latencyClass: 'REALTIME', fidelity: 'HIGH' },
    onCandle: (candle) => candles.push(candle),
  });

  const client = new UpstoxFeedClient({
    credentials,
    authorize: authorizeV3,
    socketFactory: createSocketFactory(),
    clock: systemClock,
    instrumentMap: resolved.keyToSymbol,
    mode: universe.mode as 'full' | 'ltpc',
    heartbeatTimeoutMs: 30_000,
    onLog: (line) => console.log(`  ${line}`),
    onTick: (tick: Tick) => {
      builder.add(tick);
      perSymbolTicks.set(tick.symbol, (perSymbolTicks.get(tick.symbol) ?? 0) + 1);
      if (tick.latencyMs !== null) latencies.push(tick.latencyMs);
    },
    onRejected: (rejection) => {
      recordTickRejection(db, UPSTOX_SOURCE_ID, rejection, new Date().toISOString());
    },
  });

  console.log(`\nConnecting, mode='${universe.mode}', running for ${seconds}s...\n`);
  await client.start([...resolved.keyToSymbol.keys()]);

  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1_000));

  client.stop();
  candles.push(...builder.flush());

  const health = client.health;
  recordFeedHealth(db, UPSTOX_SOURCE_ID, health, new Date().toISOString());
  if (candles.length > 0) {
    const stats = ingestCandles(db, candles);
    console.log(`\nStored ${stats.inserted} candle(s) (${stats.skipped} unchanged)`);
  }

  console.log('\n─── CONNECTION HEALTH ───');
  console.log(`  state                  ${health.state}`);
  console.log(`  connected at           ${health.connectedAt ?? '-'}`);
  console.log(`  last tick at           ${health.lastTickAt ?? '-'}`);
  console.log(`  subscribed instruments ${health.subscribedInstruments}`);
  console.log(`  instruments with ticks ${perSymbolTicks.size}`);
  console.log(`  ticks received         ${health.ticksReceived}`);
  console.log(`  ticks rejected         ${health.ticksRejected} ${JSON.stringify(health.rejectionsByReason)}`);
  console.log(`  reconnects             ${health.reconnectCount}`);
  console.log(`  decode errors          ${health.decodeErrors}`);
  console.log(`  socket errors          ${health.socketErrors}`);
  console.log(`  market status          ${health.marketStatus ?? 'unknown'}`);
  if (health.lastError) console.log(`  last error             ${health.lastError}`);

  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const pct = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
    console.log('\n─── OBSERVED LATENCY (exchange timestamp to local receive) ───');
    console.log(`  samples ${sorted.length}`);
    console.log(`  min ${sorted[0]}ms  p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms  max ${sorted.at(-1)}ms`);
    console.log(
      '  Note: this includes any clock skew between this machine and the\n' +
        '  exchange. Sync your clock (NTP) before trusting the absolute value.',
    );
  } else {
    console.log('\nNo latency samples — no ticks carried an exchange timestamp.');
  }

  console.log(`\n─── CANDLES BUILT (${candles.length}) ───`);
  for (const c of candles.slice(0, 20)) {
    console.log(
      `  ${c.symbol.padEnd(12)} ${c.ts}  O ${c.open}  H ${c.high}  L ${c.low}  ` +
        `C ${c.close}  V ${c.volume ?? '-'}`,
    );
  }

  db.close();
}
