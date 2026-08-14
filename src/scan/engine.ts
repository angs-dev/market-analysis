/**
 * ScanEngine — the orchestrator.
 *
 * Reproduces the workflow of asking an analyst to "scan the news and the
 * market right now". It owns no scoring logic of its own: every judgement is
 * delegated to the engines built in earlier milestones, and this file is
 * responsible only for sequencing them, deciding what deserves deep analysis,
 * and assembling a ScanResult.
 *
 * The same code path serves the local scheduler, `scan:once` in GitHub
 * Actions, and a manual dashboard trigger. There is exactly one scoring
 * implementation, so a signal cannot differ by execution mode.
 */

import type { Db } from '../db/driver.ts';
import type { RuntimeConfig } from '../config/index.ts';
import { marketSession, type SessionState } from '../market/session.ts';
import { readCandles } from '../ingest/candles.ts';
import { saveCandidate } from '../ingest/candidates.ts';
import { latestFundamentals, toFeatureFundamentals } from '../ingest/fundamentals.ts';
import { buildFeatures } from '../scoring/build-features.ts';
import { decide, type Decision } from '../scoring/decide.ts';
import { assessRegime, type RegimeResult } from '../regime/market.ts';
import { screen, symbolsWithOpenPositions } from './screener.ts';
import { classifyExtension } from './extension.ts';
import { buildFreshness } from './freshness.ts';
import type {
  CandidateEvent, ScanCandidate, ScanEnvelope, ScanEventName, ScanMarketRegime,
  ScanMode, ScanResult, ScanTrigger, ScreenHit,
} from './types.ts';

export interface ScanEngineDeps {
  db: Db;
  config: RuntimeConfig;
  /** Emits progress for the real-time UI channel. Optional. */
  emit?: (envelope: ScanEnvelope) => void;
  now?: () => Date;
  benchmarkSymbol?: string;
}

export interface ScanOptions {
  mode: ScanMode;
  trigger: ScanTrigger;
  /** Restrict to these symbols, bypassing stage 1. */
  symbols?: string[];
  /** Scan even when the market is closed. Used by replay and manual runs. */
  ignoreMarketHours?: boolean;
}

interface EventRow {
  id: number;
  symbol: string;
  event_type: string | null;
  source_tier: string | null;
  sentiment: string | null;
  materiality: number | null;
  headline: string;
  filed_at: string | null;
  detected_at: string | null;
  detection_lag_sec: number | null;
}

export class ScanEngine {
  readonly #db: Db;
  readonly #config: RuntimeConfig;
  readonly #emit: (envelope: ScanEnvelope) => void;
  readonly #now: () => Date;
  readonly #benchmark: string;

  constructor(deps: ScanEngineDeps) {
    this.#db = deps.db;
    this.#config = deps.config;
    this.#emit = deps.emit ?? ((): void => {});
    this.#now = deps.now ?? ((): Date => new Date());
    this.#benchmark = deps.benchmarkSymbol ?? 'NIFTY_50';
  }

