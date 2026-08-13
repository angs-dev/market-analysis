/**
 * Source registry — loads config/sources.json, normalises and validates each
 * policy, and mirrors the register into the data_sources table.
 *
 * A source is only usable when it is registered, enabled, and (if its legal
 * basis is unclear) explicitly opted into. Defaults never opt in for you.
 */

import { readFileSync } from 'node:fs';
import { normalizePolicy, type PartialPolicy } from './policy.ts';
import type { SourcePolicy } from './types.ts';
import type { Db } from '../db/driver.ts';

export interface SourcesConfig {
  /** Source ids the operator has explicitly opted into, e.g. TOS_GREY ones. */
  optIn?: string[];
  sources: PartialPolicy[];
}

export interface RegisteredSource {
  policy: SourcePolicy;
  enabled: boolean;
  /** Present when a source is registered but not enabled. */
  disabledReason?: string;
}

export class SourceRegistry {
  readonly #sources = new Map<string, RegisteredSource>();

  static fromConfig(config: SourcesConfig): SourceRegistry {
    const registry = new SourceRegistry();
    const optIn = new Set(config.optIn ?? []);

    for (const raw of config.sources) {
      const policy = normalizePolicy(raw);

      // Listing a source in optIn is the affirmative act that enables it. That
      // is the only way to switch on a TOS_GREY source, and also how a Tier 1
      // broker source is turned on once credentials exist.
      const optedIn = optIn.has(policy.id);
      const enabled = optedIn || (!policy.requiresExplicitOptIn && policy.enabledByDefault);

      let disabledReason: string | undefined;
      if (!enabled) {
        disabledReason = policy.requiresExplicitOptIn
          ? `requires explicit opt-in (legal basis: ${policy.legalBasis}) — ` +
            `add "${policy.id}" to optIn in config/sources.json after reading ` +
            `docs/DATA-SOURCE-COMPLIANCE.md`
          : `not enabled by default — add "${policy.id}" to optIn in config/sources.json`;
      }

      const entry: RegisteredSource = { policy, enabled };
      if (disabledReason) entry.disabledReason = disabledReason;
      registry.#sources.set(policy.id, entry);
    }
    return registry;
  }

  static fromFile(path: string): SourceRegistry {
    return SourceRegistry.fromConfig(JSON.parse(readFileSync(path, 'utf8')) as SourcesConfig);
  }

  get(id: string): RegisteredSource | undefined {
    return this.#sources.get(id);
  }

  all(): RegisteredSource[] {
    return [...this.#sources.values()];
  }

  enabled(): RegisteredSource[] {
    return this.all().filter((s) => s.enabled);
  }

  byTier(tier: 0 | 1 | 2): RegisteredSource[] {
    return this.all().filter((s) => s.policy.tier === tier);
  }

  /** Mirrors the register into data_sources so the DB reflects configuration. */
  persist(db: Db): void {
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const { policy, enabled } of this.all()) {
        db.run(
          `INSERT INTO data_sources
             (id, tier, latency_class, legal_basis, attribution_text,
              enabled, requires_opt_in, policy_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             tier = excluded.tier,
             latency_class = excluded.latency_class,
             legal_basis = excluded.legal_basis,
             attribution_text = excluded.attribution_text,
             enabled = excluded.enabled,
             requires_opt_in = excluded.requires_opt_in,
             policy_json = excluded.policy_json,
             updated_at = excluded.updated_at`,
          policy.id,
          policy.tier,
          policy.latencyClass,
          policy.legalBasis,
          policy.attribution ?? null,
          enabled ? 1 : 0,
          policy.requiresExplicitOptIn ? 1 : 0,
          JSON.stringify(policy),
          now,
        );
      }
    });
  }
}
