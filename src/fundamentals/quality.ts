/**
 * Earnings quality: is the profit growth operating and recurring, or not?
 *
 * This is the distinction the whole event engine turns on. A +48% PAT produced
 * by selling land looks identical to a +48% PAT produced by selling more
 * product — until next quarter, when only one of them repeats. Scoring them
 * the same is the single most expensive mistake an earnings-driven system can
 * make, so the growth is decomposed into its sources rather than taken at face
 * value.
 *
 * Method: attribute the year-on-year change in profit before tax across four
 * channels, then classify by whichever dominates.
 *
 *   operating   = change in EBITDA
 *   otherIncome = change in non-operating income
 *   exceptional = change in exceptional items
 *   tax         = effect of a change in the effective tax rate (on PAT)
 *
 * Anything the four channels do not explain is residual, and a large residual
 * lowers confidence rather than being quietly assigned somewhere.
 */

import type { QuarterlyFinancials } from './xbrl-parser.ts';

export type EarningsQuality =
  | 'OPERATING'
  | 'ONE_OFF'
  | 'EXCEPTIONAL_INCOME'
  | 'TAX_BENEFIT'
  | 'ASSET_SALE'
  | 'ACCOUNTING'
  | 'UNKNOWN';

export interface QualityAttribution {
  /** Change in PAT year on year, absolute. */
  patDelta: number | null;
  operatingContribution: number | null;
  otherIncomeContribution: number | null;
  exceptionalContribution: number | null;
  taxContribution: number | null;
  residual: number | null;
  /** Each channel's share of the absolute total attribution, 0..1. */
  shares: Record<string, number>;
}

export interface QualityVerdict {
  quality: EarningsQuality;
  /** 0..1. Low when inputs were missing or the residual was large. */
  confidence: number;
  attribution: QualityAttribution;
  /** Human-readable reasons, for the explanation trail. */
  evidence: string[];
  /** True when the headline growth would mislead without this decomposition. */
  headlineMisleading: boolean;
}

const UNKNOWN: QualityVerdict = {
  quality: 'UNKNOWN',
  confidence: 0,
  attribution: {
    patDelta: null, operatingContribution: null, otherIncomeContribution: null,
    exceptionalContribution: null, taxContribution: null, residual: null, shares: {},
  },
  evidence: ['insufficient data to decompose profit growth'],
  headlineMisleading: false,
};

/** Share of the total absolute attribution above which a channel dominates. */
export const DOMINANCE_THRESHOLD = 0.5;

