/**
 * AlertEngine.
 *
 * Decides what deserves a human's attention and dispatches it. Telegram is one
 * optional channel behind an interface — the dashboard and the scanner work
 * with no channel configured at all.
 *
 * Two independent suppression rules, because an unattended scanner that cries
 * wolf gets muted, and a muted scanner is worthless:
 *   1. Only notable state transitions alert. Steady state never does.
 *   2. A per-symbol cooldown caps how often any one symbol can alert.
 */

import type { Db } from '../db/driver.ts';
import type { AlertConfig } from '../config/index.ts';
import type { ScanCandidate, ScanResult } from '../scan/types.ts';
import type { Transition } from './state.ts';

export interface AlertMessage {
  title: string;
  body: string;
  symbol: string | null;
  transition: string;
}

export interface AlertChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(message: AlertMessage): Promise<void>;
}

export interface AlertDecision {
  message: AlertMessage;
  sent: boolean;
  suppressedReason: string | null;
  error: string | null;
}

export interface AlertEngineDeps {
  db: Db;
  config: AlertConfig;
  channels?: AlertChannel[];
  now?: () => Date;
}

export class AlertEngine {
  readonly #db: Db;
  readonly #config: AlertConfig;
  readonly #channels: AlertChannel[];
  readonly #now: () => Date;

  constructor(deps: AlertEngineDeps) {
    this.#db = deps.db;
    this.#config = deps.config;
    this.#channels = deps.channels ?? [];
    this.#now = deps.now ?? ((): Date => new Date());
  }

  get configuredChannels(): string[] {
    return this.#channels.filter((c) => c.isConfigured()).map((c) => c.name);
  }

