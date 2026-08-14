/**
 * Execution modes.
 *
 * `scanOnce` runs exactly one cycle and returns — the shape GitHub Actions
 * needs. `startScanner` loops on an interval for local use. Both call the same
 * runScanCycle, so the two modes cannot diverge in what they decide.
 */

import type { Db } from '../db/driver.ts';
import type { RuntimeConfig } from '../config/index.ts';
import { runScanCycle, summariseCycle, type CycleDeps, type CycleOutcome } from './scan-cycle.ts';
import { marketSession } from '../market/session.ts';
import type { ScanEnvelope } from '../scan/types.ts';

export interface ScanOnceOptions {
  symbols?: string[];
  /** Run even when the market is closed. */
  force?: boolean;
  trigger?: 'SCHEDULE' | 'MANUAL';
}

/**
 * One cycle, then return.
 *
 * The market-hours check happens here, in the application, because GitHub's
 * cron is UTC and cannot know about Indian holidays. The workflow fires often;
 * this decides whether firing means anything.
 */
export async function scanOnce(
  deps: CycleDeps,
  opts: ScanOnceOptions = {},
): Promise<CycleOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const session = marketSession(now(), {
    window: deps.config.session.window,
    holidays: deps.config.session.holidays,
    specialSessions: deps.config.session.specialSessions,
  });

  if (!session.isScanWindow && !opts.force) {
    return {
      result: null, transitions: [], alertsSent: 0, alertsSuppressed: 0,
      skippedReason: `market ${session.status}: ${session.reason}`,
    };
  }

  const cycleOpts: Parameters<typeof runScanCycle>[1] = {
    mode: 'ONCE',
    trigger: opts.trigger ?? 'SCHEDULE',
  };
  if (opts.symbols) cycleOpts.symbols = opts.symbols;
  if (opts.force) cycleOpts.ignoreMarketHours = true;

  return runScanCycle(deps, cycleOpts);
}

export interface ScannerHandle {
  stop(): void;
  /** Resolves when the loop has exited. */
  readonly done: Promise<void>;
  readonly cycles: () => number;
}

export interface StartScannerOptions {
  /** Overrides the configured interval. Clamped to the configured floor. */
  intervalMs?: number;
  onCycle?: (outcome: CycleOutcome) => void;
  log?: (line: string) => void;
  /** Stops after this many cycles. Used by tests. */
  maxCycles?: number;
}

/**
 * Continuous local scanner.
 *
 * Sleeps between cycles rather than using setInterval, so a slow cycle delays
 * the next one instead of stacking up behind it. Transient failures are logged
 * and the loop continues — a network blip must not end the session.
 */
export function startScanner(
  deps: CycleDeps,
  config: RuntimeConfig,
  opts: StartScannerOptions = {},
): ScannerHandle {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const intervalMs = Math.max(
    config.scan.minIntervalMs,
    opts.intervalMs ?? config.scan.intervalMs,
  );

  let stopped = false;
  let cycles = 0;
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  /**
   * Interruptible sleep. stop() must take effect immediately rather than after
   * up to a full interval — and an un-interruptible timer would also let the
   * loop outlive the event loop, leaving `done` pending forever.
   */
  let wake: (() => void) | null = null;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = (): void => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  void (async (): Promise<void> => {
    log(`scanner started, interval ${Math.round(intervalMs / 1000)}s`);

    while (!stopped) {
      const now = (deps.now ?? ((): Date => new Date()))();
      const session = marketSession(now, {
        window: config.session.window,
        holidays: config.session.holidays,
        specialSessions: config.session.specialSessions,
      });

      if (session.isScanWindow) {
        try {
          const outcome = await runScanCycle(deps, { mode: 'LOCAL', trigger: 'SCHEDULE' });
          cycles++;
          log(`[${session.time} IST] ${summariseCycle(outcome)}`);
          opts.onCycle?.(outcome);
        } catch (err) {
          // A failed cycle must never end the session.
          cycles++;
          log(`[${session.time} IST] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log(`[${session.time} IST] ${session.status} — ${session.reason}`);
      }

      if (opts.maxCycles !== undefined && cycles >= opts.maxCycles) break;
      if (stopped) break;
      await sleep(intervalMs);
    }

    log('scanner stopped');
    resolveDone!();
  })();

  return {
    stop: () => {
      stopped = true;
      wake?.();
    },
    done,
    cycles: () => cycles,
  };
}

/** Emits envelopes to any number of subscribers. Used by the SSE endpoint. */
export class ScanBus {
  readonly #subscribers = new Set<(envelope: ScanEnvelope) => void>();

  emit = (envelope: ScanEnvelope): void => {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(envelope);
      } catch {
        // A broken subscriber must not break the scan.
      }
    }
  };

  subscribe(fn: (envelope: ScanEnvelope) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  get size(): number {
    return this.#subscribers.size;
  }
}
