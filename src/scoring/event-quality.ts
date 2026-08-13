/**
 * EVENT QUALITY (0-100): is the news real, material, and durable?
 *
 * Answers only "how good is this information?" — deliberately says nothing
 * about whether the trade is good. That separation is the point: a superb
 * result reported at a terrible price must not be able to score its way into a
 * buy, and splitting the two scores is what makes that structurally impossible.
 *
 * Weights live in config/weights.event.json, not in this file, so they can be
 * re-optimised offline against stored features.
 */

import { Explainer } from './explain.ts';
import type { EarningsQuality, FeatureVector } from './features.ts';

export interface EventWeights {
  version: string;
  buckets: {
    eventType: number;
    magnitude: number;
    earningsQuality: number;
    sourceReliability: number;
    surprise: number;
    corroboration: number;
  };
  /** Event types considered high-impact, and their share of the type bucket. */
  eventTypeTiers: Record<string, number>;
}

export const DEFAULT_EVENT_WEIGHTS: EventWeights = {
  version: 'event-v1',
  buckets: {
    eventType: 20,
    magnitude: 25,
    earningsQuality: 25,
    sourceReliability: 15,
    surprise: 10,
    corroboration: 5,
  },
  eventTypeTiers: {
    RESULTS: 1.0,
    GUIDANCE_UPGRADE: 1.0,
    ORDER_WIN: 0.85,
    ACQUISITION: 0.8,
    REGULATORY_APPROVAL: 0.8,
    CAPACITY_EXPANSION: 0.7,
    DEBT_REDUCTION: 0.7,
    BUYBACK: 0.6,
    PARTNERSHIP: 0.5,
    DIVIDEND: 0.35,
    OTHER: 0.25,
  },
};

export interface EventQualityScore {
  total: number;
  buckets: Record<string, number>;
  confidence: number;
  weightsVersion: string;
  explanations: ReturnType<Explainer['entries']>;
}

/**
 * How earnings quality maps to its share of the bucket.
 *
 * This is the A-versus-B-to-F distinction: profit growth that is operating and
 * recurring is worth full marks, and the same headline number produced by an
 * asset sale or a tax writeback is worth almost nothing, because it will not
 * repeat next quarter.
 */
const QUALITY_FACTOR: Record<EarningsQuality, number> = {
  OPERATING: 1.0,
  ACCOUNTING: 0.25,
  TAX_BENEFIT: 0.15,
  EXCEPTIONAL_INCOME: 0.1,
  ASSET_SALE: 0.05,
  ONE_OFF: 0.05,
  UNKNOWN: 0.4,
};

