/**
 * XBRL parser for Indian quarterly results filings.
 *
 * Reuses the project's own XML reader. XBRL instance documents are flat: facts
 * are elements carrying a contextRef, a unitRef and a decimals/scale attribute.
 * The work is picking the right context — a filing carries the current quarter,
 * the year-ago quarter, the previous quarter and year-to-date figures side by
 * side, all tagged with the same element names.
 *
 * Choosing the wrong context silently produces a plausible but wrong growth
 * number, so contexts are resolved explicitly and reported.
 */

import { parseXml, type XmlNode } from '../parse/xml.ts';
import { buildLookup, IND_AS_ALIASES, type ElementAliases } from './xbrl-taxonomy.ts';

export class XbrlError extends Error {}

export interface XbrlContext {
  id: string;
  startDate: string | null;
  endDate: string | null;
  /** True when the context has no segment/dimension qualifiers. */
  isPlain: boolean;
  /** Consolidated vs standalone, when the filing distinguishes them. */
  basis: 'CONSOLIDATED' | 'STANDALONE' | 'UNKNOWN';
  /** Duration in days, for telling a quarter from a year-to-date figure. */
  durationDays: number | null;
}

export interface XbrlFact {
  name: string;
  contextRef: string;
  value: number | null;
  raw: string;
}

export interface QuarterlyFinancials {
  periodStart: string | null;
  periodEnd: string | null;
  basis: XbrlContext['basis'];
  revenue: number | null;
  otherIncome: number | null;
  totalIncome: number | null;
  employeeCost: number | null;
  financeCosts: number | null;
  depreciation: number | null;
  otherExpenses: number | null;
  totalExpenses: number | null;
  profitBeforeExceptionalAndTax: number | null;
  exceptionalItems: number | null;
  profitBeforeTax: number | null;
  totalTax: number | null;
  profitAfterTax: number | null;
  eps: number | null;
  /** Derived: PBT + finance costs + depreciation, excluding other income. */
  ebitda: number | null;
  ebitdaMargin: number | null;
  effectiveTaxRate: number | null;
  /** Field names that were not found in the document. */
  missing: string[];
}

export interface ParsedXbrl {
  contexts: XbrlContext[];
  facts: XbrlFact[];
  /** The period the filing is primarily about. */
  current: QuarterlyFinancials | null;
  /** Same quarter one year earlier, when the filing includes it. */
  yearAgo: QuarterlyFinancials | null;
  /** Immediately preceding quarter, when present. */
  previousQuarter: QuarterlyFinancials | null;
  warnings: string[];
}

const CONSOLIDATED = /consolidat/i;
const STANDALONE = /standalone|separate/i;

function daysBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

