/**
 * SWING-10 CLI.
 *
 *   npm run db:init     apply migrations, mirror the source register
 *   npm run db:status   schema version, row counts, resolved capabilities
 *   npm run sources     the source register and why each source is on or off
 */

import { join } from 'node:path';
import { openDb } from './db/driver.ts';
import { currentVersion, migrate } from './db/migrate.ts';
import { SourceRegistry } from './sources/registry.ts';
import { describeCapabilities, resolveCapabilities } from './sources/capabilities.ts';
import { ManualCsvProvider } from './adapters/tier0/manual-csv.ts';
import { ingestCandles } from './ingest/candles.ts';
import { ingestAnnouncements } from './ingest/events.ts';
import { loadUniverse } from './ingest/universe.ts';
import { DATA_DIR, dbPath, SOURCES_CONFIG } from './paths.ts';

function loadRegistry(): SourceRegistry {
  return SourceRegistry.fromFile(SOURCES_CONFIG);
}

function cmdDbInit(): void {
  const path = dbPath();
  const db = openDb({ path });
  try {
    const result = migrate(db);
    if (result.applied.length === 0) {
      console.log(`Database already at version ${result.alreadyAtVersion}: ${path}`);
    } else {
      console.log(`Database: ${path}`);
      for (const m of result.applied) {
        console.log(`  applied ${String(m.version).padStart(3, '0')}_${m.name}`);
      }
    }
    loadRegistry().persist(db);
    console.log('Source register mirrored into data_sources.');
  } finally {
    db.close();
  }
}

function cmdDbStatus(): void {
  const path = dbPath();
  const db = openDb({ path });
  try {
    console.log(`Database: ${path}`);
    console.log(`Schema version: ${currentVersion(db)}\n`);

    const tables = db.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    );
    const width = Math.max(...tables.map((t) => t.name.length), 10);
    for (const { name } of tables) {
      const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`);
      console.log(`  ${name.padEnd(width)}  ${String(row?.n ?? 0).padStart(8)}`);
    }
  } finally {
    db.close();
  }
}

function cmdSources(): void {
  const registry = loadRegistry();
  const caps = resolveCapabilities(registry);

  console.log('SOURCE REGISTER\n');
  for (const tier of [0, 1, 2] as const) {
    const inTier = registry.byTier(tier);
    if (inTier.length === 0) continue;
    console.log(`  Tier ${tier}`);
    for (const { policy, enabled, disabledReason } of inTier) {
      const mark = enabled ? 'ON ' : 'off';
      console.log(
        `    [${mark}] ${policy.id.padEnd(20)} ${policy.latencyClass.padEnd(9)} ` +
          `${policy.legalBasis.padEnd(17)} poll=${policy.poll.intervalMs / 1000}s ` +
          `floor=${policy.poll.minIntervalMsFloor / 1000}s ` +
          `${policy.rateLimit.maxPerMinute}/min`,
      );
      if (!enabled && disabledReason) console.log(`          ${disabledReason}`);
      if (policy.attribution) console.log(`          attribution: ${policy.attribution}`);
    }
    console.log('');
  }

  console.log(`CAPABILITIES\n  ${describeCapabilities(caps)}\n`);
  if (caps.degradations.length > 0) {
    console.log('DEGRADATIONS');
    for (const d of caps.degradations) console.log(`  - ${d}`);
    console.log('');
  }
}

/** Runs the whole Tier 0 pipeline from files on disk. No network at all. */
async function cmdIngestManual(): Promise<void> {
  const dir = join(DATA_DIR, 'manual');
  const provider = new ManualCsvProvider({ dir });

  if (!(await provider.isAvailable())) {
    console.error(`No manual data directory at ${dir}`);
    process.exitCode = 1;
    return;
  }

  const db = openDb({ path: dbPath() });
  try {
    migrate(db);

    const candlesBySymbol = provider.loadAllCandles();
    const allCandles = [...candlesBySymbol.values()].flat();
    const candleStats = ingestCandles(db, allCandles);
    console.log(
      `Candles: ${candleStats.inserted} inserted, ${candleStats.upgraded} upgraded, ` +
        `${candleStats.skipped} unchanged (${candlesBySymbol.size} symbol(s))`,
    );

    let instruments = await provider.listInstruments();
    if (instruments.length === 0) {
      // Fall back to whatever the candle files cover.
      instruments = [...candlesBySymbol.keys()].map((symbol) => ({ symbol }));
    }
    const universe = loadUniverse(db, { instruments, candlesBySymbol, inNifty500: true });
    console.log(
      `Universe: ${universe.total} total, ${universe.tradeable} tradeable, ` +
        `${universe.excluded} excluded`,
    );
    for (const [reason, count] of Object.entries(universe.byReason)) {
      console.log(`  excluded (${reason}): ${count}`);
    }

    const events = provider.loadEvents();
    if (events.length > 0) {
      const eventStats = ingestAnnouncements(db, events);
      console.log(
        `Events: ${eventStats.inserted} inserted, ${eventStats.upgraded} upgraded, ` +
          `${eventStats.duplicates} duplicate`,
      );
    } else {
      console.log('Events: none found');
    }

    const caps = resolveCapabilities(SourceRegistry.fromFile(SOURCES_CONFIG));
    console.log(`\n${describeCapabilities(caps)}`);
    for (const d of caps.degradations) console.log(`  ! ${d}`);
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  'db:init': cmdDbInit,
  'db:status': cmdDbStatus,
  sources: cmdSources,
  'ingest:manual': cmdIngestManual,
};

const command = process.argv[2];
const run = command ? COMMANDS[command] : undefined;

if (!run) {
  if (command) console.error(`Unknown command: ${command}\n`);
  console.error(`Usage: cli.ts <command>\n\nCommands:\n  ${Object.keys(COMMANDS).join('\n  ')}`);
  process.exit(1);
}

await run();
