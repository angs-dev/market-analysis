/**
 * SWING-10 CLI.
 *
 *   npm run db:init     apply migrations, mirror the source register
 *   npm run db:status   schema version, row counts, resolved capabilities
 *   npm run sources     the source register and why each source is on or off
 *   npm run ingest:manual   run the Tier 0 pipeline from files on disk
 *   npm run scan [-- SYM --verbose]  score stored data, store every candidate
 *   npm run replay -- --from 2026-01-01 --to 2026-06-30   point-in-time replay
 *   npm run label       attach forward outcomes to every candidate
 *   npm run validate    metrics + HTML report
 *   npm run scan:once   one complete ScanEngine cycle, then exit
 *   npm run scanner:start   continuous local scanner during market hours
 *   npm run feed:smoke -- 60   live Upstox connectivity test (needs a token)
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
import { runFeedSmoke } from './jobs/feed-smoke.ts';
import { printScan, runScan } from './jobs/scan.ts';
import { scanOnce, startScanner } from './jobs/scanner.ts';
import { summariseCycle } from './jobs/scan-cycle.ts';
import { TelegramChannel } from './alerts/telegram.ts';
import { loadConfig } from './config/index.ts';
import { exportState, importState, readSnapshot, writeSnapshot } from './state/snapshot.ts';
import { runReplay } from './jobs/replay.ts';
import { labelCandidates } from './validation/labeller.ts';
import { buildReport } from './validation/metrics.ts';
import { printReport, writeHtmlReport } from './validation/report.ts';
import { CredentialError } from './adapters/tier1/upstox/credentials.ts';
import { InstrumentResolutionError } from './adapters/tier1/upstox/instruments.ts';
import { DATA_DIR, REPORTS_DIR, dbPath, SOURCES_CONFIG } from './paths.ts';

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
  scan: () => {
    const db = openDb({ path: dbPath() });
    try {
      migrate(db);
      const verbose = process.argv.includes('--verbose');
      const symbols = process.argv.slice(3).filter((a) => !a.startsWith('--'));
      const result = runScan(db, { symbols, verbose });
      printScan(db, result, verbose);
    } finally {
      db.close();
    }
  },
  replay: () => {
    const args = process.argv.slice(3);
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const from = flag('from');
    const to = flag('to');
    if (!from || !to) {
      console.error('Usage: cli.ts replay --from YYYY-MM-DD --to YYYY-MM-DD [--events-only]');
      process.exitCode = 1;
      return;
    }
    const db = openDb({ path: dbPath() });
    try {
      migrate(db);
      const result = runReplay(db, {
        from, to,
        eventDrivenOnly: args.includes('--events-only'),
        minHistoryBars: Number(flag('min-history') ?? 50),
      });
      console.log(
        `Replayed ${result.datesEvaluated} date(s), ${result.decisionsMade} decision(s)`,
      );
      for (const [action, count] of Object.entries(result.byAction)) {
        console.log(`  ${action.padEnd(10)} ${count}`);
      }
    } finally {
      db.close();
    }
  },

  label: () => {
    const db = openDb({ path: dbPath() });
    try {
      migrate(db);
      const stats = labelCandidates(db, { force: process.argv.includes('--force') });
      console.log(
        `Considered ${stats.candidatesConsidered}, labelled ${stats.labelled}, ` +
          `simulated ${stats.tradesSimulated} trade(s), ` +
          `${stats.skippedNoForwardData} awaiting forward data`,
      );
    } finally {
      db.close();
    }
  },

  validate: () => {
    const db = openDb({ path: dbPath() });
    try {
      migrate(db);
      const horizonIndex = process.argv.indexOf('--horizon');
      const horizon = horizonIndex >= 0 ? process.argv[horizonIndex + 1] ?? '5d' : '5d';
      const report = buildReport(db, horizon);
      printReport(report, horizon);
      const path = `${REPORTS_DIR}/validation.html`;
      writeHtmlReport(report, path);
      console.log(`HTML report written to ${path}`);
    } finally {
      db.close();
    }
  },

  'scan:once': async () => {
    const db = openDb({ path: dbPath() });
    try {
      migrate(db);
      const config = loadConfig();
      const args = process.argv.slice(3);
      const symbolArgs = args.filter((a) => !a.startsWith('--'));

      const opts: Parameters<typeof scanOnce>[1] = {
        trigger: args.includes('--manual') ? 'MANUAL' : 'SCHEDULE',
      };
      if (symbolArgs.length > 0) opts.symbols = symbolArgs;
      if (args.includes('--force')) opts.force = true;

      // Ephemeral runners restore alert state so the same signal is not
      // re-announced every five minutes. See src/state/snapshot.ts.
      const statePath = join(DATA_DIR, 'state.json');
      if (args.includes('--restore-state')) {
        const restored = importState(db, readSnapshot(statePath));
        if (restored.warning) console.log(`state: ${restored.warning}`);
        else {
          console.log(
            `state: restored ${restored.signalsRestored} signal(s), ` +
              `${restored.alertsRestored} recent alert(s)`,
          );
        }
      }

      const outcome = await scanOnce(
        { db, config, channels: [new TelegramChannel()] },
        opts,
      );
      console.log(summariseCycle(outcome));

      if (args.includes('--save-state')) {
        writeSnapshot(statePath, exportState(db));
        console.log(`state: saved to ${statePath}`);
      }

      for (const c of outcome.result?.paperBuyCandidates ?? []) {
        console.log(`  PAPER_BUY ${c.symbol} swing10=${c.swing10Score} event=${c.eventQualityScore}`);
      }
      for (const t of outcome.transitions.filter((x) => x.notable)) {
        console.log(`  transition ${t.symbol}: ${t.kind} — ${t.reason}`);
      }
    } finally {
      db.close();
    }
  },

  'scanner:start': async () => {
    const db = openDb({ path: dbPath() });
    migrate(db);
    const config = loadConfig();

    const handle = startScanner(
      { db, config, channels: [new TelegramChannel()] },
      config,
    );

    const shutdown = (signal: string): void => {
      console.log(`\nreceived ${signal}, finishing the current cycle...`);
      handle.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await handle.done;
    db.close();
  },

  'feed:smoke': async () => {
    const seconds = Number(process.argv[3] ?? 60);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      console.error('Usage: cli.ts feed:smoke [seconds]');
      process.exitCode = 1;
      return;
    }
    await runFeedSmoke(seconds);
  },
};

const command = process.argv[2];
const run = command ? COMMANDS[command] : undefined;

if (!run) {
  if (command) console.error(`Unknown command: ${command}\n`);
  console.error(`Usage: cli.ts <command>\n\nCommands:\n  ${Object.keys(COMMANDS).join('\n  ')}`);
  process.exit(1);
}

// A misconfiguration should read as an instruction, not a stack trace. Only
// genuinely unexpected errors keep their stack.
try {
  await run();
} catch (err) {
  if (err instanceof CredentialError || err instanceof InstrumentResolutionError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
