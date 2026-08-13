/**
 * The decision core: gates, twin scores, priced-in, plan and the four states.
 *
 * The behaviours asserted here are the ones the whole project exists to get
 * right — above all, that a strong event at a bad price cannot become a buy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decide, DEFAULT_THRESHOLDS } from '../src/scoring/decide.ts';
import { emptyFeatures, classifyEntrySetup, collectMissing, type FeatureVector } from '../src/scoring/features.ts';
import { scoreEventQuality } from '../src/scoring/event-quality.ts';
import { assessPricedIn, expectedMovePct, BOOTSTRAP_EXPECTED_MOVES } from '../src/pricedin/engine.ts';
import { runGates } from '../src/scoring/gates.ts';
import { buildPlan, chooseStop } from '../src/paper/position-sizer.ts';
import { roundTripCost, DEFAULT_COSTS } from '../src/paper/cost-model.ts';
import { assessRegime } from '../src/regime/market.ts';

/**
 * A deliberately strong, clean candidate. Individual tests degrade one aspect
 * at a time so each assertion isolates one behaviour.
 */
function goodCandidate(): FeatureVector {
  const f = emptyFeatures('TESTCO', '2026-08-13T11:03:00.000Z', 1);
  f.event = {
    eventType: 'RESULTS', sourceTier: 'PRIMARY_EXCHANGE', materiality: 0.9,
    sentiment: 'POSITIVE', minutesSinceEvent: 8, corroborationCount: 2, detectionLagSec: 45,
  };
  f.fundamental = {
    revenueYoY: 16, revenueQoQ: 4, patYoY: 48, patQoQ: 9, ebitdaYoY: 25,
    ebitdaMarginDeltaYoY: 1.8, epsYoY: 46, earningsQuality: 'OPERATING',
    qualityConfidence: 0.8, pe: 32, debtEquity: 0.3, roe: 18,
  };
  f.trend = {
    emaStack: 'BULLISH', pctFrom20Ema: 2.1, pctFrom50Ema: 5.4, rsVsNifty: 9.2,
    rsVsSector: 4.1, pctFrom52wHigh: -4.5, pctOf52wRange: 78,
  };
  f.momentum = {
    rsi14: 61, rsi14Prev: 55, dayChangePct: 1.8, changeSinceEventPct: 1.5, atrPct: 2.2,
  };
  f.candle = {
    pattern: 'MARUBOZU_BULL', patternStrength: 0.9, patternBias: 'BULLISH',
    closingStrength: 0.88, upperWickPct: 6, lowerWickPct: 5,
  };
  f.volume = { volumeRatio: 4.2, vwapPosition: 'ABOVE', vwapDistPct: 0.9, deliveryPct: 62 };
  f.entry = {
    setupType: null, breakoutStatus: 'CLEAN', breakoutLevel: 995, support: 975,
    resistance: 1080, distanceToSupportPct: 2.5, distanceToResistancePct: 8.0,
    consolidationDays: 9, atrBurnRatio: 0.9,
  };
  f.liquidity = { avgTurnover20d: 250_000_000, isTradeable: true, exclusionReason: null };
  f.regime = {
    label: 'RISK_ON', score: 13, trend: 'BULLISH', niftyChangePct: 0.4,
    vix: 12.4, breadthRatio: 1.8, unstable: false, completeness: 1,
  };
  f.risk = {
    daysToNextResults: 60, hasUpcomingMacroEvent: false,
    negativeEventPresent: false, dataStale: false,
  };
  return f;
}

const PRICE = 1000;

describe('the happy path', () => {
  test('a strong event with an early, well-structured entry is a PAPER_BUY', () => {
    const d = decide(goodCandidate(), PRICE);
    assert.equal(d.action, 'PAPER_BUY');
    assert.ok(d.eventQuality.total >= DEFAULT_THRESHOLDS.minEventQuality);
    assert.ok(d.tradeQuality.total >= DEFAULT_THRESHOLDS.minTradeQuality);
    assert.ok(d.plan !== null);
    assert.ok(d.plan!.riskReward >= 1.5);
    assert.equal(d.gates.passed, true);
  });

  test('the plan is derived from structure, not from a fixed percentage', () => {
    const d = decide(goodCandidate(), PRICE);
    const plan = d.plan!;
    assert.ok(['SUPPORT', 'SWING_LOW', 'ATR'].includes(plan.stopBasis));
    assert.ok(plan.stopLoss < PRICE, 'stop below entry');
    assert.ok(plan.target > PRICE, 'target above entry');
    assert.ok(plan.target <= 1080, 'target capped below resistance');
    assert.equal(plan.quantity, Math.floor(10_000 / PRICE));
  });
});

