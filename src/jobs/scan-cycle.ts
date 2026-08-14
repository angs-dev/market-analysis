/**
 * One complete scan cycle: scan, record transitions, alert.
 *
 * Shared by every execution mode. `scan:once` calls it exactly once and exits;
 * the local scheduler calls it on an interval. There is one implementation, so
 * a GitHub Actions run and a local run cannot disagree about a signal.
 */

import type { Db } from '../db/driver.ts';
import type { RuntimeConfig } from '../config/index.ts';
import { ScanEngine } from '../scan/engine.ts';
import { withLock } from '../scan/lock.ts';
import { AlertEngine, candidatesBySymbol, type AlertChannel } from '../alerts/engine.ts';
import { invalidateMissing, observeSignal, type Transition } from '../alerts/state.ts';
import type { ScanEnvelope, ScanMode, ScanResult, ScanTrigger } from '../scan/types.ts';

export interface CycleDeps {
  db: Db;
  config: RuntimeConfig;
  channels?: AlertChannel[];
  emit?: (envelope: ScanEnvelope) => void;
  now?: () => Date;
  owner?: string;
}

export interface CycleOptions {
  mode: ScanMode;
  trigger: ScanTrigger;
  symbols?: string[];
  ignoreMarketHours?: boolean;
}

export interface CycleOutcome {
  /** Null when the lock was held by another scan. */
  result: ScanResult | null;
  transitions: Transition[];
  alertsSent: number;
  alertsSuppressed: number;
  skippedReason?: string;
}

export async function runScanCycle(
  deps: CycleDeps,
  opts: CycleOptions,
): Promise<CycleOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const owner = deps.owner ?? `${opts.mode}:${process.pid}`;

  const engineDeps: ConstructorParameters<typeof ScanEngine>[0] = {
    db: deps.db, config: deps.config, now,
  };
  if (deps.emit) engineDeps.emit = deps.emit;
  const engine = new ScanEngine(engineDeps);

  const alertDeps: ConstructorParameters<typeof AlertEngine>[0] = {
    db: deps.db, config: deps.config.alerts, now,
  };
  if (deps.channels) alertDeps.channels = deps.channels;
  const alerts = new AlertEngine(alertDeps);

  const outcome = await withLock(deps.db, owner, async (): Promise<CycleOutcome> => {
    const scanOpts: Parameters<ScanEngine['scanNow']>[0] = {
      mode: opts.mode, trigger: opts.trigger,
    };
    if (opts.symbols) scanOpts.symbols = opts.symbols;
    if (opts.ignoreMarketHours !== undefined) scanOpts.ignoreMarketHours = opts.ignoreMarketHours;

    const result = await engine.scanNow(scanOpts);
    const at = result.timestamp;
    const transitions: Transition[] = [];

    // Record what each analysed symbol now looks like.
    for (const candidate of result.candidates) {
      const transition = observeSignal(deps.db, {
        symbol: candidate.symbol,
        action: candidate.action,
        swing10Score: candidate.swing10Score,
        eventQuality: candidate.eventQualityScore,
        tradeQuality: candidate.tradeQualityScore,
        eventId: candidate.event?.id ?? null,
        candidateId: candidate.candidateId,
        at,
      });
      if (transition) transitions.push(transition);
    }

    // A PAPER_BUY that was re-examined and no longer qualifies is invalidated.
    const analysed = result.candidates.map((c) => c.symbol);
    transitions.push(...invalidateMissing(deps.db, analysed, analysed, at));

    // Market-wide conditions alert independently of any symbol.
    let sent = 0;
    let suppressed = 0;

    if (result.marketRegime.unstable) {
      const decision = await alerts.considerSystem(
        'MARKET_HIGH_RISK',
        result.noTradeReason ?? 'market regime is unstable',
      );
      decision.sent ? sent++ : suppressed++;
    }

    const bySymbol = candidatesBySymbol(result);
    for (const transition of transitions) {
      const decision = await alerts.consider(transition, bySymbol.get(transition.symbol));
      decision.sent ? sent++ : suppressed++;
    }

    return { result, transitions, alertsSent: sent, alertsSuppressed: suppressed };
  });

  if (outcome === null) {
    return {
      result: null, transitions: [], alertsSent: 0, alertsSuppressed: 0,
      skippedReason: 'another scan is already running',
    };
  }
  return outcome;
}

/** Compact one-line summary for logs and CI output. */
export function summariseCycle(outcome: CycleOutcome): string {
  if (outcome.result === null) return `skipped: ${outcome.skippedReason}`;
  const r = outcome.result;
  return (
    `${r.marketStatus} | screened ${r.stats.symbolsScreened} | ` +
    `deep ${r.stats.symbolsDeepAnalysed} | events ${r.stats.newEvents} | ` +
    `buy ${r.paperBuyCandidates.length} watch ${r.watchCandidates.length} | ` +
    `transitions ${outcome.transitions.length} | ` +
    `alerts ${outcome.alertsSent} sent, ${outcome.alertsSuppressed} suppressed | ` +
    `${r.stats.durationMs}ms`
  );
}
