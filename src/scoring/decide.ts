/**
 * The decision engine.
 *
 * Composes gates, both scores, the entry gate and the trade plan into one of
 * four states. The ordering matters and is deliberate:
 *
 *   1. Gates first  — no score can override a veto.
 *   2. Both floors  — the two scores are never averaged. A 95-point event with
 *                     40-point trade quality is a WATCH, not a BUY.
 *   3. Entry gate   — a good score with no entry structure is still a WATCH.
 *
 * A score alone can never produce PAPER_BUY. That is the whole design.
 */

import { runGates, type GateConfig, type GateOutcome, DEFAULT_GATES } from './gates.ts';
import { scoreEventQuality, type EventQualityScore, type EventWeights, DEFAULT_EVENT_WEIGHTS } from './event-quality.ts';
import { scoreTradeQuality, type TradeQualityScore, type TradeWeights, DEFAULT_TRADE_WEIGHTS } from './trade-quality.ts';
import { assessPricedIn, type ExpectedMoveTable, type PricedInAssessment, BOOTSTRAP_EXPECTED_MOVES } from '../pricedin/engine.ts';
import { buildPlan, type PlanResult, type TradePlan } from '../paper/position-sizer.ts';
import { classifyEntrySetup, collectMissing, type FeatureVector } from './features.ts';
import type { Explanation } from './explain.ts';
import type { CostConfig } from '../paper/cost-model.ts';

export type Action = 'PAPER_BUY' | 'WATCH' | 'IGNORE' | 'NO_TRADE';

export interface DecisionThresholds {
  /** Event quality floor for a buy. */
  minEventQuality: number;
  /** Trade quality floor for a buy. */
  minTradeQuality: number;
  /** Either score at or above this puts a rejected candidate on the watchlist. */
  watchFloor: number;
  minRiskReward: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  minEventQuality: 70,
  minTradeQuality: 75,
  watchFloor: 55,
  minRiskReward: 1.5,
};

export interface DecideConfig {
  thresholds?: DecisionThresholds;
  gates?: GateConfig;
  eventWeights?: EventWeights;
  tradeWeights?: TradeWeights;
  expectedMoves?: ExpectedMoveTable;
  costs?: CostConfig;
  capital?: number;
}

export interface Decision {
  action: Action;
  symbol: string;
  ts: string;
  eventQuality: EventQualityScore;
  tradeQuality: TradeQualityScore;
  pricedIn: PricedInAssessment;
  gates: GateOutcome;
  entrySetup: string;
  entryGatePassed: boolean;
  plan: TradePlan | null;
  planFailureReason: string | null;
  /** The complete audit trail, in evaluation order. */
  explanations: Explanation[];
  /** One line per reason, for alerts and the CLI. */
  summary: string[];
  features: FeatureVector;
}

/**
 * Builds the trade plan from structure. Never invents levels.
 *
 * Entry is the last traded price — the price actually available now. A retest
 * setup could arguably enter at the level itself, but assuming a fill at a
 * better price than the market is showing is how a backtest flatters itself.
 */
function planFor(f: FeatureVector, entryPrice: number, config: DecideConfig): PlanResult {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, reason: 'no usable entry price for this candidate' };
  }

  const atr = f.momentum.atrPct !== null ? (f.momentum.atrPct / 100) * entryPrice : null;

  return buildPlan({
    symbol: f.meta.symbol,
    entryPrice,
    support: f.entry.support,
    resistance: f.entry.resistance,
    atr,
    capital: config.capital,
    costs: config.costs,
    minRiskReward: config.thresholds?.minRiskReward ?? DEFAULT_THRESHOLDS.minRiskReward,
  });
}