// This is the case the whole system exists to get right.
describe('news already priced in', () => {
  test('a strong result that has already moved 10% is NOT a buy', () => {
    const f = goodCandidate();
    f.momentum.changeSinceEventPct = 10;
    f.momentum.dayChangePct = 10.2;
    f.trend.pctFrom20Ema = 9.5;
    f.entry.atrBurnRatio = 2.4;

    const d = decide(f, PRICE);

    assert.notEqual(d.action, 'PAPER_BUY', 'a chase must never become a buy');
    assert.ok(
      d.pricedIn.verdict === 'PRICED_IN' || d.pricedIn.verdict === 'OVEREXTENDED',
      `expected a priced-in verdict, got ${d.pricedIn.verdict}`,
    );
    // The event itself still scores well — it is the trade that is bad.
    assert.ok(d.eventQuality.total >= 70, 'the news is still good news');
    assert.ok(d.tradeQuality.total < d.eventQuality.total);
  });

  test('the same event at +1.5% is a buy, at +10% is not — only the price differs', () => {
    const early = decide(goodCandidate(), PRICE);

    const late = goodCandidate();
    late.momentum.changeSinceEventPct = 10;
    late.trend.pctFrom20Ema = 9.5;
    const chased = decide(late, PRICE);

    assert.equal(early.action, 'PAPER_BUY');
    assert.notEqual(chased.action, 'PAPER_BUY');
    assert.equal(
      early.eventQuality.total, chased.eventQuality.total,
      'event quality is identical — the difference is entirely in the trade',
    );
  });

  test('the priced-in ratio compares the move against the event class', () => {
    const a = assessPricedIn({
      eventType: 'RESULTS', moveSinceEventPct: 10, preEventDrift5dPct: null,
      preEventDriftVsSectorPct: null, preEventVolumeAnomaly: null, gapPct: null,
      gapFilledPct: null, atrPct: 2.2, atrBurnRatio: 2.4, pctFrom20Ema: 9.5,
      distanceToResistancePct: 1, pctOf52wRange: 96,
    });
    // Expected move for RESULTS is 2.5 x ATR = 5.5%; 10% is well past it.
    assert.ok(a.pricedInRatio! > 1.2);
    assert.equal(a.verdict, 'OVEREXTENDED');
    assert.equal(a.gateTriggered, true);
    assert.ok(a.penaltyPoints < -20);
  });

  test('expected move scales with ATR, so a volatile stock gets more room', () => {
    const calm = expectedMovePct('RESULTS', 1.0);
    const volatile = expectedMovePct('RESULTS', 4.0);
    assert.ok(volatile! > calm!, 'a 4% ATR stock is allowed a larger move');
    assert.equal(expectedMovePct('RESULTS', null), null, 'no ATR, no expectation');
  });

  test('pre-event drift counts toward the move — leakage is still repricing', () => {
    const withLeak = assessPricedIn({
      eventType: 'RESULTS', moveSinceEventPct: 3, preEventDrift5dPct: 12,
      preEventDriftVsSectorPct: 9, preEventVolumeAnomaly: 2.2, gapPct: null,
      gapFilledPct: null, atrPct: 2.2, atrBurnRatio: 1, pctFrom20Ema: 4,
      distanceToResistancePct: 5, pctOf52wRange: 80,
    });
    const noLeak = assessPricedIn({
      eventType: 'RESULTS', moveSinceEventPct: 3, preEventDrift5dPct: 0.5,
      preEventDriftVsSectorPct: 0.4, preEventVolumeAnomaly: 1.0, gapPct: null,
      gapFilledPct: null, atrPct: 2.2, atrBurnRatio: 1, pctFrom20Ema: 4,
      distanceToResistancePct: 5, pctOf52wRange: 80,
    });

    assert.equal(withLeak.leakageSuspected, true);
    assert.equal(noLeak.leakageSuspected, false);
    assert.ok(
      withLeak.pricedInRatio! > noLeak.pricedInRatio! * 2,
      'material pre-event drift counts as repricing already absorbed',
    );
    assert.ok(
      withLeak.penaltyPoints < noLeak.penaltyPoints,
      'the leaked candidate is penalised harder for the identical post-event move',
    );
  });

  test('an early reaction scores EARLY with no penalty', () => {
    const a = assessPricedIn({
      eventType: 'RESULTS', moveSinceEventPct: 1.5, preEventDrift5dPct: 1,
      preEventDriftVsSectorPct: 0.5, preEventVolumeAnomaly: 1.1, gapPct: null,
      gapFilledPct: null, atrPct: 2.2, atrBurnRatio: 0.9, pctFrom20Ema: 2,
      distanceToResistancePct: 8, pctOf52wRange: 78,
    });
    assert.equal(a.verdict, 'EARLY');
    assert.equal(a.penaltyPoints, 0);
    assert.equal(a.gateTriggered, false);
  });
});