export function assessEarningsQuality(
  current: QuarterlyFinancials | null,
  yearAgo: QuarterlyFinancials | null,
): QualityVerdict {
  if (!current || !yearAgo) return UNKNOWN;
  if (current.profitAfterTax === null || yearAgo.profitAfterTax === null) return UNKNOWN;

  const evidence: string[] = [];
  const patDelta = current.profitAfterTax - yearAgo.profitAfterTax;

  // ── Channel contributions ────────────────────────────────────────────────
  const operating =
    current.ebitda !== null && yearAgo.ebitda !== null ? current.ebitda - yearAgo.ebitda : null;

  const otherIncome =
    current.otherIncome !== null && yearAgo.otherIncome !== null
      ? current.otherIncome - yearAgo.otherIncome
      : null;

  const exceptional =
    current.exceptionalItems !== null || yearAgo.exceptionalItems !== null
      ? (current.exceptionalItems ?? 0) - (yearAgo.exceptionalItems ?? 0)
      : null;

  // A lower effective tax rate lifts PAT without any operating improvement.
  const taxEffect =
    current.effectiveTaxRate !== null &&
    yearAgo.effectiveTaxRate !== null &&
    current.profitBeforeTax !== null
      ? ((yearAgo.effectiveTaxRate - current.effectiveTaxRate) / 100) * current.profitBeforeTax
      : null;

  const channels: [string, number | null][] = [
    ['operating', operating],
    ['otherIncome', otherIncome],
    ['exceptional', exceptional],
    ['tax', taxEffect],
  ];

  const known = channels.filter(([, v]) => v !== null) as [string, number][];
  if (known.length === 0) return UNKNOWN;

  const explained = known.reduce((s, [, v]) => s + v, 0);
  const residual = patDelta - explained;

  const totalAbs = known.reduce((s, [, v]) => s + Math.abs(v), 0) + Math.abs(residual);
  const shares: Record<string, number> = {};
  for (const [name, value] of known) {
    shares[name] = totalAbs > 0 ? Math.abs(value) / totalAbs : 0;
  }
  shares['residual'] = totalAbs > 0 ? Math.abs(residual) / totalAbs : 0;

  const attribution: QualityAttribution = {
    patDelta,
    operatingContribution: operating,
    otherIncomeContribution: otherIncome,
    exceptionalContribution: exceptional,
    taxContribution: taxEffect,
    residual,
    shares,
  };

  // ── Classification ───────────────────────────────────────────────────────
  // Only channels that pushed profit UP can explain profit growth. A channel
  // that dragged is not the source of the improvement.
  const positiveChannels = known.filter(([, v]) => v > 0);
  const positiveTotal = positiveChannels.reduce((s, [, v]) => s + Math.abs(v), 0);

  const shareOf = (name: string): number => {
    const found = positiveChannels.find(([n]) => n === name);
    return found && positiveTotal > 0 ? Math.abs(found[1]) / positiveTotal : 0;
  };

  const operatingShare = shareOf('operating');
  const exceptionalShare = shareOf('exceptional');
  const otherIncomeShare = shareOf('otherIncome');
  const taxShare = shareOf('tax');

  let quality: EarningsQuality;
  let headlineMisleading = false;

  if (patDelta <= 0) {
    // Not a growth story; report what drove the decline rather than judging quality.
    quality = operating !== null && operating < 0 ? 'OPERATING' : 'UNKNOWN';
    evidence.push(
      `profit fell by ${Math.abs(patDelta).toFixed(0)} year on year — this is not a growth event`,
    );
  } else if (exceptionalShare >= DOMINANCE_THRESHOLD) {
    // Exceptional gains are the classic dressed-up quarter.
    quality = 'EXCEPTIONAL_INCOME';
    headlineMisleading = true;
    evidence.push(
      `${(exceptionalShare * 100).toFixed(0)}% of the profit increase came from exceptional ` +
        'items, which by definition do not recur',
    );
  } else if (taxShare >= DOMINANCE_THRESHOLD) {
    quality = 'TAX_BENEFIT';
    headlineMisleading = true;
    evidence.push(
      `effective tax rate fell from ${yearAgo.effectiveTaxRate?.toFixed(1)}% to ` +
        `${current.effectiveTaxRate?.toFixed(1)}%, which accounts for ` +
        `${(taxShare * 100).toFixed(0)}% of the increase`,
    );
  } else if (otherIncomeShare >= DOMINANCE_THRESHOLD) {
    // Non-operating income: treasury gains, asset sales booked above the line.
    quality = 'ASSET_SALE';
    headlineMisleading = true;
    evidence.push(
      `${(otherIncomeShare * 100).toFixed(0)}% of the increase came from non-operating ` +
        'other income rather than from the business',
    );
  } else if (operatingShare >= DOMINANCE_THRESHOLD) {
    quality = 'OPERATING';
    evidence.push(
      `${(operatingShare * 100).toFixed(0)}% of the profit increase came from EBITDA growth`,
    );
    if (current.ebitdaMargin !== null && yearAgo.ebitdaMargin !== null) {
      const delta = current.ebitdaMargin - yearAgo.ebitdaMargin;
      evidence.push(
        delta > 0
          ? `EBITDA margin expanded ${delta.toFixed(2)} points`
          : `EBITDA margin contracted ${Math.abs(delta).toFixed(2)} points despite the profit growth`,
      );
    }
  } else if (shares['residual']! >= DOMINANCE_THRESHOLD) {
    quality = 'ACCOUNTING';
    headlineMisleading = true;
    evidence.push(
      'most of the profit change cannot be traced to operations, other income, ' +
        'exceptional items or tax — the driver is not visible in the headline lines',
    );
  } else {
    // Several channels contributed, none dominant.
    quality = 'ONE_OFF';
    evidence.push(
      'no single source accounts for the majority of the increase; the growth is ' +
        'mixed and not clearly operating-driven',
    );
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const coverage = known.length / channels.length;
  const residualPenalty = Math.min(1, shares['residual'] ?? 0);
  let confidence = Math.max(0, Math.min(1, coverage * (1 - residualPenalty * 0.8)));

  if (current.missing.length > 0) {
    confidence *= 0.8;
    evidence.push(`missing line items: ${current.missing.join(', ')}`);
  }
  if (operating === null) {
    evidence.push('EBITDA could not be derived, so the operating channel is unmeasured');
  }

  return { quality, confidence, attribution, evidence, headlineMisleading };
}

/** Growth metrics from consecutive periods. Null where either side is missing. */
export interface GrowthMetrics {
  revenueYoY: number | null;
  revenueQoQ: number | null;
  patYoY: number | null;
  patQoQ: number | null;
  ebitdaYoY: number | null;
  ebitdaMarginDeltaYoY: number | null;
  epsYoY: number | null;
}

function growth(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  // A sign flip makes percentage growth meaningless (loss to profit).
  if (prior < 0) return null;
  return ((current - prior) / prior) * 100;
}

export function computeGrowth(
  current: QuarterlyFinancials | null,
  yearAgo: QuarterlyFinancials | null,
  previousQuarter: QuarterlyFinancials | null,
): GrowthMetrics {
  return {
    revenueYoY: growth(current?.revenue ?? null, yearAgo?.revenue ?? null),
    revenueQoQ: growth(current?.revenue ?? null, previousQuarter?.revenue ?? null),
    patYoY: growth(current?.profitAfterTax ?? null, yearAgo?.profitAfterTax ?? null),
    patQoQ: growth(current?.profitAfterTax ?? null, previousQuarter?.profitAfterTax ?? null),
    ebitdaYoY: growth(current?.ebitda ?? null, yearAgo?.ebitda ?? null),
    ebitdaMarginDeltaYoY:
      current?.ebitdaMargin != null && yearAgo?.ebitdaMargin != null
        ? current.ebitdaMargin - yearAgo.ebitdaMargin
        : null,
    epsYoY: growth(current?.eps ?? null, yearAgo?.eps ?? null),
  };
}