  /** True when this transition type is one the operator asked to hear about. */
  #isEnabled(kind: string): boolean {
    return this.#config.onTransitions.includes(kind);
  }

  /** Milliseconds since this symbol last had an alert actually sent. */
  #msSinceLastAlert(symbol: string | null): number | null {
    if (symbol === null) return null;
    const row = this.#db.get<{ ts: string }>(
      'SELECT ts FROM alert_log WHERE symbol = ? AND sent = 1 ORDER BY ts DESC LIMIT 1',
      symbol,
    );
    if (!row) return null;
    return this.#now().getTime() - Date.parse(row.ts);
  }

  #log(decision: AlertDecision, channel: string, transition: Transition | null): void {
    this.#db.run(
      `INSERT INTO alert_log
         (ts, symbol, transition, from_action, to_action, channel, sent,
          suppressed_reason, payload_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.#now().toISOString(),
      decision.message.symbol,
      decision.message.transition,
      transition?.from ?? null,
      transition?.to ?? null,
      channel,
      decision.sent ? 1 : 0,
      decision.suppressedReason,
      JSON.stringify({ title: decision.message.title }),
      decision.error,
    );
  }

  /**
   * Considers one transition. Every decision is logged, sent or not, so the
   * question "why didn't I get an alert?" is always answerable.
   */
  async consider(
    transition: Transition,
    candidate?: ScanCandidate,
  ): Promise<AlertDecision> {
    const message = formatTransition(transition, candidate);

    const suppress = (reason: string): AlertDecision => {
      const decision: AlertDecision = { message, sent: false, suppressedReason: reason, error: null };
      this.#log(decision, 'none', transition);
      return decision;
    };

    if (!this.#config.enabled) return suppress('alerts disabled in configuration');
    if (!transition.notable) return suppress(`transition ${transition.kind} is not notable`);
    if (!this.#isEnabled(transition.kind)) {
      return suppress(`transition ${transition.kind} is not in the configured alert list`);
    }

    const since = this.#msSinceLastAlert(transition.symbol);
    if (since !== null && since < this.#config.minIntervalMs) {
      return suppress(
        `cooldown: last alert for ${transition.symbol} was ${Math.round(since / 1000)}s ago`,
      );
    }

    const active = this.#channels.filter((c) => c.isConfigured());
    if (active.length === 0) return suppress('no alert channel is configured');

    let sent = false;
    let error: string | null = null;
    for (const channel of active) {
      try {
        await channel.send(message);
        sent = true;
        this.#log({ message, sent: true, suppressedReason: null, error: null }, channel.name, transition);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        this.#log({ message, sent: false, suppressedReason: null, error }, channel.name, transition);
      }
    }

    return { message, sent, suppressedReason: null, error };
  }

  /** Considers a market-wide condition rather than a per-symbol transition. */
  async considerSystem(kind: 'MARKET_HIGH_RISK' | 'FEED_FAILURE', detail: string): Promise<AlertDecision> {
    return this.consider({
      symbol: '', kind, from: null, to: 'NO_TRADE', notable: true, reason: detail,
    } as unknown as Transition);
  }
}

/** Renders a transition as the message a human reads. */
export function formatTransition(
  transition: Transition,
  candidate?: ScanCandidate,
): AlertMessage {
  const symbol = transition.symbol || null;

  if (transition.kind === 'MARKET_HIGH_RISK') {
    return {
      title: '⚠️ MARKET HIGH RISK', symbol: null, transition: transition.kind,
      body: `${transition.reason}\n\nNo new PAPER_BUY signals will be issued.`,
    };
  }
  if (transition.kind === 'FEED_FAILURE') {
    return {
      title: '⚠️ DATA FEED FAILURE', symbol: null, transition: transition.kind,
      body: `${transition.reason}\n\nSignals are unreliable until the feed recovers.`,
    };
  }
  if (transition.to === 'TARGET_HIT' || transition.to === 'STOP_HIT') {
    return {
      title: transition.to === 'TARGET_HIT' ? `🎯 TARGET HIT — ${symbol}` : `🛑 STOP HIT — ${symbol}`,
      symbol, transition: transition.kind, body: transition.reason,
    };
  }
  if (transition.to === 'INVALIDATED') {
    return {
      title: `🔴 SIGNAL INVALIDATED — ${symbol}`,
      symbol, transition: transition.kind,
      body: `${transition.reason}\n\nPAPER TRADING ONLY`,
    };
  }

  if (transition.to === 'PAPER_BUY' && candidate) {
    const money = (v: number | null): string => (v === null ? '—' : `₹${v.toFixed(2)}`);
    const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

    const lines = [
      `🚨 SWING-10 OPPORTUNITY`,
      '',
      `${candidate.symbol}${candidate.companyName ? ` — ${candidate.companyName}` : ''}`,
      candidate.event?.type ? `${candidate.event.type}` : 'No specific event',
      candidate.event?.headline ? `${candidate.event.headline.slice(0, 120)}` : '',
      '',
      `Event Quality: ${candidate.eventQualityScore}`,
      `Trade Quality: ${candidate.tradeQualityScore}`,
      `SWING-10:      ${candidate.swing10Score}`,
      '',
      `Price reaction: ${pct(candidate.priceSinceEventPct ?? candidate.priceChangePct)}`,
      `Volume:         ${candidate.volumeRatio === null ? '—' : `${candidate.volumeRatio.toFixed(1)}x`}`,
      `VWAP:           ${candidate.vwapState ?? '—'}`,
      `Extension risk: ${candidate.extensionRisk}`,
      '',
      `🟢 PAPER BUY CANDIDATE`,
      '',
      `Entry:  ${money(candidate.entry)}`,
      `Target: ${money(candidate.target)}`,
      `SL:     ${money(candidate.stopLoss)}`,
      `R:R:    ${candidate.riskReward === null ? '—' : candidate.riskReward.toFixed(2)}`,
      '',
      ...(candidate.warnings.length > 0 ? ['⚠ ' + candidate.warnings.slice(0, 3).join('\n⚠ '), ''] : []),
      'PAPER TRADING ONLY',
      'STRATEGY NOT VALIDATED',
    ];

    return {
      title: `🟢 PAPER BUY — ${candidate.symbol}`,
      symbol, transition: transition.kind,
      body: lines.filter((l) => l !== undefined).join('\n'),
    };
  }

  return {
    title: `${symbol}: ${transition.from ?? 'new'} → ${transition.to}`,
    symbol, transition: transition.kind,
    body: `${transition.reason}\n\nPAPER TRADING ONLY`,
  };
}

/** Convenience: pairs each transition with its candidate from a scan result. */
export function candidatesBySymbol(result: ScanResult): Map<string, ScanCandidate> {
  return new Map(result.candidates.map((c) => [c.symbol, c]));
}