  #send(name: ScanEventName, payload: unknown): void {
    this.#emit({ name, ts: this.#now().toISOString(), payload });
  }

  session(): SessionState {
    return marketSession(this.#now(), {
      window: this.#config.session.window,
      holidays: this.#config.session.holidays,
      specialSessions: this.#config.session.specialSessions,
    });
  }

  /** Runs one complete cycle. Never throws; failures are returned in the result. */
  async scanNow(opts: ScanOptions): Promise<ScanResult> {
    const startedAt = this.#now();
    const session = this.session();
    this.#send('scan:started', { mode: opts.mode, marketStatus: session.status });

    const runId = this.#openRun(opts, session, startedAt);

    try {
      const result = await this.#run(opts, session, startedAt, runId);
      this.#closeRun(runId, result);
      this.#send('scan:completed', {
        scanRunId: runId,
        candidates: result.candidates.length,
        paperBuys: result.paperBuyCandidates.length,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#db.run(
        'UPDATE scan_runs SET finished_at = ?, error = ? WHERE id = ?',
        this.#now().toISOString(), message, runId,
      );
      this.#send('scan:failed', { scanRunId: runId, error: message });

      return {
        ...this.#emptyResult(opts, session, startedAt, runId),
        error: message,
        warnings: [`scan failed: ${message}`],
      };
    }
  }

  // ── Cycle ────────────────────────────────────────────────────────────────

  async #run(
    opts: ScanOptions,
    session: SessionState,
    startedAt: Date,
    runId: number,
  ): Promise<ScanResult> {
    const warnings: string[] = [];

    // ── Market regime, first. A HIGH_RISK market short-circuits everything.
    const { regime, view } = this.#assessRegime();
    if (view.missing.length > 0) {
      warnings.push(`regime assessed on partial data: missing ${view.missing.join(', ')}`);
    }

    const base = this.#emptyResult(opts, session, startedAt, runId);
    base.marketRegime = view;
    base.warnings = warnings;

    if (!session.isScanWindow && !opts.ignoreMarketHours) {
      base.noTradeReason = `market ${session.status}: ${session.reason}`;
      return base;
    }

    // ── Stage 1: light screen ────────────────────────────────────────────
    const since = new Date(
      startedAt.getTime() - this.#config.scan.maxEventAgeMinutes * 60_000,
    ).toISOString();

    const hits: ScreenHit[] =
      opts.symbols && opts.symbols.length > 0
        ? opts.symbols.map((symbol) => ({
            symbol, reasons: ['MANUAL'], priority: 1000, detail: ['explicitly requested'],
          }))
        : screen(this.#db, {
            triggers: this.#config.triggers,
            since,
            maxDeep: this.#config.scan.maxDeepAnalysis,
            alwaysInclude: symbolsWithOpenPositions(this.#db),
            maxEventAgeMinutes: this.#config.scan.maxEventAgeMinutes,
            now: startedAt,
          });

    const screened = this.#db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM instruments WHERE is_tradeable = 1',
    )?.n ?? 0;

    this.#send('scan:progress', { stage: 'SCREENED', screened, promoted: hits.length });

    const newEvents = this.#recentEvents(since, startedAt);

    // ── Stage 2: deep analysis on promoted symbols only ──────────────────
    const candidates: ScanCandidate[] = [];
    for (const [index, hit] of hits.entries()) {
      const candidate = this.#analyse(hit, regime, startedAt, session);
      if (candidate === null) continue;
      candidates.push(candidate);
      this.#linkCandidate(runId, candidate, index + 1, hit);
      this.#send('scan:progress', {
        stage: 'ANALYSED', symbol: hit.symbol, done: index + 1, total: hits.length,
      });
    }

    // Ordered by opportunity quality, never by percentage gain.
    const ranked = [...candidates].sort(
      (a, b) => b.swing10Score - a.swing10Score || b.eventQualityScore - a.eventQualityScore,
    );

    const accepted = ranked.filter((c) => c.action === 'PAPER_BUY' || c.action === 'WATCH');
    const rejected = ranked.filter((c) => c.action === 'IGNORE' || c.action === 'NO_TRADE');

    const result: ScanResult = {
      ...base,
      newEvents,
      candidates: ranked,
      rejectedCandidates: rejected,
      topCandidates: accepted.slice(0, 10),
      paperBuyCandidates: ranked.filter((c) => c.action === 'PAPER_BUY'),
      watchCandidates: ranked.filter((c) => c.action === 'WATCH'),
      stats: {
        symbolsScreened: screened,
        symbolsDeepAnalysed: candidates.length,
        newEvents: newEvents.length,
        durationMs: this.#now().getTime() - startedAt.getTime(),
      },
      warnings,
    };

    if (view.unstable) {
      result.noTradeReason =
        'market regime is unstable — standing aside rather than trading smaller';
    }

    return result;
  }

  // ── Deep analysis for one symbol ─────────────────────────────────────────

  #analyse(
    hit: ScreenHit,
    regime: RegimeResult | undefined,
    at: Date,
    session: SessionState,
  ): ScanCandidate | null {
    const candles = readCandles(this.#db, hit.symbol, '1d');
    if (candles.length < 20) return null;

    const lastBar = candles[candles.length - 1]!;
    const asOf = at.toISOString();

    const event = this.#db.get<EventRow>(
      `SELECT id, symbol, event_type, source_tier, sentiment, materiality, headline,
              filed_at, detected_at, detection_lag_sec
         FROM events
        WHERE symbol = ?
          AND COALESCE(filed_at, detected_at) <= ?
        ORDER BY COALESCE(filed_at, detected_at) DESC LIMIT 1`,
      hit.symbol, asOf,
    );

    const instrument = this.#db.get<{
      name: string | null; sector: string | null;
      avg_turnover_20d: number | null; is_tradeable: number; exclusion_reason: string | null;
    }>(
      'SELECT name, sector, avg_turnover_20d, is_tradeable, exclusion_reason FROM instruments WHERE symbol = ?',
      hit.symbol,
    );

    const benchmarkCandles = readCandles(this.#db, this.#benchmark, '1d');
    const benchmarkCloses = benchmarkCandles.map((c) => c.close);
    const aligned = benchmarkCloses.length === candles.length ? benchmarkCloses : undefined;

    const features = buildFeatures({
      symbol: hit.symbol,
      candles,
      benchmarkCloses: aligned,
      event: event
        ? {
            id: event.id,
            eventType: event.event_type,
            sourceTier: event.source_tier as CandidateEvent['sourceTier'],
            sentiment: event.sentiment as 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'AMBIGUOUS' | null,
            materiality: event.materiality,
            filedAt: event.filed_at,
            detectionLagSec: event.detection_lag_sec,
            corroborationCount: null,
          }
        : undefined,
      fundamental: toFeatureFundamentals(latestFundamentals(this.#db, hit.symbol, asOf)),
      regime,
      liquidity: instrument
        ? {
            avgTurnover20d: instrument.avg_turnover_20d,
            isTradeable: instrument.is_tradeable === 1,
            exclusionReason: instrument.exclusion_reason,
          }
        : undefined,
    });

    const freshness = buildFreshness({
      candles, event, now: at, session,
      staleFeedMs: this.#config.scan.staleFeedMs,
      fundamentalsAsOf: latestFundamentals(this.#db, hit.symbol, asOf)?.period_end ?? null,
    });

    // A stale price feed disables PAPER_BUY by marking the data stale, which
    // the STALE_DATA gate then vetoes. The rule lives in the gate, not here.
    if (freshness.degraded) features.risk.dataStale = true;

    const decision = decide(features, lastBar.close, {
      thresholds: this.#config.thresholds,
      gates: this.#config.gates,
      eventWeights: this.#config.eventWeights,
      tradeWeights: this.#config.tradeWeights,
      expectedMoves: this.#config.expectedMoves,
      costs: this.#config.costs,
      capital: this.#config.capital,
    });

    const candidateId = saveCandidate(this.#db, decision).candidateId;
    return this.#toCandidate(decision, hit, event, instrument, freshness, candidateId, at);
  }

  #toCandidate(
    decision: Decision,
    hit: ScreenHit,
    event: EventRow | undefined,
    instrument: { name: string | null; sector: string | null } | undefined,
    freshness: ScanCandidate['dataFreshness'],
    candidateId: number,
    at: Date,
  ): ScanCandidate {
    const f = decision.features;
    const extension = classifyExtension(f, decision.pricedIn);

    const positives: string[] = [];
    const negatives: string[] = [];
    for (const e of decision.explanations) {
      if (e.direction === 'ADD' && e.pointsAwarded >= 5) positives.push(e.rationale);
      else if (e.direction === 'DEDUCT' || e.direction === 'VETO') negatives.push(e.rationale);
    }

    const warnings = [...decision.summary.slice(1), ...freshness.notes];
    if (decision.planFailureReason) warnings.push(decision.planFailureReason);

    const filedAt = event?.filed_at ?? event?.detected_at ?? null;
    const candidateEvent: CandidateEvent | null = event
      ? {
          id: event.id,
          type: event.event_type,
          headline: event.headline,
          filedAt: event.filed_at,
          detectedAt: event.detected_at,
          ageMinutes: filedAt ? Math.round((at.getTime() - Date.parse(filedAt)) / 60_000) : null,
          materiality: event.materiality,
          sourceTier: event.source_tier as CandidateEvent['sourceTier'],
        }
      : null;

    return {
      symbol: decision.symbol,
      companyName: instrument?.name ?? null,
      event: candidateEvent,

      eventQualityScore: decision.eventQuality.total,
      tradeQualityScore: decision.tradeQuality.total,
      // SWING-10 is the trade-quality composite; both scores are surfaced so
      // neither is hidden behind the other.
      swing10Score: decision.tradeQuality.total,

      currentPrice: f.entry.support !== null ? decision.plan?.entryPrice ?? null : decision.plan?.entryPrice ?? null,
      priceChangePct: f.momentum.dayChangePct,
      priceSinceEventPct: f.momentum.changeSinceEventPct,
      volumeRatio: f.volume.volumeRatio,
      vwapState: f.volume.vwapPosition,

      technicalState: {
        trend: f.trend.emaStack,
        rsi14: f.momentum.rsi14,
        atrPct: f.momentum.atrPct,
        breakoutStatus: f.entry.breakoutStatus,
        support: f.entry.support,
        resistance: f.entry.resistance,
      },

      marketRegime: f.regime.label,
      sectorStrength: f.trend.rsVsSector,
      extensionRisk: extension,

      entry: decision.plan?.entryPrice ?? null,
      target: decision.plan?.target ?? null,
      stopLoss: decision.plan?.stopLoss ?? null,
      riskReward: decision.plan?.riskReward ?? null,
      quantity: decision.plan?.quantity ?? null,

      action: decision.action,
      confidence: Math.min(decision.eventQuality.confidence, decision.tradeQuality.confidence),

      positiveReasons: positives.slice(0, 8),
      negativeReasons: negatives.slice(0, 8),
      warnings,

      dataFreshness: freshness,
      explanations: decision.explanations,
      candidateId,
      triggeredBy: hit.reasons,
    };
  }

  // ── Regime ───────────────────────────────────────────────────────────────

  #assessRegime(): { regime: RegimeResult | undefined; view: ScanMarketRegime } {
    const benchmark = readCandles(this.#db, this.#benchmark, '1d');
    const closes = benchmark.map((c) => c.close);

    if (closes.length < 50) {
      return {
        regime: undefined,
        view: {
          label: null, score: null, nifty: closes.at(-1) ?? null, niftyChangePct: null,
          bankNiftyChangePct: null, vix: null, breadthRatio: null, unstable: false,
          reasons: [`insufficient benchmark history (${closes.length} bars, need 50)`],
          completeness: 0,
          missing: ['benchmark history'],
        },
      };
    }

    const bankNifty = readCandles(this.#db, 'NIFTY_BANK', '1d').map((c) => c.close);
    const vixBars = readCandles(this.#db, 'INDIA_VIX', '1d');
    const vix = vixBars.at(-1)?.close ?? null;
    const vixPrev = vixBars.at(-2)?.close ?? null;

    const regime = assessRegime({
      niftyCloses: closes,
      bankNiftyCloses: bankNifty.length >= 50 ? bankNifty : undefined,
      vix,
      vixChangePct: vix !== null && vixPrev !== null && vixPrev > 0
        ? ((vix - vixPrev) / vixPrev) * 100
        : null,
    });

    const reasons = [regime.unstableReason ?? `regime ${regime.label}`, `trend ${regime.trend}`];

    return {
      regime,
      view: {
        label: regime.label,
        // Rescale the 0-15 bucket to 0-100 for presentation.
        score: Math.round((regime.score / 15) * 100),
        nifty: closes.at(-1) ?? null,
        niftyChangePct: regime.niftyChangePct,
        bankNiftyChangePct: null,
        vix: regime.vix,
        breadthRatio: regime.breadthRatio,
        unstable: regime.unstable,
        reasons,
        completeness: regime.completeness,
        missing: regime.missing,
      },
    };
  }

  // ── Events ───────────────────────────────────────────────────────────────

  #recentEvents(since: string, at: Date): CandidateEvent[] {
    return this.#db
      .all<EventRow>(
        `SELECT id, symbol, event_type, source_tier, sentiment, materiality, headline,
                filed_at, detected_at, detection_lag_sec
           FROM events
          WHERE COALESCE(detected_at, filed_at) >= ?
          ORDER BY COALESCE(detected_at, filed_at) DESC
          LIMIT 100`,
        since,
      )
      .map((e) => {
        const filedAt = e.filed_at ?? e.detected_at;
        return {
          id: e.id,
          type: e.event_type,
          headline: e.headline,
          filedAt: e.filed_at,
          detectedAt: e.detected_at,
          ageMinutes: filedAt ? Math.round((at.getTime() - Date.parse(filedAt)) / 60_000) : null,
          materiality: e.materiality,
          sourceTier: e.source_tier as CandidateEvent['sourceTier'],
        };
      });
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  #openRun(opts: ScanOptions, session: SessionState, startedAt: Date): number {
    return this.#db.run(
      `INSERT INTO scan_runs (started_at, mode, trigger, market_status)
       VALUES (?, ?, ?, ?)`,
      startedAt.toISOString(), opts.mode, opts.trigger, session.status,
    ).lastInsertRowid;
  }

  #closeRun(runId: number, result: ScanResult): void {
    this.#db.run(
      `UPDATE scan_runs
          SET finished_at = ?, market_regime = ?, regime_score = ?,
              symbols_screened = ?, symbols_deep = ?, new_events = ?,
              candidates = ?, paper_buys = ?, watches = ?, duration_ms = ?,
              no_trade_reason = ?, data_freshness_json = ?
        WHERE id = ?`,
      this.#now().toISOString(),
      result.marketRegime.label,
      result.marketRegime.score,
      result.stats.symbolsScreened,
      result.stats.symbolsDeepAnalysed,
      result.stats.newEvents,
      result.candidates.length,
      result.paperBuyCandidates.length,
      result.watchCandidates.length,
      result.stats.durationMs,
      result.noTradeReason ?? null,
      JSON.stringify(result.warnings),
      runId,
    );

    this.#db.run(
      `INSERT INTO market_snapshots
         (scan_run_id, ts, nifty, nifty_change_pct, vix, breadth_ratio,
          regime_label, regime_score, unstable, completeness, missing_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId, result.timestamp,
      result.marketRegime.nifty, result.marketRegime.niftyChangePct,
      result.marketRegime.vix, result.marketRegime.breadthRatio,
      result.marketRegime.label, result.marketRegime.score,
      result.marketRegime.unstable ? 1 : 0,
      result.marketRegime.completeness,
      JSON.stringify(result.marketRegime.missing),
    );
  }

  #linkCandidate(runId: number, candidate: ScanCandidate, rank: number, hit: ScreenHit): void {
    if (candidate.candidateId === null) return;
    this.#db.run(
      'INSERT OR IGNORE INTO scan_candidates (scan_run_id, candidate_id, rank, triggered_by) VALUES (?, ?, ?, ?)',
      runId, candidate.candidateId, rank, hit.reasons.join(','),
    );
  }

  #emptyResult(
    opts: ScanOptions,
    session: SessionState,
    startedAt: Date,
    runId: number,
  ): ScanResult {
    return {
      scanRunId: runId,
      timestamp: startedAt.toISOString(),
      mode: opts.mode,
      trigger: opts.trigger,
      marketStatus: session.status,
      marketOpen: session.isOpen,
      marketRegime: {
        label: null, score: null, nifty: null, niftyChangePct: null,
        bankNiftyChangePct: null, vix: null, breadthRatio: null,
        unstable: false, reasons: [], completeness: null, missing: [],
      },
      newEvents: [],
      candidates: [],
      rejectedCandidates: [],
      topCandidates: [],
      paperBuyCandidates: [],
      watchCandidates: [],
      stats: {
        symbolsScreened: 0, symbolsDeepAnalysed: 0, newEvents: 0,
        durationMs: this.#now().getTime() - startedAt.getTime(),
      },
      warnings: [],
    };
  }
}