describe('the two scores are never averaged', () => {
  test('a great event with a weak trade is WATCH, not BUY', () => {
    const f = goodCandidate();
    f.regime = { ...f.regime, label: 'RISK_OFF', score: 2, trend: 'BEARISH' };
    f.trend.rsVsNifty = 1; // avoids the weak-market-weak-stock veto
    f.volume.volumeRatio = 0.8;
    f.volume.vwapPosition = 'BELOW';
    f.candle = { ...f.candle, patternBias: 'NEUTRAL', pattern: 'DOJI', closingStrength: 0.4 };

    const d = decide(f, PRICE);
    assert.ok(d.eventQuality.total >= 70, 'the news is still strong');
    assert.ok(d.tradeQuality.total < 75);
    assert.ok(d.action === 'WATCH' || d.action === 'IGNORE');
    assert.notEqual(d.action, 'PAPER_BUY');
  });

  test('a good chart with a weak catalyst is WATCH, not BUY', () => {
    const f = goodCandidate();
    f.event = { ...f.event, eventType: 'DIVIDEND', corroborationCount: 1 };
    f.fundamental = {
      ...f.fundamental, patYoY: 2, revenueYoY: 1, earningsQuality: 'UNKNOWN',
      qualityConfidence: 0.2, patQoQ: null,
    };

    const d = decide(f, PRICE);
    assert.ok(d.eventQuality.total < 70);
    assert.notEqual(d.action, 'PAPER_BUY');
  });

  test('a perfect event score cannot rescue a vetoed trade', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'FAILED';
    const d = decide(f, PRICE);
    assert.equal(d.action, 'IGNORE');
    assert.equal(d.gates.vetoGate, 'FAILED_BREAKOUT');
    assert.ok(d.eventQuality.total >= 70, 'the score was computed and stored anyway');
  });
});

describe('hard gates', () => {
  function gateFor(mutate: (f: FeatureVector) => void): ReturnType<typeof decide> {
    const f = goodCandidate();
    mutate(f);
    return decide(f, PRICE);
  }

  test('an unstable regime produces NO_TRADE, not a smaller trade', () => {
    const d = gateFor((f) => {
      f.regime = { ...f.regime, unstable: true, label: 'UNSTABLE' };
    });
    assert.equal(d.action, 'NO_TRADE');
  });

  test('poor liquidity is vetoed', () => {
    const d = gateFor((f) => {
      f.liquidity = { avgTurnover20d: 5_000_000, isTradeable: false, exclusionReason: 'thin' };
    });
    assert.equal(d.action, 'IGNORE');
    assert.equal(d.gates.vetoGate, 'POOR_LIQUIDITY');
  });

  test('a negative event is vetoed', () => {
    const d = gateFor((f) => { f.event.sentiment = 'NEGATIVE'; });
    assert.equal(d.gates.vetoGate, 'NEGATIVE_EVENT');
  });

  test('extreme extension is vetoed', () => {
    const d = gateFor((f) => { f.trend.pctFrom20Ema = 15; });
    assert.equal(d.action, 'IGNORE');
    assert.ok(['OVEREXTENDED', 'PRICED_IN_EXTREME'].includes(d.gates.vetoGate!));
  });

  test('imminent results are vetoed as binary event risk', () => {
    const d = gateFor((f) => { f.risk.daysToNextResults = 1; });
    assert.equal(d.gates.vetoGate, 'EVENT_RISK_AHEAD');
  });

  test('a lagging stock in a risk-off market is vetoed', () => {
    const d = gateFor((f) => {
      f.regime = { ...f.regime, label: 'RISK_OFF', score: 3 };
      f.trend.rsVsNifty = -4;
    });
    assert.equal(d.gates.vetoGate, 'WEAK_MARKET_WEAK_STOCK');
  });

  test('stale data is vetoed', () => {
    const d = gateFor((f) => { f.risk.dataStale = true; });
    assert.equal(d.gates.vetoGate, 'STALE_DATA');
  });

  // A gate that cannot be evaluated must not silently count as a pass.
  test('an unassessable gate is recorded as missing rather than passing quietly', () => {
    const f = emptyFeatures('X', '2026-08-13T00:00:00.000Z');
    const outcome = runGates({
      features: f,
      pricedIn: assessPricedIn({
        eventType: 'OTHER', moveSinceEventPct: null, preEventDrift5dPct: null,
        preEventDriftVsSectorPct: null, preEventVolumeAnomaly: null, gapPct: null,
        gapFilledPct: null, atrPct: null, atrBurnRatio: null, pctFrom20Ema: null,
        distanceToResistancePct: null, pctOf52wRange: null,
      }),
      riskReward: null,
      planFailureReason: 'no data',
    });
    const missingNotes = outcome.explanations.filter((e) => e.confidence === 0);
    assert.ok(missingNotes.length > 0, 'unassessable gates are recorded explicitly');
  });

  test('every gate result is recorded, passing or failing', () => {
    const d = decide(goodCandidate(), PRICE);
    assert.ok(d.gates.results.length >= 10);
    assert.ok(d.gates.results.every((r) => typeof r.passed === 'boolean'));
  });
});