export function scoreEventQuality(
  f: FeatureVector,
  weights: EventWeights = DEFAULT_EVENT_WEIGHTS,
): EventQualityScore {
  const ex = new Explainer('EVENT');
  const w = weights.buckets;
  const src = 'scoring/event-quality';

  // ── Event type ────────────────────────────────────────────────────────────
  const eventType = f.event.eventType;
  if (eventType !== null) {
    const tier = weights.eventTypeTiers[eventType.toUpperCase()] ?? weights.eventTypeTiers['OTHER'] ?? 0.25;
    ex.add({
      bucket: 'eventType', feature: 'event_type', rawValue: eventType,
      comparator: 'in', threshold: 'tier table',
      points: Math.round(w.eventType * tier), pointsMax: w.eventType,
      rationale: `${eventType} carries a ${(tier * 100).toFixed(0)}% impact weighting`,
      sourceRef: src,
    });
  } else {
    ex.missing('eventType', 'event_type', 'event type not classified', src);
  }

  // ── Magnitude of the fundamental improvement ──────────────────────────────
  const { patYoY, revenueYoY, ebitdaMarginDeltaYoY } = f.fundamental;
  if (patYoY !== null || revenueYoY !== null) {
    let points = 0;
    if (patYoY !== null) {
      const share =
        patYoY >= 50 ? 1 : patYoY >= 25 ? 0.8 : patYoY >= 15 ? 0.55 : patYoY >= 5 ? 0.3 : 0;
      points += Math.round(w.magnitude * 0.6 * share);
      ex.add({
        bucket: 'magnitude', feature: 'pat_yoy', rawValue: Number(patYoY.toFixed(1)),
        comparator: '>=', threshold: 25,
        points: Math.round(w.magnitude * 0.6 * share), pointsMax: Math.round(w.magnitude * 0.6),
        rationale:
          patYoY >= 25 ? 'strong profit growth' :
          patYoY >= 5 ? 'modest profit growth' : 'profit growth is weak or negative',
        sourceRef: src,
      });
    }
    if (revenueYoY !== null) {
      const share =
        revenueYoY >= 20 ? 1 : revenueYoY >= 12 ? 0.75 : revenueYoY >= 6 ? 0.45 : 0;
      points += Math.round(w.magnitude * 0.4 * share);
      ex.add({
        bucket: 'magnitude', feature: 'revenue_yoy', rawValue: Number(revenueYoY.toFixed(1)),
        comparator: '>=', threshold: 12,
        points: Math.round(w.magnitude * 0.4 * share), pointsMax: Math.round(w.magnitude * 0.4),
        rationale:
          // Revenue confirming profit is what separates real growth from cost cutting.
          revenueYoY >= 12 ? 'revenue growth corroborates the profit growth'
            : 'revenue growth is thin — profit may be cost-driven',
        sourceRef: src,
      });
    }
    void points;
  } else {
    ex.missing('magnitude', 'pat_yoy', 'no quarterly financials parsed for this event', src);
  }

  if (ebitdaMarginDeltaYoY !== null) {
    const expanding = ebitdaMarginDeltaYoY > 0.5;
    ex.add({
      bucket: 'magnitude', feature: 'ebitda_margin_delta_yoy',
      rawValue: Number(ebitdaMarginDeltaYoY.toFixed(2)), comparator: '>', threshold: 0.5,
      points: expanding ? 2 : 0, pointsMax: 2,
      rationale: expanding ? 'margins expanding' : 'margins flat or contracting',
      sourceRef: src,
    });
  }

  // ── Earnings quality: recurring versus one-off ────────────────────────────
  const quality = f.fundamental.earningsQuality;
  if (quality !== null) {
    const factor = QUALITY_FACTOR[quality];
    ex.add({
      bucket: 'earningsQuality', feature: 'earnings_quality', rawValue: quality,
      comparator: '==', threshold: 'OPERATING',
      points: Math.round(w.earningsQuality * factor), pointsMax: w.earningsQuality,
      rationale:
        quality === 'OPERATING'
          ? 'growth is operating-driven and can recur'
          : `growth attributed to ${quality} — unlikely to repeat next quarter`,
      sourceRef: src,
      confidence: f.fundamental.qualityConfidence ?? 0.5,
    });
  } else {
    ex.missing(
      'earningsQuality', 'earnings_quality',
      'earnings quality unknown — cannot tell recurring from one-off', src,
    );
  }

  // ── Source reliability ────────────────────────────────────────────────────
  if (f.event.sourceTier !== null) {
    const primary = f.event.sourceTier === 'PRIMARY_EXCHANGE';
    ex.add({
      bucket: 'sourceReliability', feature: 'source_tier', rawValue: f.event.sourceTier,
      comparator: '==', threshold: 'PRIMARY_EXCHANGE',
      points: primary ? w.sourceReliability : Math.round(w.sourceReliability * 0.35),
      pointsMax: w.sourceReliability,
      rationale: primary
        ? 'primary exchange filing — the fact itself'
        : 'secondary news report — corroborating only, not a primary trigger',
      sourceRef: src,
    });
  } else {
    ex.missing('sourceReliability', 'source_tier', 'source tier unknown', src);
  }

  // ── Surprise versus the prior trend ───────────────────────────────────────
  const { patQoQ } = f.fundamental;
  if (patYoY !== null && patQoQ !== null) {
    const accelerating = patYoY > 15 && patQoQ > 0;
    ex.add({
      bucket: 'surprise', feature: 'pat_qoq', rawValue: Number(patQoQ.toFixed(1)),
      comparator: '>', threshold: 0,
      points: accelerating ? w.surprise : Math.round(w.surprise * 0.3), pointsMax: w.surprise,
      rationale: accelerating
        ? 'growth is accelerating sequentially, not just against a weak base'
        : 'sequential trend does not confirm the year-on-year figure',
      sourceRef: src,
    });
  } else {
    ex.missing('surprise', 'pat_qoq', 'sequential comparison unavailable', src);
  }

  // ── Corroboration ─────────────────────────────────────────────────────────
  const corroboration = f.event.corroborationCount;
  if (corroboration !== null) {
    ex.add({
      bucket: 'corroboration', feature: 'corroboration_count', rawValue: corroboration,
      comparator: '>=', threshold: 2,
      points: corroboration >= 2 ? w.corroboration : 0, pointsMax: w.corroboration,
      rationale: corroboration >= 2
        ? `reported by ${corroboration} independent sources`
        : 'single source only',
      sourceRef: src,
    });
  } else {
    ex.missing('corroboration', 'corroboration_count', 'corroboration not counted', src);
  }

  const buckets: Record<string, number> = {};
  for (const bucket of Object.keys(w)) buckets[bucket] = ex.bucketTotal(bucket);

  return {
    total: Math.max(0, Math.min(100, Math.round(ex.total()))),
    buckets,
    confidence: ex.confidence(),
    weightsVersion: weights.version,
    explanations: ex.entries(),
  };
}