function parseContexts(root: XmlNode): XbrlContext[] {
  const out: XbrlContext[] = [];

  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      if (child.name === 'context') {
        const id = child.attrs['id'] ?? '';
        const period = child.children.find((c) => c.name === 'period');
        const entity = child.children.find((c) => c.name === 'entity');
        const segment = entity?.children.find((c) => c.name === 'segment');

        const startDate = period?.children.find((c) => c.name === 'startdate')?.text.trim() ?? null;
        const rawEnd =
          period?.children.find((c) => c.name === 'enddate')?.text.trim() ??
          period?.children.find((c) => c.name === 'instant')?.text.trim() ??
          null;

        const segmentText = segment ? JSON.stringify(segment) : '';
        const basis: XbrlContext['basis'] = CONSOLIDATED.test(segmentText)
          ? 'CONSOLIDATED'
          : STANDALONE.test(segmentText)
            ? 'STANDALONE'
            : 'UNKNOWN';

        out.push({
          id,
          startDate,
          endDate: rawEnd,
          isPlain: segment === undefined || segment.children.length === 0,
          basis,
          durationDays: daysBetween(startDate, rawEnd),
        });
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

function parseFacts(root: XmlNode): XbrlFact[] {
  const out: XbrlFact[] = [];

  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      const contextRef = child.attrs['contextref'];
      if (contextRef !== undefined && child.children.length === 0) {
        const raw = child.text.trim();
        // A -0 sign attribute flips the reported value in XBRL.
        const negated = child.attrs['sign'] === '-';
        const numeric = raw === '' ? null : Number(raw.replace(/,/g, ''));
        out.push({
          name: child.name,
          contextRef,
          value:
            numeric !== null && Number.isFinite(numeric)
              ? negated ? -numeric : numeric
              : null,
          raw,
        });
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Quarterly contexts, i.e. durations of roughly three months. */
function isQuarterly(context: XbrlContext): boolean {
  return context.durationDays !== null && context.durationDays >= 80 && context.durationDays <= 100;
}

function buildFinancials(
  facts: readonly XbrlFact[],
  context: XbrlContext,
  aliases: ElementAliases,
): QuarterlyFinancials {
  const lookup = buildLookup(aliases);
  const values = new Map<keyof ElementAliases, number>();

  for (const fact of facts) {
    if (fact.contextRef !== context.id || fact.value === null) continue;
    const field = lookup.get(fact.name.toLowerCase());
    if (field !== undefined && !values.has(field)) values.set(field, fact.value);
  }

  const get = (field: keyof ElementAliases): number | null => values.get(field) ?? null;

  const revenue = get('revenue');
  const otherIncome = get('otherIncome');
  const financeCosts = get('financeCosts');
  const depreciation = get('depreciation');
  const profitBeforeTax = get('profitBeforeTax');
  const exceptionalItems = get('exceptionalItems');
  const totalTax = get('totalTax') ?? sumOrNull(get('currentTax'), get('deferredTax'));
  const profitAfterTax = get('profitAfterTax');
  const pbeit = get('profitBeforeExceptionalAndTax');

  // EBITDA from operations: start from profit before exceptional items and tax
  // where available, add back finance costs and depreciation, and strip other
  // income so a one-off treasury gain cannot inflate the operating figure.
  const operatingBase = pbeit ?? profitBeforeTax;
  const ebitda =
    operatingBase !== null && financeCosts !== null && depreciation !== null
      ? operatingBase + financeCosts + depreciation - (otherIncome ?? 0)
      : null;

  const missing: string[] = [];
  for (const field of [
    'revenue', 'financeCosts', 'depreciation', 'profitBeforeTax', 'profitAfterTax',
  ] as const) {
    if (get(field) === null) missing.push(field);
  }

  return {
    periodStart: context.startDate,
    periodEnd: context.endDate,
    basis: context.basis,
    revenue,
    otherIncome,
    totalIncome: get('totalIncome'),
    employeeCost: get('employeeCost'),
    financeCosts,
    depreciation,
    otherExpenses: get('otherExpenses'),
    totalExpenses: get('totalExpenses'),
    profitBeforeExceptionalAndTax: pbeit,
    exceptionalItems,
    profitBeforeTax,
    totalTax,
    profitAfterTax,
    eps: get('eps'),
    ebitda,
    ebitdaMargin: ebitda !== null && revenue !== null && revenue !== 0
      ? (ebitda / revenue) * 100
      : null,
    effectiveTaxRate:
      totalTax !== null && profitBeforeTax !== null && profitBeforeTax !== 0
        ? (totalTax / profitBeforeTax) * 100
        : null,
    missing,
  };
}

function sumOrNull(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export interface ParseOptions {
  aliases?: ElementAliases;
  /** Prefer consolidated figures where the filing offers both. */
  preferConsolidated?: boolean;
}

export function parseXbrl(xml: string, opts: ParseOptions = {}): ParsedXbrl {
  const aliases = opts.aliases ?? IND_AS_ALIASES;
  const preferConsolidated = opts.preferConsolidated ?? true;
  const warnings: string[] = [];

  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (err) {
    throw new XbrlError(`could not parse XBRL document: ${String(err)}`);
  }

  const contexts = parseContexts(root);
  const facts = parseFacts(root);

  if (contexts.length === 0) throw new XbrlError('document contains no contexts');
  if (facts.length === 0) throw new XbrlError('document contains no facts');

  const quarterly = contexts.filter(isQuarterly);
  if (quarterly.length === 0) {
    warnings.push(
      'no quarterly context found (durations of 80-100 days); the filing may be ' +
        'annual or year-to-date only',
    );
    return { contexts, facts, current: null, yearAgo: null, previousQuarter: null, warnings };
  }

  const wantedBasis = preferConsolidated ? 'CONSOLIDATED' : 'STANDALONE';
  const preferred = quarterly.filter((c) => c.basis === wantedBasis);
  const pool = preferred.length > 0 ? preferred : quarterly.filter((c) => c.basis === 'UNKNOWN');
  const usable = pool.length > 0 ? pool : quarterly;

  if (preferred.length === 0 && quarterly.some((c) => c.basis !== 'UNKNOWN')) {
    warnings.push(`no ${wantedBasis.toLowerCase()} context; fell back to what was available`);
  }

  // Latest period end is the current quarter.
  const sorted = [...usable].sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? ''));
  const currentContext = sorted[0]!;
  const currentEnd = currentContext.endDate;

  const yearAgoContext = currentEnd
    ? sorted.find((c) => {
        const gap = daysBetween(c.endDate, currentEnd);
        return gap !== null && gap >= 350 && gap <= 380;
      })
    : undefined;

  const previousContext = currentEnd
    ? sorted.find((c) => {
        const gap = daysBetween(c.endDate, currentEnd);
        return gap !== null && gap >= 80 && gap <= 100;
      })
    : undefined;

  if (!yearAgoContext) {
    warnings.push('no year-ago quarter in the filing; year-on-year growth cannot be computed');
  }

  return {
    contexts,
    facts,
    current: buildFinancials(facts, currentContext, aliases),
    yearAgo: yearAgoContext ? buildFinancials(facts, yearAgoContext, aliases) : null,
    previousQuarter: previousContext ? buildFinancials(facts, previousContext, aliases) : null,
    warnings,
  };
}