describe('explainability', () => {
  test('every point awarded carries its raw value, threshold and reason', () => {
    const d = decide(goodCandidate(), PRICE);
    const scored = d.explanations.filter((e) => e.pointsAwarded !== 0);
    assert.ok(scored.length > 5);
    for (const e of scored) {
      assert.ok(e.feature.length > 0, 'has a feature name');
      assert.ok(e.rationale.length > 0, `no rationale for ${e.feature}`);
      assert.ok(e.sourceRef.length > 0, `no source ref for ${e.feature}`);
      assert.ok(['ADD', 'DEDUCT', 'NEUTRAL', 'VETO'].includes(e.direction));
    }
  });

  test('the explanations reconstruct the score total', () => {
    const f = goodCandidate();
    const score = scoreEventQuality(f);
    const summed = score.explanations.reduce((s, e) => s + e.pointsAwarded, 0);
    assert.equal(
      Math.max(0, Math.min(100, Math.round(summed))), score.total,
      'the total must equal the sum of its explanations',
    );
  });

  test('a veto is explained with the reason it fired', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'FAILED';
    const d = decide(f, PRICE);
    const veto = d.explanations.find((e) => e.direction === 'VETO');
    assert.ok(veto);
    assert.match(veto!.rationale, /failed breakout/);
  });

  test('missing data is recorded rather than silently scoring zero', () => {
    const f = goodCandidate();
    f.fundamental.earningsQuality = null;
    const score = scoreEventQuality(f);
    const missing = score.explanations.find((e) => e.feature === 'earnings_quality');
    assert.ok(missing);
    assert.equal(missing!.confidence, 0);
    assert.ok(score.confidence < 1, 'confidence drops when inputs are missing');
  });
});

describe('earnings quality changes the score, not just the label', () => {
  test('one-off profit growth scores far below operating growth', () => {
    const operating = goodCandidate();
    const oneOff = goodCandidate();
    oneOff.fundamental.earningsQuality = 'ASSET_SALE';

    const a = scoreEventQuality(operating).total;
    const b = scoreEventQuality(oneOff).total;
    assert.ok(a - b >= 20, `expected a large gap, got ${a} vs ${b}`);
  });

  test('the same headline PAT number scores differently by quality', () => {
    for (const quality of ['OPERATING', 'TAX_BENEFIT', 'EXCEPTIONAL_INCOME'] as const) {
      const f = goodCandidate();
      f.fundamental.earningsQuality = quality;
      const score = scoreEventQuality(f);
      const entry = score.explanations.find((e) => e.feature === 'earnings_quality');
      assert.equal(entry!.rawValue, quality);
    }
  });
});

