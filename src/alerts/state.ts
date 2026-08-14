/**
 * Signal state and transitions.
 *
 * The problem this solves: a scan running every five minutes sees the same
 * WATCH candidate twelve times an hour. Alerting on state rather than on
 * observation is what makes an unattended scanner tolerable — an alert means
 * "something changed", not "the scanner ran".
 *
 * State lives in SQLite, so it survives across local restarts and, when the
 * database is restored, across ephemeral GitHub Actions runners.
 */

import type { Db } from '../db/driver.ts';
import type { Action } from '../scoring/decide.ts';

/** Terminal states a signal can reach beyond the four scan actions. */
export type SignalState = Action | 'INVALIDATED' | 'TARGET_HIT' | 'STOP_HIT';

export type TransitionKind =
  | `${string}>${string}`
  | 'TARGET_HIT'
  | 'STOP_HIT'
  | 'MARKET_HIGH_RISK'
  | 'FEED_FAILURE';

export interface StoredSignal {
  symbol: string;
  action: SignalState;
  swing10Score: number | null;
  eventQuality: number | null;
  tradeQuality: number | null;
  eventId: number | null;
  candidateId: number | null;
  firstSeenAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface Transition {
  symbol: string;
  kind: TransitionKind;
  from: SignalState | null;
  to: SignalState;
  /** True when this transition is worth telling a human about. */
  notable: boolean;
  reason: string;
}

export function readSignal(db: Db, symbol: string): StoredSignal | undefined {
  const row = db.get<{
    symbol: string; action: string; swing10_score: number | null;
    event_quality: number | null; trade_quality: number | null;
    event_id: number | null; candidate_id: number | null;
    first_seen_at: string; updated_at: string;
    invalidated_at: string | null; invalidation_reason: string | null;
  }>('SELECT * FROM signal_state WHERE symbol = ?', symbol.toUpperCase());

  if (!row) return undefined;
  return {
    symbol: row.symbol,
    action: row.action as SignalState,
    swing10Score: row.swing10_score,
    eventQuality: row.event_quality,
    tradeQuality: row.trade_quality,
    eventId: row.event_id,
    candidateId: row.candidate_id,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  };
}

export interface ObserveInput {
  symbol: string;
  action: SignalState;
  swing10Score?: number | null;
  eventQuality?: number | null;
  tradeQuality?: number | null;
  eventId?: number | null;
  candidateId?: number | null;
  /** Reason recorded when a PAPER_BUY degrades. */
  reason?: string;
  at: string;
}

/**
 * Transitions considered notable enough to alert on.
 *
 * Deliberately asymmetric: becoming a PAPER_BUY matters, and losing one
 * matters, but drifting between IGNORE and WATCH is noise.
 */
const NOTABLE = new Set<string>([
  'WATCH>PAPER_BUY',
  'IGNORE>PAPER_BUY',
  'NO_TRADE>PAPER_BUY',
  'null>PAPER_BUY',
  'PAPER_BUY>INVALIDATED',
  'PAPER_BUY>IGNORE',
  'PAPER_BUY>NO_TRADE',
  'PAPER_BUY>WATCH',
  'WATCH>INVALIDATED',
]);

function isNotable(from: SignalState | null, to: SignalState): boolean {
  if (to === 'TARGET_HIT' || to === 'STOP_HIT') return true;
  return NOTABLE.has(`${from ?? 'null'}>${to}`);
}

function describe(from: SignalState | null, to: SignalState, reason?: string): string {
  if (reason) return reason;
  if (from === null) return `first seen as ${to}`;
  return `${from} to ${to}`;
}

/**
 * Records an observation and returns the transition, if the state changed.
 *
 * Returns null when nothing changed — which is the common case, and the point.
 */
export function observeSignal(db: Db, input: ObserveInput): Transition | null {
  const symbol = input.symbol.toUpperCase();
  const previous = readSignal(db, symbol);
  const from = previous?.action ?? null;

  const changed = from !== input.action;

  const isInvalidation = input.action === 'INVALIDATED';
  db.run(
    `INSERT INTO signal_state
       (symbol, action, swing10_score, event_quality, trade_quality, event_id,
        candidate_id, first_seen_at, updated_at, invalidated_at, invalidation_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       action = excluded.action,
       swing10_score = excluded.swing10_score,
       event_quality = excluded.event_quality,
       trade_quality = excluded.trade_quality,
       event_id = COALESCE(excluded.event_id, signal_state.event_id),
       candidate_id = COALESCE(excluded.candidate_id, signal_state.candidate_id),
       updated_at = excluded.updated_at,
       invalidated_at = COALESCE(excluded.invalidated_at, signal_state.invalidated_at),
       invalidation_reason = COALESCE(excluded.invalidation_reason, signal_state.invalidation_reason)`,
    symbol,
    input.action,
    input.swing10Score ?? null,
    input.eventQuality ?? null,
    input.tradeQuality ?? null,
    input.eventId ?? null,
    input.candidateId ?? null,
    previous?.firstSeenAt ?? input.at,
    input.at,
    isInvalidation ? input.at : null,
    isInvalidation ? (input.reason ?? 'conditions no longer met') : null,
  );

  if (!changed) return null;

  return {
    symbol,
    kind: `${from ?? 'null'}>${input.action}`,
    from,
    to: input.action,
    notable: isNotable(from, input.action),
    reason: describe(from, input.action, input.reason),
  };
}

/**
 * Marks previously active signals that no longer appear in a scan.
 *
 * A PAPER_BUY that stops qualifying is an invalidation the operator needs to
 * know about; a WATCH that quietly drops off is not. Only symbols the scan
 * actually looked at are considered — absence from a screened-out symbol is
 * not evidence the setup failed.
 */
export function invalidateMissing(
  db: Db,
  seenSymbols: readonly string[],
  screenedSymbols: readonly string[],
  at: string,
): Transition[] {
  const seen = new Set(seenSymbols.map((s) => s.toUpperCase()));
  const screened = new Set(screenedSymbols.map((s) => s.toUpperCase()));

  const active = db.all<{ symbol: string; action: string }>(
    `SELECT symbol, action FROM signal_state WHERE action IN ('PAPER_BUY', 'WATCH')`,
  );

  const transitions: Transition[] = [];
  for (const row of active) {
    if (seen.has(row.symbol)) continue;
    if (!screened.has(row.symbol)) continue; // not examined, so not disproved
    if (row.action !== 'PAPER_BUY') continue;

    const transition = observeSignal(db, {
      symbol: row.symbol,
      action: 'INVALIDATED',
      at,
      reason: 'no longer qualifies as a PAPER_BUY on re-evaluation',
    });
    if (transition) transitions.push(transition);
  }
  return transitions;
}

/** Signals currently in a given state. */
export function signalsInState(db: Db, action: SignalState): StoredSignal[] {
  return db
    .all<{ symbol: string }>('SELECT symbol FROM signal_state WHERE action = ? ORDER BY symbol', action)
    .map((r) => readSignal(db, r.symbol))
    .filter((s): s is StoredSignal => s !== undefined);
}
