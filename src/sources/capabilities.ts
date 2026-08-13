/**
 * Capability resolution.
 *
 * The engine works out at boot what it can actually do, given which sources
 * are enabled, and records every degradation. Downstream code reads
 * capabilities rather than assuming intraday data exists — and every stored
 * row carries the fidelity it was produced at, so a validation cohort built
 * from delayed data can never be silently compared against one built from
 * real-time data.
 */

import type { SourceRegistry } from './registry.ts';
import type { Fidelity } from './types.ts';

export type Horizon = 't0' | '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '60m';

export const ALL_HORIZONS: readonly Horizon[] = [
  't0', '1m', '3m', '5m', '10m', '15m', '30m', '60m',
];

export interface Capabilities {
  tier: 0 | 1 | 2;
  /** Fidelity the price-reaction engine can achieve. */
  intradayReaction: Fidelity;
  /** Reaction engine mode. EOD_PROXY is the Tier 0 fallback. */
  reactionMode: 'LIVE' | 'REPLAY' | 'EOD_PROXY';
  liveScanning: boolean;
  availableHorizons: Horizon[];
  /** Human-readable list of what is unavailable and why. */
  degradations: string[];
}

export function resolveCapabilities(registry: SourceRegistry): Capabilities {
  const enabled = registry.enabled();
  const degradations: string[] = [];

  const hasBroker = enabled.some((s) => s.policy.tier === 1);
  const hasDelayedIntraday = enabled.some(
    (s) => s.policy.tier === 2 && s.policy.latencyClass === 'DELAYED',
  );

  if (hasBroker) {
    return {
      tier: 1,
      intradayReaction: 'HIGH',
      reactionMode: 'LIVE',
      liveScanning: true,
      availableHorizons: [...ALL_HORIZONS],
      degradations,
    };
  }

  if (hasDelayedIntraday) {
    degradations.push(
      'No broker source enabled — intraday data is DELAYED. Reaction profiles ' +
        'are research-replay only and must not be pooled with real-time cohorts.',
    );
    degradations.push('Live scanning disabled: no REALTIME source is enabled.');
    return {
      tier: 2,
      intradayReaction: 'MEDIUM',
      reactionMode: 'REPLAY',
      liveScanning: false,
      availableHorizons: [...ALL_HORIZONS],
      degradations,
    };
  }

  degradations.push(
    'No intraday source enabled — the price-reaction engine runs in EOD_PROXY ' +
      'mode. Only the t0 horizon is captured; intraday horizons are unavailable.',
  );
  degradations.push('Live scanning disabled: no REALTIME source is enabled.');

  if (enabled.length === 0) {
    degradations.push('No sources are enabled at all — ingest will produce nothing.');
  }

  return {
    tier: 0,
    intradayReaction: 'LOW',
    reactionMode: 'EOD_PROXY',
    liveScanning: false,
    availableHorizons: ['t0'],
    degradations,
  };
}

/** One-line summary for logs and alert footers. */
export function describeCapabilities(caps: Capabilities): string {
  return (
    `Tier ${caps.tier} · reaction=${caps.reactionMode} (${caps.intradayReaction}) · ` +
    `live=${caps.liveScanning ? 'yes' : 'no'} · ` +
    `horizons=${caps.availableHorizons.join(',')}` +
    (caps.degradations.length > 0 ? ` · ${caps.degradations.length} degradation(s)` : '')
  );
}