export function decide(
  features: FeatureVector,
  lastClose: number,
  config: DecideConfig = {},
): Decision {
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;

  const f: FeatureVector = {
    ...features,
    meta: { ...features.meta, missing: collectMissing(features) },
    entry: { ...features.entry },
  };
  if (f.entry.setupType === null) f.entry.setupType = classifyEntrySetup(f);

  // ── Priced-in assessment ──────────────────────────────────────────────────
  const pricedIn = assessPricedIn(
    {
      eventType: f.event.eventType ?? 'OTHER',
      moveSinceEventPct: f.momentum.changeSinceEventPct,
      preEventDrift5dPct: null,
      preEventDriftVsSectorPct: null,
      preEventVolumeAnomaly: null,
      gapPct: null,
      gapFilledPct: null,
      atrPct: f.momentum.atrPct,
      atrBurnRatio: f.entry.atrBurnRatio,
      pctFrom20Ema: f.trend.pctFrom20Ema,
      distanceToResistancePct: f.entry.distanceToResistancePct,
      pctOf52wRange: f.trend.pctOf52wRange,
    },
    config.expectedMoves ?? BOOTSTRAP_EXPECTED_MOVES,
  );

  // ── Trade plan ────────────────────────────────────────────────────────────
  const planResult = planFor(f, lastClose, config);
  const plan = planResult.ok ? (planResult as { ok: true } & TradePlan) : null;
  const planFailureReason = planResult.ok ? null : planResult.reason;
  const riskReward = plan?.riskReward ?? null;

  // ── Gates, before any score can matter ────────────────────────────────────
  const gates = runGates(
    { features: f, pricedIn, riskReward, planFailureReason },
    config.gates ?? DEFAULT_GATES,
  );

  // ── Scores. Computed even when gates fail, so rejected candidates carry
  //    their full scoring record and the gates can be evaluated later. ───────
  const eventQuality = scoreEventQuality(f, config.eventWeights ?? DEFAULT_EVENT_WEIGHTS);
  const tradeQuality = scoreTradeQuality(
    { features: f, pricedIn, riskReward },
    config.tradeWeights ?? DEFAULT_TRADE_WEIGHTS,
  );

  const entrySetup = f.entry.setupType ?? 'NONE';
  const entryGatePassed = entrySetup !== 'NONE' && plan !== null;

  // ── Resolve the action ────────────────────────────────────────────────────
  let action: Action;
  const summary: string[] = [];

  if (f.regime.unstable === true) {
    action = 'NO_TRADE';
    summary.push(f.regime.label === 'UNSTABLE'
      ? 'Market regime is unstable — standing aside.'
      : 'Conditions do not permit a trade.');
  } else if (!gates.passed) {
    action = 'IGNORE';
    const veto = gates.results.find((r) => r.id === gates.vetoGate);
    summary.push(`Rejected by ${gates.vetoGate}: ${veto?.reason ?? 'gate failed'}`);
  } else if (
    eventQuality.total >= thresholds.minEventQuality &&
    tradeQuality.total >= thresholds.minTradeQuality &&
    entryGatePassed &&
    riskReward !== null &&
    riskReward >= thresholds.minRiskReward
  ) {
    action = 'PAPER_BUY';
    summary.push(
      `Event ${eventQuality.total}/100 and trade ${tradeQuality.total}/100 both clear their ` +
        `floors, with a ${entrySetup} entry at ${riskReward.toFixed(1)}:1.`,
    );
  } else if (
    eventQuality.total >= thresholds.minEventQuality &&
    tradeQuality.total < thresholds.minTradeQuality
  ) {
    action = 'WATCH';
    summary.push(
      `Good news, poor trade: event ${eventQuality.total}/100 but trade only ` +
        `${tradeQuality.total}/100 (floor ${thresholds.minTradeQuality}).`,
    );
  } else if (
    tradeQuality.total >= thresholds.minTradeQuality &&
    eventQuality.total < thresholds.minEventQuality
  ) {
    action = 'WATCH';
    summary.push(
      `Good chart, weak catalyst: trade ${tradeQuality.total}/100 but event only ` +
        `${eventQuality.total}/100 (floor ${thresholds.minEventQuality}).`,
    );
  } else if (!entryGatePassed && eventQuality.total >= thresholds.minEventQuality) {
    action = 'WATCH';
    summary.push(
      planFailureReason ?? 'No entry structure — worth watching for a better entry.',
    );
  } else if (
    eventQuality.total >= thresholds.watchFloor ||
    tradeQuality.total >= thresholds.watchFloor
  ) {
    action = 'WATCH';
    summary.push(
      `Neither score clears its floor (event ${eventQuality.total}, trade ${tradeQuality.total}).`,
    );
  } else {
    action = 'IGNORE';
    summary.push(
      `Below the watchlist floor (event ${eventQuality.total}, trade ${tradeQuality.total}).`,
    );
  }

  if (planFailureReason !== null && action !== 'IGNORE') {
    summary.push(`No trade plan: ${planFailureReason}`);
  }

  return {
    action,
    symbol: f.meta.symbol,
    ts: f.meta.ts,
    eventQuality,
    tradeQuality,
    pricedIn,
    gates,
    entrySetup,
    entryGatePassed,
    plan,
    planFailureReason,
    explanations: [
      ...gates.explanations,
      ...eventQuality.explanations,
      ...pricedIn.explanations,
      ...tradeQuality.explanations,
    ],
    summary,
    features: f,
  };
}
