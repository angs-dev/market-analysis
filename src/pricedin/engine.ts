/**
 * Priced-in engine.
 *
 * The single most important guard in the system. Its job is to answer: has the
 * information already been absorbed by price? A genuinely strong result that
 * the market has already repriced is not an opportunity — it is a chase.
 *
 * Four independent streams of evidence, because "already priced in" has four
 * different causes:
 *   1. Leakage   — it moved BEFORE the announcement
 *   2. Gap       — it repriced before anyone could act
 *   3. Move      — the post-event move versus what this event class warrants
 *   4. Extension — how much structural room is left regardless of the cause
 */

import { Explainer, type Explanation } from '../scoring/explain.ts';

/**
 * Sector-relative pre-event drift below this is treated as noise rather than
 * as information already absorbed into the price.
 */
export const DRIFT_NOISE_FLOOR_PCT = 2;

export type PricedInVerdict = 'EARLY' | 'DEVELOPING' | 'MATURE' | 'PRICED_IN' | 'OVEREXTENDED';

export interface ExpectedMoveTable {
  /** Event type to the typical total move, expressed in ATR multiples. */
  byEventType: Record<string, number>;
  /** Used when the event type is unknown. */
  fallbackAtrMultiple: number;
  /** Confidence in the table itself, until it is derived from real history. */
  confidence: number;
}

export interface PricedInInput {
  eventType: string;
  /** Move since the event was detected, in percent. */
  moveSinceEventPct: number | null;
  /** Cumulative return over the 5 sessions before the event, percent. */
  preEventDrift5dPct: number | null;
  /** The same, measured against the stock's sector index. */
  preEventDriftVsSectorPct: number | null;
  /** Pre-event volume relative to its own 20-day average. */
  preEventVolumeAnomaly: number | null;
  gapPct: number | null;
  gapFilledPct: number | null;
  /** ATR as a percentage of price — the unit that makes moves comparable. */
  atrPct: number | null;
  /** Today's range divided by ATR. */
  atrBurnRatio: number | null;
  pctFrom20Ema: number | null;
  distanceToResistancePct: number | null;
  pctOf52wRange: number | null;
}

export interface PricedInAssessment {
  leakageSuspected: boolean;
  moveSinceEventPct: number | null;
  expectedMovePct: number | null;
  pricedInRatio: number | null;
  expectedMoveConfidence: number;
  verdict: PricedInVerdict;
  /** Points subtracted from trade quality. Negative or zero. */
  penaltyPoints: number;
  /** True when the verdict alone should stop the trade. */
  gateTriggered: boolean;
  explanations: Explanation[];
}

/**
 * Bootstrap table. These are placeholders expressed in ATR multiples, NOT
 * measured values — the real table is derived once ~200 labelled events exist,
 * and until then every assessment carries LOW confidence and says so.
 */
export const BOOTSTRAP_EXPECTED_MOVES: ExpectedMoveTable = {
  byEventType: {
    RESULTS: 2.5,
    GUIDANCE_UPGRADE: 2.5,
    ORDER_WIN: 2.0,
    ACQUISITION: 2.0,
    CAPACITY_EXPANSION: 1.5,
    DEBT_REDUCTION: 1.5,
    BUYBACK: 1.5,
    REGULATORY_APPROVAL: 2.0,
    PARTNERSHIP: 1.2,
    DIVIDEND: 0.8,
    OTHER: 1.2,
  },
  fallbackAtrMultiple: 1.2,
  confidence: 0.3,
};

/** Expected total move for an event class, as a percentage of price. */
export function expectedMovePct(
  eventType: string,
  atrPct: number | null,
  table: ExpectedMoveTable = BOOTSTRAP_EXPECTED_MOVES,
): number | null {
  if (atrPct === null || atrPct <= 0) return null;
  const multiple = table.byEventType[eventType.toUpperCase()] ?? table.fallbackAtrMultiple;
  return atrPct * multiple;
}

function verdictFor(ratio: number): PricedInVerdict {
  if (ratio < 0.35) return 'EARLY';
  if (ratio < 0.65) return 'DEVELOPING';
  if (ratio < 0.9) return 'MATURE';
  if (ratio <= 1.2) return 'PRICED_IN';
  return 'OVEREXTENDED';
}

/** Penalty curve. Deliberately steep past MATURE. */
function penaltyFor(verdict: PricedInVerdict): number {
  switch (verdict) {
    case 'EARLY': return 0;
    case 'DEVELOPING': return -4;
    case 'MATURE': return -14;
    case 'PRICED_IN': return -24;
    case 'OVEREXTENDED': return -32;
  }
}