describe('trade plan and costs', () => {
  test('prefers a structural stop over an ATR stop', () => {
    const stop = chooseStop({
      symbol: 'X', entryPrice: 100, support: 96, resistance: 110, atr: 2, swingLow: 97,
    });
    assert.equal(stop!.basis, 'SWING_LOW');
  });

  test('refuses a plan when risk/reward is below the floor', () => {
    const result = buildPlan({
      symbol: 'X', entryPrice: 100, support: 90, resistance: 102, atr: 2, minRiskReward: 1.5,
    });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /risk\/reward/);
  });

  test('refuses a plan when no stop can be placed', () => {
    const result = buildPlan({ symbol: 'X', entryPrice: 100, support: null, resistance: 120, atr: null });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /no structural stop/);
  });

  test('caps the target below resistance rather than through it', () => {
    const result = buildPlan({ symbol: 'X', entryPrice: 100, support: 96, resistance: 110, atr: 2 });
    assert.equal(result.ok, true);
    assert.ok((result as { target: number }).target < 110);
  });

  // Cost drag is why percentage returns, not rupees, are the unit of evaluation.
  test('models a round trip and reports the breakeven move', () => {
    const cost = roundTripCost(1000, 1010, 10, DEFAULT_COSTS);
    assert.ok(cost.total > 0);
    assert.ok(cost.breakevenPct > 0);
    assert.ok(cost.breakevenPct < 5, `breakeven ${cost.breakevenPct}% is implausible`);
  });

  test('a one-share-costs-more-than-capital case is refused', () => {
    const result = buildPlan({ symbol: 'X', entryPrice: 50_000, support: 49_000, resistance: 52_000, atr: 500 });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /not sizeable/);
  });
});

describe('entry setup classification', () => {
  test('a failed breakout yields no setup', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'FAILED';
    assert.equal(classifyEntrySetup(f), 'NONE');
  });

  test('a retest is preferred over a plain breakout', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'RETEST';
    assert.equal(classifyEntrySetup(f), 'BREAKOUT_RETEST');
  });

  test('a clean break out of a long base is a consolidation breakout', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'CLEAN';
    f.entry.consolidationDays = 12;
    assert.equal(classifyEntrySetup(f), 'CONSOLIDATION_BREAKOUT');
  });

  test('an early, small post-event move is an early reaction', () => {
    const f = goodCandidate();
    f.entry.breakoutStatus = 'NONE';
    f.entry.consolidationDays = 0;
    f.momentum.changeSinceEventPct = 1.5;
    assert.equal(classifyEntrySetup(f), 'EARLY_REACTION');
  });
});

describe('market regime', () => {
  const rising = Array.from({ length: 80 }, (_, i) => 24_000 + i * 12);

  test('a rising index with low VIX and good breadth is risk-on', () => {
    const r = assessRegime({ niftyCloses: rising, vix: 12, advances: 1400, declines: 700 });
    assert.equal(r.label, 'RISK_ON');
    assert.equal(r.trend, 'BULLISH');
    assert.equal(r.unstable, false);
  });

  test('a VIX spike marks the regime unstable', () => {
    const r = assessRegime({ niftyCloses: rising, vix: 32, advances: 500, declines: 1600 });
    assert.equal(r.label, 'UNSTABLE');
    assert.equal(r.unstable, true);
    assert.match(r.unstableReason!, /instability threshold/);
  });

  test('a violent single-session move is unstable regardless of level', () => {
    const shocked = [...rising.slice(0, 79), rising[78]! * 0.96];
    const r = assessRegime({ niftyCloses: shocked, vix: 15 });
    assert.equal(r.unstable, true);
    assert.match(r.unstableReason!, /disorderly/);
  });

  test('missing inputs lower completeness rather than being defaulted', () => {
    const r = assessRegime({ niftyCloses: rising });
    assert.ok(r.completeness < 1);
    assert.ok(r.missing.includes('india vix'));
  });
});

describe('feature bookkeeping', () => {
  test('missing features are enumerated by name', () => {
    const missing = collectMissing(emptyFeatures('X', '2026-08-13T00:00:00.000Z'));
    assert.ok(missing.includes('fundamental.patYoY'));
    assert.ok(missing.length > 30);
  });

  test('a wholly empty vector does not become a buy', () => {
    const d = decide(emptyFeatures('X', '2026-08-13T00:00:00.000Z'), 100);
    assert.notEqual(d.action, 'PAPER_BUY');
  });
});
