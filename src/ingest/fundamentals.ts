/**
 * Fundamentals persistence.
 *
 * Stores the parsed quarter alongside the earnings-quality verdict and the
 * evidence that produced it, so a later reader can see not just that growth was
 * classified OPERATING but which line items said so.
 */

import type { Db } from '../db/driver.ts';
import { assessEarningsQuality, computeGrowth, type QualityVerdict } from '../fundamentals/quality.ts';
import type { ParsedXbrl, QuarterlyFinancials } from '../fundamentals/xbrl-parser.ts';

export interface StoreFundamentalsInput {
  symbol: string;
  parsed: ParsedXbrl;
  filedAt?: string | null;
  eventId?: number | null;
  sourceId?: string;
  rawPath?: string | null;
}

export interface StoredFundamentals {
  periodEnd: string;
  quality: QualityVerdict;
}

export function storeFundamentals(
  db: Db,
  input: StoreFundamentalsInput,
): StoredFundamentals | null {
  const { current, yearAgo, previousQuarter } = input.parsed;
  if (!current?.periodEnd) return null;

  const growth = computeGrowth(current, yearAgo, previousQuarter);
  const quality = assessEarningsQuality(current, yearAgo);

  db.run(
    `INSERT INTO fundamentals_quarterly
       (symbol, period_end, filed_at, event_id, revenue, ebitda, ebitda_margin,
        pat, eps, other_income, exceptional_items, tax_expense, effective_tax_rate,
        interest, depreciation, revenue_yoy, revenue_qoq, pat_yoy, pat_qoq,
        ebitda_yoy, margin_delta_yoy, eps_yoy, earnings_quality, quality_confidence,
        quality_evidence_json, source_id, raw_xbrl_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, period_end) DO UPDATE SET
       filed_at = excluded.filed_at, event_id = COALESCE(excluded.event_id, fundamentals_quarterly.event_id),
       revenue = excluded.revenue, ebitda = excluded.ebitda, ebitda_margin = excluded.ebitda_margin,
       pat = excluded.pat, eps = excluded.eps, other_income = excluded.other_income,
       exceptional_items = excluded.exceptional_items, tax_expense = excluded.tax_expense,
       effective_tax_rate = excluded.effective_tax_rate, interest = excluded.interest,
       depreciation = excluded.depreciation, revenue_yoy = excluded.revenue_yoy,
       revenue_qoq = excluded.revenue_qoq, pat_yoy = excluded.pat_yoy, pat_qoq = excluded.pat_qoq,
       ebitda_yoy = excluded.ebitda_yoy, margin_delta_yoy = excluded.margin_delta_yoy,
       eps_yoy = excluded.eps_yoy, earnings_quality = excluded.earnings_quality,
       quality_confidence = excluded.quality_confidence,
       quality_evidence_json = excluded.quality_evidence_json,
       source_id = excluded.source_id, raw_xbrl_path = excluded.raw_xbrl_path`,
    input.symbol.toUpperCase(),
    current.periodEnd,
    input.filedAt ?? null,
    input.eventId ?? null,
    current.revenue,
    current.ebitda,
    current.ebitdaMargin,
    current.profitAfterTax,
    current.eps,
    current.otherIncome,
    current.exceptionalItems,
    current.totalTax,
    current.effectiveTaxRate,
    current.financeCosts,
    current.depreciation,
    growth.revenueYoY,
    growth.revenueQoQ,
    growth.patYoY,
    growth.patQoQ,
    growth.ebitdaYoY,
    growth.ebitdaMarginDeltaYoY,
    growth.epsYoY,
    quality.quality,
    quality.confidence,
    JSON.stringify({
      evidence: quality.evidence,
      attribution: quality.attribution,
      headlineMisleading: quality.headlineMisleading,
      parserWarnings: input.parsed.warnings,
    }),
    input.sourceId ?? 'bse_xbrl',
    input.rawPath ?? null,
  );

  return { periodEnd: current.periodEnd, quality };
}

export interface FundamentalsRow {
  revenue_yoy: number | null;
  revenue_qoq: number | null;
  pat_yoy: number | null;
  pat_qoq: number | null;
  ebitda_yoy: number | null;
  margin_delta_yoy: number | null;
  eps_yoy: number | null;
  earnings_quality: string | null;
  quality_confidence: number | null;
  period_end: string;
}

/** Most recent quarter filed on or before `asOf`. Point-in-time safe. */
export function latestFundamentals(
  db: Db,
  symbol: string,
  asOf?: string,
): FundamentalsRow | undefined {
  if (asOf) {
    return db.get<FundamentalsRow>(
      `SELECT revenue_yoy, revenue_qoq, pat_yoy, pat_qoq, ebitda_yoy, margin_delta_yoy,
              eps_yoy, earnings_quality, quality_confidence, period_end
         FROM fundamentals_quarterly
        WHERE symbol = ?
          AND substr(COALESCE(filed_at, period_end), 1, 10) <= ?
        ORDER BY period_end DESC LIMIT 1`,
      symbol.toUpperCase(),
      asOf.slice(0, 10),
    );
  }
  return db.get<FundamentalsRow>(
    `SELECT revenue_yoy, revenue_qoq, pat_yoy, pat_qoq, ebitda_yoy, margin_delta_yoy,
            eps_yoy, earnings_quality, quality_confidence, period_end
       FROM fundamentals_quarterly
      WHERE symbol = ? ORDER BY period_end DESC LIMIT 1`,
    symbol.toUpperCase(),
  );
}

/** Shape the feature builder consumes. */
export function toFeatureFundamentals(row: FundamentalsRow | undefined): {
  revenueYoY: number | null;
  revenueQoQ: number | null;
  patYoY: number | null;
  patQoQ: number | null;
  ebitdaYoY: number | null;
  ebitdaMarginDeltaYoY: number | null;
  epsYoY: number | null;
  earningsQuality: QualityVerdict['quality'] | null;
  qualityConfidence: number | null;
} | undefined {
  if (!row) return undefined;
  return {
    revenueYoY: row.revenue_yoy,
    revenueQoQ: row.revenue_qoq,
    patYoY: row.pat_yoy,
    patQoQ: row.pat_qoq,
    ebitdaYoY: row.ebitda_yoy,
    ebitdaMarginDeltaYoY: row.margin_delta_yoy,
    epsYoY: row.eps_yoy,
    earningsQuality: (row.earnings_quality as QualityVerdict['quality'] | null) ?? null,
    qualityConfidence: row.quality_confidence,
  };
}
