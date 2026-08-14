/**
 * Central runtime configuration.
 *
 * Every threshold, weight and interval the system uses is declared here or in
 * config/*.json — never as a magic number inside application logic. This is
 * what makes the SWING-10 weights optimisable later without touching code.
 *
 * Precedence: defaults, then config/runtime.json if present, then environment
 * variables. Environment wins so a GitHub Actions run can differ from local
 * without a second config file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { DEFAULT_LIQUIDITY, type LiquidityConfig } from '../ingest/universe.ts';
import { DEFAULT_GATES, type GateConfig } from '../scoring/gates.ts';
import { DEFAULT_THRESHOLDS, type DecisionThresholds } from '../scoring/decide.ts';
import { DEFAULT_EVENT_WEIGHTS, type EventWeights } from '../scoring/event-quality.ts';
import { DEFAULT_TRADE_WEIGHTS, type TradeWeights } from '../scoring/trade-quality.ts';
import { DEFAULT_COSTS, type CostConfig } from '../paper/cost-model.ts';
import { BOOTSTRAP_EXPECTED_MOVES, type ExpectedMoveTable } from '../pricedin/engine.ts';
import { DEFAULT_SESSION, loadHolidays, type SessionWindow } from '../market/session.ts';

export interface ScanConfig {
  /** Light-scan cadence in local mode, milliseconds. */
  intervalMs: number;
  /** Refuse to run faster than this regardless of configuration. */
  minIntervalMs: number;
  /** Symbols promoted to deep analysis per cycle, at most. */
  maxDeepAnalysis: number;
  /** A price feed older than this disables PAPER_BUY. */
  staleFeedMs: number;
  /** An event older than this is no longer treated as a live catalyst. */
  maxEventAgeMinutes: number;
}

export interface TriggerConfig {
  /** Volume relative to its 20-day average that promotes a symbol. */
  volumeRatio: number;
  /** Absolute intraday move, percent, that promotes a symbol. */
  priceMovePct: number;
  /** Materiality above which any event promotes its symbol. */
  materiality: number;
  /** Promote when price is within this percentage of a breakout level. */
  breakoutProximityPct: number;
}

export interface AlertConfig {
  enabled: boolean;
  /** Alert only on these transitions. */
  onTransitions: string[];
  /** Never alert about the same symbol more often than this. */
  minIntervalMs: number;
}

export interface RuntimeConfig {
  capital: number;
  scan: ScanConfig;
  triggers: TriggerConfig;
  alerts: AlertConfig;
  session: { window: SessionWindow; holidays: Set<string>; specialSessions: Set<string> };
  liquidity: LiquidityConfig;
  gates: GateConfig;
  thresholds: DecisionThresholds;
  eventWeights: EventWeights;
  tradeWeights: TradeWeights;
  costs: CostConfig;
  expectedMoves: ExpectedMoveTable;
  /** Minimum closed paper trades before any performance figure is presented. */
  minSampleForValidation: number;
}

export const DEFAULT_SCAN: ScanConfig = {
  intervalMs: 60_000,
  minIntervalMs: 30_000,
  maxDeepAnalysis: 25,
  staleFeedMs: 120_000,
  maxEventAgeMinutes: 240,
};

export const DEFAULT_TRIGGERS: TriggerConfig = {
  volumeRatio: 2.0,
  priceMovePct: 1.5,
  materiality: 0.4,
  breakoutProximityPct: 1.0,
};

export const DEFAULT_ALERTS: AlertConfig = {
  enabled: false,
  onTransitions: [
    'WATCH>PAPER_BUY',
    'IGNORE>PAPER_BUY',
    'PAPER_BUY>INVALIDATED',
    'PAPER_BUY>IGNORE',
    'TARGET_HIT',
    'STOP_HIT',
    'MARKET_HIGH_RISK',
    'FEED_FAILURE',
  ],
  minIntervalMs: 15 * 60_000,
};

function readJson(name: string): Record<string, unknown> | null {
  const path = join(CONFIG_DIR, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function loadConfig(): RuntimeConfig {
  const runtime = readJson('runtime.json') ?? {};
  const holidayFile = readJson('holidays.json') ?? {};

  const scanOverrides = (runtime['scan'] ?? {}) as Partial<ScanConfig>;
  const scan: ScanConfig = { ...DEFAULT_SCAN, ...scanOverrides };
  scan.intervalMs = Math.max(
    scan.minIntervalMs,
    envNumber('SCAN_INTERVAL_MS', scan.intervalMs),
  );

  return {
    capital: envNumber('PAPER_CAPITAL', (runtime['capital'] as number) ?? 10_000),
    scan,
    triggers: { ...DEFAULT_TRIGGERS, ...(runtime['triggers'] as Partial<TriggerConfig>) },
    alerts: {
      ...DEFAULT_ALERTS,
      ...(runtime['alerts'] as Partial<AlertConfig>),
      enabled: envBool(
        'ALERTS_ENABLED',
        ((runtime['alerts'] as Partial<AlertConfig>)?.enabled ?? DEFAULT_ALERTS.enabled),
      ),
    },
    session: {
      window: { ...DEFAULT_SESSION, ...(runtime['sessionWindow'] as Partial<SessionWindow>) },
      holidays: loadHolidays((holidayFile['holidays'] as string[]) ?? []),
      specialSessions: loadHolidays((holidayFile['specialSessions'] as string[]) ?? []),
    },
    liquidity: { ...DEFAULT_LIQUIDITY, ...(runtime['liquidity'] as Partial<LiquidityConfig>) },
    gates: { ...DEFAULT_GATES, ...(runtime['gates'] as Partial<GateConfig>) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(runtime['thresholds'] as Partial<DecisionThresholds>) },
    eventWeights: (readJson('weights.event.json') as unknown as EventWeights) ?? DEFAULT_EVENT_WEIGHTS,
    tradeWeights: (readJson('weights.trade.json') as unknown as TradeWeights) ?? DEFAULT_TRADE_WEIGHTS,
    costs: { ...DEFAULT_COSTS, ...(runtime['costs'] as Partial<CostConfig>) },
    expectedMoves:
      (readJson('expected-moves.json') as unknown as ExpectedMoveTable) ?? BOOTSTRAP_EXPECTED_MOVES,
    minSampleForValidation: envNumber(
      'MIN_SAMPLE_FOR_VALIDATION',
      (runtime['minSampleForValidation'] as number) ?? 30,
    ),
  };
}
