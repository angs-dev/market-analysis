/**
 * ScanEngine contracts.
 *
 * The ScanResult shape is identical whether produced by the local scheduler,
 * a one-shot GitHub Actions run, or a manual dashboard trigger. There is one
 * scoring implementation and one result model; the execution mode only decides
 * how often it runs.
 */

import type { Action } from '../scoring/decide.ts';
import type { MarketStatus } from '../market/session.ts';
import type { RegimeLabel } from '../regime/market.ts';
import type { LatencyClass } from '../sources/types.ts';
import type { Explanation } from '../scoring/explain.ts';

export type ScanMode = 'LOCAL' | 'ONCE' | 'MANUAL' | 'REPLAY';
export type ScanTrigger = 'SCHEDULE' | 'MANUAL' | 'STARTUP';

export type ExtensionRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

/**
 * How current the data behind a candidate is. Presented on every candidate
 * because a confident score computed from stale inputs is the most dangerous
 * output this system can produce.
 */
export interface DataFreshness {
  price: { latency: LatencyClass; ageSeconds: number | null; stale: boolean };
  news: { latency: LatencyClass; detectionLagSeconds: number | null };
  fundamentals: { asOf: string | null; label: 'LATEST_REPORTED' | 'UNAVAILABLE' };
  /** True when any input is stale enough to disable PAPER_BUY. */
  degraded: boolean;
  notes: string[];
}

/** Why stage 1 promoted a symbol to deep analysis. */
export type TriggerReason =
  | 'NEW_EVENT'
  | 'UNUSUAL_VOLUME'
  | 'PRICE_MOVE'
  | 'BREAKOUT_PROXIMITY'
  | 'OPEN_POSITION'
  | 'MANUAL';

export interface ScreenHit {
  symbol: string;
  reasons: TriggerReason[];
  /** Ordering key for which symbols get the deep-analysis budget. */
  priority: number;
  detail: string[];
}

export interface CandidateEvent {
  id: number | null;
  type: string | null;
  headline: string | null;
  filedAt: string | null;
  detectedAt: string | null;
  /** Minutes between the filing and this scan. */
  ageMinutes: number | null;
  materiality: number | null;
  sourceTier: 'PRIMARY_EXCHANGE' | 'SECONDARY_NEWS' | null;
}

export interface ScanCandidate {
  symbol: string;
  companyName: string | null;
  event: CandidateEvent | null;

  eventQualityScore: number;
  tradeQualityScore: number;
  swing10Score: number;

  currentPrice: number | null;
  priceChangePct: number | null;
  priceSinceEventPct: number | null;
  volumeRatio: number | null;
  vwapState: 'ABOVE' | 'BELOW' | 'AT' | null;

  technicalState: {
    trend: string | null;
    rsi14: number | null;
    atrPct: number | null;
    breakoutStatus: string | null;
    support: number | null;
    resistance: number | null;
  };

  marketRegime: RegimeLabel | null;
  sectorStrength: number | null;
  extensionRisk: ExtensionRisk;

  entry: number | null;
  target: number | null;
  stopLoss: number | null;
  riskReward: number | null;
  quantity: number | null;

  action: Action;
  confidence: number;

  positiveReasons: string[];
  negativeReasons: string[];
  warnings: string[];

  dataFreshness: DataFreshness;
  /** Full audit trail, carried for the dashboard's "why this signal" panel. */
  explanations: Explanation[];
  candidateId: number | null;
  triggeredBy: TriggerReason[];
}

export interface ScanMarketRegime {
  label: RegimeLabel | null;
  /** 0-100, rescaled from the 0-15 bucket for presentation. */
  score: number | null;
  nifty: number | null;
  niftyChangePct: number | null;
  bankNiftyChangePct: number | null;
  vix: number | null;
  breadthRatio: number | null;
  unstable: boolean;
  reasons: string[];
  completeness: number | null;
  missing: string[];
}

export interface ScanResult {
  scanRunId: number | null;
  timestamp: string;
  mode: ScanMode;
  trigger: ScanTrigger;

  marketStatus: MarketStatus;
  marketOpen: boolean;
  marketRegime: ScanMarketRegime;

  newEvents: CandidateEvent[];
  candidates: ScanCandidate[];
  rejectedCandidates: ScanCandidate[];
  topCandidates: ScanCandidate[];
  paperBuyCandidates: ScanCandidate[];
  watchCandidates: ScanCandidate[];

  noTradeReason?: string;

  stats: {
    symbolsScreened: number;
    symbolsDeepAnalysed: number;
    newEvents: number;
    durationMs: number;
  };
  warnings: string[];
  /** Set when the scan could not complete. */
  error?: string;
}

/** Emitted for the real-time UI channel. */
export type ScanEventName =
  | 'scan:started'
  | 'scan:progress'
  | 'scan:completed'
  | 'scan:failed'
  | 'signal:changed'
  | 'event:new'
  | 'feed:stale';

export interface ScanEnvelope<T = unknown> {
  name: ScanEventName;
  ts: string;
  payload: T;
}