export function assessPricedIn(
  input: PricedInInput,
  table: ExpectedMoveTable = BOOTSTRAP_EXPECTED_MOVES,
): PricedInAssessment {
  const ex = new Explainer('PRICED_IN');
  const src = 'pricedin/engine';

  // ── 1. Leakage ────────────────────────────────────────────────────────────
  const drift = input.preEventDrift5dPct;
  const driftVsSector = input.preEventDriftVsSectorPct;
  const volAnomaly = input.preEventVolumeAnomaly;
  const leakageSuspected =
    (driftVsSector !== null && driftVsSector > 6) ||
    (drift !== null && drift > 8 && volAnomaly !== null && volAnomaly > 1.8);

  if (leakageSuspected) {
    ex.add({
      bucket: 'leakage', feature: 'pre_event_drift_vs_sector_pct',
      rawValue: driftVsSector ?? drift, comparator: '>', threshold: 6, points: -6,
      rationale: 'ran up ahead of the announcement — the news was likely already known',
      sourceRef: src,
    });
  } else if (drift !== null) {
    ex.add({
      bucket: 'leakage', feature: 'pre_event_drift_5d_pct', rawValue: Number(drift.toFixed(2)),
      comparator: '<=', threshold: 8, points: 0,
      rationale: 'no unusual pre-event run-up', sourceRef: src,
    });
  } else {
    ex.missing('leakage', 'pre_event_drift_5d_pct', 'pre-event history unavailable', src);
  }

  // ── 2. Gap ────────────────────────────────────────────────────────────────
  if (input.gapPct !== null && Math.abs(input.gapPct) > 0.5) {
    const unfilled = input.gapFilledPct !== null ? 100 - input.gapFilledPct : 100;
    ex.add({
      bucket: 'gap', feature: 'gap_pct', rawValue: Number(input.gapPct.toFixed(2)),
      comparator: '>', threshold: 0.5,
      points: input.gapPct > 3 ? -5 : input.gapPct > 1.5 ? -2 : 0,
      rationale:
        `repriced ${input.gapPct.toFixed(2)}% at the open (${unfilled.toFixed(0)}% unfilled) ` +
        'before any entry was possible',
      sourceRef: src,
    });
  }

  // ── 3. Move versus expected ───────────────────────────────────────────────
  const expected = expectedMovePct(input.eventType, input.atrPct, table);
  const move = input.moveSinceEventPct;
  let ratio: number | null = null;

  if (expected !== null && expected > 0 && move !== null) {
    // Pre-event drift is part of the repricing — but only the part that is
    // clearly not noise. Counting every fractional wobble as absorbed news
    // pushes ordinary early entries into DEVELOPING for no reason.
    const leakedMove = Math.max(0, (driftVsSector ?? 0) - DRIFT_NOISE_FLOOR_PCT);
    const absorbed = move + leakedMove;
    ratio = absorbed / expected;
    ex.add({
      bucket: 'move', feature: 'priced_in_ratio', rawValue: Number(ratio.toFixed(2)),
      comparator: ratio > 1.2 ? '>' : '<=', threshold: 1.2,
      points: 0, pointsMax: 0,
      rationale:
        `moved ${absorbed.toFixed(1)}% against ${expected.toFixed(1)}% expected for ` +
        `${input.eventType} at ${(input.atrPct ?? 0).toFixed(1)}% ATR`,
      sourceRef: src, confidence: table.confidence,
    });
  } else {
    ex.missing(
      'move', 'priced_in_ratio',
      expected === null ? 'ATR unavailable, cannot size the expected move' : 'no post-event move measured',
      src,
    );
  }

  // ── 4. Extension ──────────────────────────────────────────────────────────
  if (input.atrBurnRatio !== null && input.atrBurnRatio > 1.5) {
    ex.add({
      bucket: 'extension', feature: 'atr_burn_ratio',
      rawValue: Number(input.atrBurnRatio.toFixed(2)), comparator: '>', threshold: 1.5,
      points: -4,
      rationale: `today's range is ${input.atrBurnRatio.toFixed(1)}x ATR — the move is largely spent`,
      sourceRef: src,
    });
  }
  if (input.pctFrom20Ema !== null && input.pctFrom20Ema > 8) {
    ex.add({
      bucket: 'extension', feature: 'pct_from_20ema',
      rawValue: Number(input.pctFrom20Ema.toFixed(2)), comparator: '>', threshold: 8,
      points: -4,
      rationale: `${input.pctFrom20Ema.toFixed(1)}% above the 20 EMA — stretched, poor entry`,
      sourceRef: src,
    });
  }

  // Ratio drives the verdict; without it, fall back to extension evidence so a
  // missing ATR cannot silently produce an EARLY verdict.
  let verdict: PricedInVerdict;
  if (ratio !== null) {
    verdict = verdictFor(ratio);
  } else if (input.pctFrom20Ema !== null && input.pctFrom20Ema > 10) {
    verdict = 'OVEREXTENDED';
  } else if (input.atrBurnRatio !== null && input.atrBurnRatio > 2) {
    verdict = 'MATURE';
  } else {
    verdict = 'DEVELOPING';
  }

  const penalty = penaltyFor(verdict) + ex.total();
  const gateTriggered = verdict === 'PRICED_IN' || verdict === 'OVEREXTENDED';

  ex.add({
    bucket: 'verdict', feature: 'priced_in_verdict', rawValue: verdict,
    comparator: 'in', threshold: 'EARLY|DEVELOPING|MATURE|PRICED_IN|OVEREXTENDED',
    points: penaltyFor(verdict),
    rationale: gateTriggered
      ? 'the information is already in the price — this is a chase, not an entry'
      : 'sufficient repricing potential remains',
    sourceRef: src,
    confidence: ratio !== null ? table.confidence : 0.2,
  });

  return {
    leakageSuspected,
    moveSinceEventPct: move,
    expectedMovePct: expected,
    pricedInRatio: ratio,
    expectedMoveConfidence: ratio !== null ? table.confidence : 0.2,
    verdict,
    penaltyPoints: Math.min(0, penalty),
    gateTriggered,
    explanations: ex.entries(),
  };
}
