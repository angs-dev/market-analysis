/**
 * Hard rejection gates.
 *
 * Gates run BEFORE scoring and are absolute: no score, however high, survives a
 * veto. This is the mechanism that stops the system talking itself into a bad
 * trade — an 95-point event with a failed breakout is still rejected.
 *
 * Every gate result is recorded, pass or fail, so the false-positive rate of
 * each gate can be measured later against the outcomes of what it rejected.
 */

import { Explainer, type Explanation } from './explain.ts';
import type { FeatureVector } from './features.ts';
import type { PricedInAssessment } from '../pricedin/engine.ts';

export type GateSeverity = 'VETO' | 'DOWNGRADE';

export interface GateConfig {
  minAvgTurnover20d: number;
  maxExtensionFrom20EmaPct: number;
  minRiskReward: number;
  maxDaysToResults: number;
  maxRsi: number;
}

export const DEFAULT_GATES: GateConfig = {
  minAvgTurnover20d: 50_000_000,
  maxExtensionFrom20EmaPct: 12,
  minRiskReward: 1.5,
  maxDaysToResults: 2,
  maxRsi: 85,
};

export interface GateResult {
  id: string;
  passed: boolean;
  severity: GateSeverity;
  reason: string | null;
}

export interface GateOutcome {
  passed: boolean;
  results: GateResult[];
  /** The first veto that fired, if any. */
  vetoGate: string | null;
  explanations: Explanation[];
}

export interface GateInput {
  features: FeatureVector;
  pricedIn: PricedInAssessment;
  riskReward: number | null;
  planFailureReason: string | null;
}

interface GateDef {
  id: string;
  severity: GateSeverity;
  /** Returns a rejection reason, or null to pass. Undefined means not assessable. */
  check(input: GateInput, config: GateConfig): string | null | undefined;
}

const GATES: GateDef[] = [
  {
    id: 'UNSTABLE_REGIME',
    severity: 'VETO',
    check: ({ features }) =>
      features.regime.unstable === true
        ? 'market regime is unstable — no trade, rather than a smaller trade'
        : null,
  },
  {
    id: 'POOR_LIQUIDITY',
    severity: 'VETO',
    check: ({ features }, config) => {
      if (features.liquidity.isTradeable === false) {
        return features.liquidity.exclusionReason ?? 'instrument is not tradeable';
      }
      const turnover = features.liquidity.avgTurnover20d;
      if (turnover === null) return undefined;
      return turnover < config.minAvgTurnover20d
        ? `20-day turnover ${(turnover / 1e7).toFixed(2)} cr is below the ` +
          `${(config.minAvgTurnover20d / 1e7).toFixed(2)} cr floor`
        : null;
    },
  },
  {
    id: 'NEGATIVE_EVENT',
    severity: 'VETO',
    check: ({ features }) => {
      if (features.risk.negativeEventPresent === true) return 'a materially negative event is present';
      return features.event.sentiment === 'NEGATIVE' ? 'event sentiment is negative' : null;
    },
  },
  {
    id: 'FAILED_BREAKOUT',
    severity: 'VETO',
    check: ({ features }) =>
      features.entry.breakoutStatus === 'FAILED'
        ? 'price traded above the level and closed back below it — failed breakout'
        : null,
  },
  {
    id: 'PRICED_IN_EXTREME',
    severity: 'VETO',
    check: ({ pricedIn }) =>
      pricedIn.gateTriggered
        ? pricedIn.pricedInRatio !== null
          ? `${(pricedIn.pricedInRatio * 100).toFixed(0)}% of the expected move has already ` +
            `happened (${pricedIn.verdict})`
          : `price is ${pricedIn.verdict} relative to its structure`
        : null,
  },
  {
    id: 'OVEREXTENDED',
    severity: 'VETO',
    check: ({ features }, config) => {
      const ext = features.trend.pctFrom20Ema;
      if (ext === null) return undefined;
      return ext > config.maxExtensionFrom20EmaPct
        ? `${ext.toFixed(1)}% above the 20 EMA, beyond the ${config.maxExtensionFrom20EmaPct}% limit`
        : null;
    },
  },
  {
    id: 'RISK_REWARD',
    severity: 'VETO',
    check: ({ riskReward, planFailureReason }, config) => {
      if (riskReward === null) {
        return planFailureReason ?? 'no trade plan could be constructed';
      }
      return riskReward < config.minRiskReward
        ? `risk/reward ${riskReward.toFixed(2)} is below the ${config.minRiskReward} minimum`
        : null;
    },
  },
  {
    id: 'EVENT_RISK_AHEAD',
    severity: 'VETO',
    check: ({ features }, config) => {
      const days = features.risk.daysToNextResults;
      if (days === null) return undefined;
      return days <= config.maxDaysToResults
        ? `results due in ${days} day(s) — binary event risk inside the holding horizon`
        : null;
    },
  },
  {
    id: 'WEAK_MARKET_WEAK_STOCK',
    severity: 'VETO',
    check: ({ features }) => {
      const regime = features.regime.label;
      const rs = features.trend.rsVsNifty;
      if (regime === null || rs === null) return undefined;
      return regime === 'RISK_OFF' && rs < 0
        ? 'a lagging stock in a risk-off market — both sides of the trade are against us'
        : null;
    },
  },
  {
    id: 'STALE_DATA',
    severity: 'VETO',
    check: ({ features }) =>
      features.risk.dataStale === true ? 'the underlying data is stale' : null,
  },
  {
    id: 'EXHAUSTED_MOMENTUM',
    severity: 'DOWNGRADE',
    check: ({ features }, config) => {
      const rsi = features.momentum.rsi14;
      if (rsi === null) return undefined;
      return rsi > config.maxRsi
        ? `RSI at ${rsi.toFixed(0)} is beyond ${config.maxRsi} — momentum is exhausted`
        : null;
    },
  },
  {
    id: 'ONE_OFF_EARNINGS',
    severity: 'DOWNGRADE',
    check: ({ features }) => {
      const quality = features.fundamental.earningsQuality;
      if (quality === null || quality === 'UNKNOWN') return undefined;
      return quality !== 'OPERATING'
        ? `profit growth attributed to ${quality} rather than operations`
        : null;
    },
  },
];

export function runGates(input: GateInput, config: GateConfig = DEFAULT_GATES): GateOutcome {
  const ex = new Explainer('GATE');
  const results: GateResult[] = [];
  let vetoGate: string | null = null;

  for (const gate of GATES) {
    const reason = gate.check(input, config);

    // undefined means the gate could not be assessed. It does not pass and it
    // does not fail — recorded honestly rather than counted as a pass.
    if (reason === undefined) {
      results.push({ id: gate.id, passed: true, severity: gate.severity, reason: null });
      ex.missing('gates', gate.id, `${gate.id} not assessable — inputs missing`, 'scoring/gates');
      continue;
    }

    const passed = reason === null;
    results.push({ id: gate.id, passed, severity: gate.severity, reason });

    if (!passed) {
      if (gate.severity === 'VETO') {
        vetoGate ??= gate.id;
        ex.veto({
          bucket: 'gates', feature: gate.id, rawValue: false,
          rationale: reason, sourceRef: 'scoring/gates',
        });
      } else {
        ex.add({
          bucket: 'gates', feature: gate.id, rawValue: false, points: -5,
          rationale: reason, sourceRef: 'scoring/gates',
        });
      }
    }
  }

  return {
    passed: vetoGate === null,
    results,
    vetoGate,
    explanations: ex.entries(),
  };
}
