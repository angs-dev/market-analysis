/**
 * Candidate persistence.
 *
 * Every decision is stored — PAPER_BUY, WATCH, IGNORE and NO_TRADE alike —
 * together with the raw feature vector and every scoring contribution as its
 * own row.
 *
 * Storing rejects is not bookkeeping. Without them, "was the gate right to
 * reject that?" and "what is my false-positive rate?" are unanswerable, and
 * those are the questions that decide whether the algorithm has an edge.
 */

import type { Db } from '../db/driver.ts';
import type { Decision } from '../scoring/decide.ts';
import type { Explanation } from '../scoring/explain.ts';

export interface SavedCandidate {
  candidateId: number;
  contributionsStored: number;
}

export function saveCandidate(db: Db, decision: Decision): SavedCandidate {
  return db.transaction(() => {
    const { lastInsertRowid: candidateId } = db.run(
      `INSERT INTO candidates
         (ts, symbol, event_id, action, event_quality, trade_quality, priced_in_penalty,
          event_buckets_json, trade_buckets_json, event_confidence, trade_confidence,
          gates_passed, gate_results_json, veto_gate, entry_gate_passed, entry_setup_type,
          reaction_shape, priced_in_verdict, regime_label, tier,
          weights_version, feature_schema_version, data_quality_flags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      decision.ts,
      decision.symbol,
      decision.features.meta.eventId,
      decision.action,
      decision.eventQuality.total,
      decision.tradeQuality.total,
      decision.tradeQuality.pricedInPenalty,
      JSON.stringify(decision.eventQuality.buckets),
      JSON.stringify(decision.tradeQuality.buckets),
      decision.eventQuality.confidence,
      decision.tradeQuality.confidence,
      decision.gates.passed ? 1 : 0,
      JSON.stringify(decision.gates.results),
      decision.gates.vetoGate,
      decision.entryGatePassed ? 1 : 0,
      decision.entrySetup,
      null,
      decision.pricedIn.verdict,
      decision.features.regime.label,
      decision.features.meta.tier,
      `${decision.eventQuality.weightsVersion}|${decision.tradeQuality.weightsVersion}`,
      decision.features.meta.schemaVersion,
      JSON.stringify({
        missing: decision.features.meta.missing,
        planFailureReason: decision.planFailureReason,
        summary: decision.summary,
      }),
    );

    // Raw features, verbatim. This is what makes offline re-scoring possible.
    db.run(
      `INSERT INTO candidate_features
         (candidate_id, features_json, missing_json, provenance_json, schema_version)
       VALUES (?, ?, ?, ?, ?)`,
      candidateId,
      JSON.stringify(decision.features),
      JSON.stringify(decision.features.meta.missing),
      JSON.stringify(decision.features.provenance),
      decision.features.meta.schemaVersion,
    );

    for (const e of decision.explanations) {
      db.run(
        `INSERT INTO score_contributions
           (candidate_id, dimension, bucket, feature, raw_value, comparator, threshold,
            points, points_max, direction, rationale, source_ref, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateId,
        e.dimension,
        e.bucket,
        e.feature,
        e.rawValue === null ? null : String(e.rawValue),
        e.comparator,
        String(e.threshold),
        e.pointsAwarded,
        e.pointsMax,
        e.direction,
        e.rationale,
        e.sourceRef,
        e.confidence,
      );
    }

    if (decision.plan !== null) {
      const p = decision.plan;
      db.run(
        `INSERT INTO trade_plans
           (candidate_id, entry_price, quantity, capital_used, stop_loss, target,
            risk_per_share, max_loss, expected_profit, risk_reward, est_costs,
            expected_profit_net, stop_basis, target_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateId,
        p.entryPrice, p.quantity, p.capitalUsed, p.stopLoss, p.target,
        p.riskPerShare, p.maxLoss, p.expectedProfit, p.riskReward,
        p.estimatedCosts, p.expectedProfitNet, p.stopBasis, p.targetBasis,
      );
    }

    return { candidateId, contributionsStored: decision.explanations.length };
  });
}

export interface CandidateSummaryRow {
  action: string;
  count: number;
  avgEventQuality: number | null;
  avgTradeQuality: number | null;
}

export function summariseCandidates(db: Db): CandidateSummaryRow[] {
  return db.all<CandidateSummaryRow>(
    `SELECT action,
            COUNT(*)              AS count,
            AVG(event_quality)    AS avgEventQuality,
            AVG(trade_quality)    AS avgTradeQuality
       FROM candidates
      GROUP BY action
      ORDER BY count DESC`,
  );
}

export interface GateHitRow {
  veto_gate: string;
  count: number;
}

/** Which gates are doing the rejecting — the first input to calibrating them. */
export function gateHitCounts(db: Db): GateHitRow[] {
  return db.all<GateHitRow>(
    `SELECT veto_gate, COUNT(*) AS count
       FROM candidates
      WHERE veto_gate IS NOT NULL
      GROUP BY veto_gate
      ORDER BY count DESC`,
  );
}

/** Loads stored feature vectors for offline re-scoring under new weights. */
export function loadFeaturesForRescore(
  db: Db,
  limit = 10_000,
): { candidateId: number; features: unknown }[] {
  return db
    .all<{ candidate_id: number; features_json: string }>(
      `SELECT candidate_id, features_json FROM candidate_features
        ORDER BY candidate_id LIMIT ?`,
      limit,
    )
    .map((r) => ({ candidateId: r.candidate_id, features: JSON.parse(r.features_json) }));
}

export function explanationsFor(db: Db, candidateId: number): Explanation[] {
  return db
    .all<{
      dimension: string; bucket: string; feature: string; raw_value: string | null;
      comparator: string; threshold: string; points: number; points_max: number;
      direction: string; rationale: string; source_ref: string; confidence: number;
    }>(
      `SELECT * FROM score_contributions WHERE candidate_id = ? ORDER BY id`,
      candidateId,
    )
    .map((r) => ({
      dimension: r.dimension as Explanation['dimension'],
      bucket: r.bucket,
      feature: r.feature,
      rawValue: r.raw_value,
      comparator: r.comparator as Explanation['comparator'],
      threshold: r.threshold,
      pointsAwarded: r.points,
      pointsMax: r.points_max,
      direction: r.direction as Explanation['direction'],
      rationale: r.rationale,
      sourceRef: r.source_ref,
      confidence: r.confidence,
    }));
}
