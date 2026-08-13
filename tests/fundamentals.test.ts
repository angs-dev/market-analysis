/**
 * Event classification and earnings quality.
 *
 * The decisive test in this file is the pair of XBRL fixtures that report the
 * SAME headline PAT growth from completely different sources. If the system
 * cannot tell them apart, the event engine is scoring noise.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent, assessMateriality, MATERIAL_TYPES } from '../src/events/classifier.ts';
import { parseXbrl, XbrlError } from '../src/fundamentals/xbrl-parser.ts';
import { assessEarningsQuality, computeGrowth, DOMINANCE_THRESHOLD } from '../src/fundamentals/quality.ts';
import { storeFundamentals, latestFundamentals, toFeatureFundamentals } from '../src/ingest/fundamentals.ts';
import { ingestAnnouncements } from '../src/ingest/events.ts';
import { openDb } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrate.ts';
import { scoreEventQuality } from '../src/scoring/event-quality.ts';
import { emptyFeatures } from '../src/scoring/features.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const OPERATING_XML = readFileSync(join(FIXTURES, 'results_operating.xbrl'), 'utf8');
const ONEOFF_XML = readFileSync(join(FIXTURES, 'results_oneoff.xbrl'), 'utf8');

describe('event classification', () => {
  test('recognises a quarterly results filing', () => {
    const c = classifyEvent('Unaudited Financial Results for the quarter ended 30 June 2026');
    assert.equal(c.eventType, 'RESULTS');
    assert.ok(c.confidence > 0.5);
    assert.ok(c.evidence.length > 0);
  });

  // Announcing that results are coming is not the results.
  test('a notice of a future results meeting is not a results event', () => {
    const c = classifyEvent('Prior intimation of Board Meeting to consider financial results');
    assert.notEqual(c.eventType, 'RESULTS');
  });

  test('recognises order wins in several phrasings', () => {
    for (const headline of [
      'Receipt of order worth Rs 450 crore from NTPC',
      'Company bags contract for metro project',
      'Letter of Award received for highway package',
      'Emerged as lowest bidder for the tender',
    ]) {
      assert.equal(classifyEvent(headline).eventType, 'ORDER_WIN', headline);
    }
  });

  test('separates regulatory approval from regulatory action', () => {
    assert.equal(
      classifyEvent('USFDA approval received for generic product').eventType,
      'REGULATORY_APPROVAL',
    );
    const action = classifyEvent('Receipt of Form 483 observations from USFDA');
    assert.equal(action.eventType, 'REGULATORY_ACTION');
    assert.equal(action.sentiment, 'NEGATIVE');
  });

  test('separates a rating upgrade from a downgrade', () => {
    assert.equal(
      classifyEvent('CRISIL upgrades the rating on long-term facilities').eventType,
      'CREDIT_RATING_UPGRADE',
    );
    assert.equal(
      classifyEvent('ICRA downgrade of credit rating on NCDs').eventType,
      'CREDIT_RATING_DOWNGRADE',
    );
  });

  // Exchanges emit far more housekeeping than news.
  test('filters routine disclosures out as non-events', () => {
    for (const headline of [
      'Newspaper Publication of unaudited financial results',
      'Disclosure under Regulation 30 of SEBI LODR',
      'Shareholding Pattern for the quarter ended June 2026',
      'Intimation of trading window closure',
      'Loss of share certificate',
    ]) {
      const c = classifyEvent(headline);
      assert.equal(c.routine, true, headline);
      assert.equal(assessMateriality(c), 0, `${headline} must have zero materiality`);
    }
  });

  test('an unrecognised headline becomes OTHER with low confidence, not a guess', () => {
    const c = classifyEvent('Some entirely unremarkable corporate communication');
    assert.equal(c.eventType, 'OTHER');
    assert.ok(c.confidence < 0.4);
  });

  test('an empty headline is handled without throwing', () => {
    assert.equal(classifyEvent('').eventType, 'OTHER');
    assert.equal(classifyEvent('').confidence, 0);
  });

  test('excludes unclaimed-dividend housekeeping from dividend events', () => {
    assert.notEqual(
      classifyEvent('Transfer of unclaimed dividend to IEPF').eventType,
      'DIVIDEND',
    );
    assert.equal(classifyEvent('Board recommends final dividend of Rs 5').eventType, 'DIVIDEND');
  });

  test('materiality ranks results above a partnership, and both above routine', () => {
    const results = assessMateriality(classifyEvent('Audited financial results for Q1 FY27'));
    const partnership = assessMateriality(classifyEvent('Strategic partnership with a technology firm'));
    const routine = assessMateriality(classifyEvent('Newspaper publication of results'));
    assert.ok(results > partnership);
    assert.ok(partnership > routine);
    assert.equal(routine, 0);
  });

  test('a negative event type is still material', () => {
    const c = classifyEvent('SEBI order imposing penalty on the company');
    assert.equal(c.sentiment, 'NEGATIVE');
    assert.ok(assessMateriality(c) > 0.5, 'bad news is material news');
    assert.ok(MATERIAL_TYPES.has(c.eventType));
  });

  test('classification is applied at ingest and stored on the event', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    ingestAnnouncements(db, [{
      dedupeKey: 'k1', symbol: 'TESTCO', exchange: 'BSE',
      headline: 'Unaudited financial results for the quarter ended 30 June 2026',
      filedAt: '2026-07-20T05:33:00.000Z', detectedAt: '2026-07-20T05:34:00.000Z',
      sourceId: 'manual_csv', sourceTier: 'PRIMARY_EXCHANGE',
    }]);

    const row = db.get<{ event_type: string; sentiment: string; materiality: number }>(
      'SELECT event_type, sentiment, materiality FROM events',
    );
    assert.equal(row!.event_type, 'RESULTS');
    assert.ok(row!.materiality > 0.5);
    db.close();
  });
});

describe('XBRL parsing', () => {
  test('resolves the current, year-ago and previous quarter contexts', () => {
    const parsed = parseXbrl(OPERATING_XML);
    assert.equal(parsed.current?.periodEnd, '2026-06-30');
    assert.equal(parsed.yearAgo?.periodEnd, '2025-06-30');
    assert.equal(parsed.previousQuarter?.periodEnd, '2026-03-31');
  });

  test('extracts the line items', () => {
    const { current } = parseXbrl(OPERATING_XML);
    assert.equal(current!.revenue, 11600);
    assert.equal(current!.otherIncome, 120);
    assert.equal(current!.financeCosts, 180);
    assert.equal(current!.depreciation, 420);
    assert.equal(current!.profitBeforeTax, 1980);
    assert.equal(current!.profitAfterTax, 1481);
    assert.equal(current!.eps, 7.35);
  });

  // EBITDA excludes other income so a treasury gain cannot inflate it.
  test('derives EBITDA from operations, excluding other income', () => {
    const { current } = parseXbrl(OPERATING_XML);
    // 1980 PBEIT + 180 finance + 420 depreciation - 120 other income = 2460
    assert.equal(current!.ebitda, 2460);
    assert.ok(Math.abs(current!.ebitdaMargin! - (2460 / 11600) * 100) < 1e-9);
  });

  test('computes the effective tax rate', () => {
    const { current } = parseXbrl(OPERATING_XML);
    assert.ok(Math.abs(current!.effectiveTaxRate! - (499 / 1980) * 100) < 1e-9);
  });

  test('computes growth across the resolved periods', () => {
    const parsed = parseXbrl(OPERATING_XML);
    const g = computeGrowth(parsed.current, parsed.yearAgo, parsed.previousQuarter);
    assert.ok(Math.abs(g.revenueYoY! - 16) < 0.01, `revenue YoY ${g.revenueYoY}`);
    assert.ok(Math.abs(g.patYoY! - 48.1) < 0.2, `PAT YoY ${g.patYoY}`);
    assert.ok(g.ebitdaYoY! > 0);
  });

  test('rejects a document with no contexts or no facts', () => {
    assert.throws(() => parseXbrl('<xbrl></xbrl>'), XbrlError);
  });

  test('rejects malformed XML rather than returning partial data', () => {
    assert.throws(() => parseXbrl('<xbrl><unclosed>'), XbrlError);
  });

  test('warns when the year-ago quarter is absent', () => {
    const single = OPERATING_XML.replace(/contextRef="Q_YEAR_AGO"/g, 'contextRef="Q_MISSING"');
    const parsed = parseXbrl(single);
    assert.ok(parsed.yearAgo !== null || parsed.warnings.length > 0);
  });

  test('records which line items were missing', () => {
    const stripped = OPERATING_XML.replace(/<in-bse-fin:FinanceCosts[\s\S]*?<\/in-bse-fin:FinanceCosts>/g, '');
    const { current } = parseXbrl(stripped);
    assert.ok(current!.missing.includes('financeCosts'));
    assert.equal(current!.ebitda, null, 'EBITDA is null rather than wrong');
  });
});

// ── The distinction the whole event engine turns on ─────────────────────────

describe('earnings quality', () => {
  test('operating growth is classified OPERATING', () => {
    const parsed = parseXbrl(OPERATING_XML);
    const v = assessEarningsQuality(parsed.current, parsed.yearAgo);
    assert.equal(v.quality, 'OPERATING');
    assert.equal(v.headlineMisleading, false);
    assert.ok(v.confidence > 0.5);
    assert.match(v.evidence.join(' '), /EBITDA growth/);
  });

  test('the same headline growth from an exceptional gain is NOT operating', () => {
    const parsed = parseXbrl(ONEOFF_XML);
    const v = assessEarningsQuality(parsed.current, parsed.yearAgo);
    assert.equal(v.quality, 'EXCEPTIONAL_INCOME');
    assert.equal(v.headlineMisleading, true);
    assert.match(v.evidence.join(' '), /do not recur/);
  });

  // The decisive comparison.
  test('two filings with identical PAT growth are told apart by their source', () => {
    const operating = parseXbrl(OPERATING_XML);
    const oneOff = parseXbrl(ONEOFF_XML);

    const gOperating = computeGrowth(operating.current, operating.yearAgo, null);
    const gOneOff = computeGrowth(oneOff.current, oneOff.yearAgo, null);

    assert.ok(
      Math.abs(gOperating.patYoY! - gOneOff.patYoY!) < 0.01,
      'headline PAT growth is identical by construction',
    );

    const qOperating = assessEarningsQuality(operating.current, operating.yearAgo);
    const qOneOff = assessEarningsQuality(oneOff.current, oneOff.yearAgo);
    assert.notEqual(qOperating.quality, qOneOff.quality);

    // And that difference must reach the score, not just the label.
    const scoreFor = (quality: typeof qOperating.quality, patYoY: number): number => {
      const f = emptyFeatures('X', '2026-07-20T00:00:00.000Z');
      f.event = {
        eventType: 'RESULTS', sourceTier: 'PRIMARY_EXCHANGE', materiality: 0.9,
        sentiment: 'POSITIVE', minutesSinceEvent: 5, corroborationCount: 2,
        detectionLagSec: 60,
      };
      f.fundamental = {
        ...f.fundamental, patYoY, revenueYoY: 16, patQoQ: 5,
        earningsQuality: quality, qualityConfidence: 0.8,
      };
      return scoreEventQuality(f).total;
    };

    const gap = scoreFor(qOperating.quality, gOperating.patYoY!) -
                scoreFor(qOneOff.quality, gOneOff.patYoY!);
    assert.ok(gap >= 20, `expected a large scoring gap, got ${gap}`);
  });

  test('a lower tax rate driving the growth is classified TAX_BENEFIT', () => {
    // Operations held flat so the tax channel is the only source of growth.
    const parsed = parseXbrl(OPERATING_XML);
    const yearAgo = parsed.yearAgo!;
    const current = {
      ...yearAgo, periodEnd: '2026-06-30',
      totalTax: 67, effectiveTaxRate: 5, profitAfterTax: 1270,
    };
    const v = assessEarningsQuality(current, yearAgo);
    assert.equal(v.quality, 'TAX_BENEFIT');
    assert.equal(v.headlineMisleading, true);
    assert.match(v.evidence.join(' '), /effective tax rate/);
  });

  test('non-operating other income driving the growth is flagged', () => {
    const parsed = parseXbrl(OPERATING_XML);
    const yearAgo = parsed.yearAgo!;
    const current = {
      ...yearAgo,
      periodEnd: '2026-06-30',
      otherIncome: 700,
      profitAfterTax: yearAgo.profitAfterTax! + 590,
      profitBeforeTax: yearAgo.profitBeforeTax! + 590,
    };
    const v = assessEarningsQuality(current, yearAgo);
    assert.ok(['ASSET_SALE', 'ONE_OFF', 'ACCOUNTING'].includes(v.quality));
    assert.equal(v.headlineMisleading, true);
  });

  test('a profit decline is not judged as growth quality', () => {
    const parsed = parseXbrl(OPERATING_XML);
    const current = { ...parsed.current!, profitAfterTax: 500 };
    const v = assessEarningsQuality(current, parsed.yearAgo);
    assert.match(v.evidence.join(' '), /not a growth event/);
  });

  test('missing inputs yield UNKNOWN rather than a confident guess', () => {
    assert.equal(assessEarningsQuality(null, null).quality, 'UNKNOWN');
    assert.equal(assessEarningsQuality(null, null).confidence, 0);

    const parsed = parseXbrl(OPERATING_XML);
    const v = assessEarningsQuality({ ...parsed.current!, profitAfterTax: null }, parsed.yearAgo);
    assert.equal(v.quality, 'UNKNOWN');
  });

  test('the attribution sums to the observed change, with residual explicit', () => {
    const parsed = parseXbrl(OPERATING_XML);
    const { attribution: a } = assessEarningsQuality(parsed.current, parsed.yearAgo);
    const explained =
      (a.operatingContribution ?? 0) + (a.otherIncomeContribution ?? 0) +
      (a.exceptionalContribution ?? 0) + (a.taxContribution ?? 0);
    assert.ok(Math.abs(explained + (a.residual ?? 0) - a.patDelta!) < 1e-6);
  });

  test('dominance requires a majority, not a plurality', () => {
    assert.equal(DOMINANCE_THRESHOLD, 0.5);
  });
});

describe('fundamentals persistence', () => {
  test('stores the quarter with its quality verdict and evidence', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    const stored = storeFundamentals(db, { symbol: 'TESTCO', parsed: parseXbrl(OPERATING_XML) });

    assert.equal(stored!.periodEnd, '2026-06-30');
    const row = db.get<{ earnings_quality: string; quality_evidence_json: string; pat_yoy: number }>(
      'SELECT earnings_quality, quality_evidence_json, pat_yoy FROM fundamentals_quarterly',
    );
    assert.equal(row!.earnings_quality, 'OPERATING');
    assert.ok(Math.abs(row!.pat_yoy - 48.1) < 0.2);
    assert.ok(JSON.parse(row!.quality_evidence_json).evidence.length > 0);
    db.close();
  });

  test('re-storing the same quarter updates in place', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    const parsed = parseXbrl(OPERATING_XML);
    storeFundamentals(db, { symbol: 'TESTCO', parsed });
    storeFundamentals(db, { symbol: 'TESTCO', parsed });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fundamentals_quarterly')!.n, 1);
    db.close();
  });

  // Point-in-time safety: a quarter filed later must be invisible earlier.
  test('latestFundamentals respects the as-of date', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    storeFundamentals(db, {
      symbol: 'TESTCO', parsed: parseXbrl(OPERATING_XML), filedAt: '2026-07-20T05:30:00Z',
    });

    assert.equal(latestFundamentals(db, 'TESTCO', '2026-07-01'), undefined,
      'a quarter filed on 20 July is invisible on 1 July');
    assert.ok(latestFundamentals(db, 'TESTCO', '2026-07-25') !== undefined);
    db.close();
  });

  test('maps stored rows into the feature shape', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    storeFundamentals(db, { symbol: 'TESTCO', parsed: parseXbrl(OPERATING_XML) });

    const f = toFeatureFundamentals(latestFundamentals(db, 'TESTCO'))!;
    assert.equal(f.earningsQuality, 'OPERATING');
    assert.ok(f.patYoY! > 40);
    assert.ok(f.qualityConfidence! > 0.5);
    db.close();
  });

  test('an unparseable filing stores nothing rather than a blank row', () => {
    const db = openDb({ path: ':memory:' });
    migrate(db);
    const empty = { contexts: [], facts: [], current: null, yearAgo: null,
                    previousQuarter: null, warnings: [] };
    assert.equal(storeFundamentals(db, { symbol: 'X', parsed: empty }), null);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fundamentals_quarterly')!.n, 0);
    db.close();
  });
});
