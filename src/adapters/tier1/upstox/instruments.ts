/**
 * Instrument-key resolution.
 *
 * Upstox addresses instruments by key (`NSE_EQ|<ISIN>`, `NSE_INDEX|<name>`),
 * not by trading symbol. Those keys are NOT hard-coded here: equity keys embed
 * ISINs, and an ISIN written from memory that happens to be wrong would
 * silently subscribe to the wrong company. They are resolved from Upstox's own
 * instrument master file instead.
 *
 * The master is expected as a local file, downloaded once, in the same spirit
 * as the Tier 0 manual-CSV path:
 *
 *   data/manual/upstox_instruments.json   (or .csv)
 *
 * Index keys are name-based rather than ISIN-based and are listed as defaults
 * below, but they are still verified against the master when one is present.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseCsv } from '../../../parse/csv.ts';

export interface InstrumentMasterRow {
  instrumentKey: string;
  tradingSymbol: string;
  name: string;
  exchange: string;
  segment: string;
  instrumentType: string;
}

export class InstrumentResolutionError extends Error {}

/**
 * Index instrument keys. Name-based, so they are stable and safe to state.
 * ⚠️ Still verify against the instrument master — Upstox has renamed index
 * keys before (for example "Nifty Bank" vs "NIFTY BANK").
 */
export const DEFAULT_INDEX_KEYS: Record<string, string> = {
  NIFTY_50: 'NSE_INDEX|Nifty 50',
  NIFTY_BANK: 'NSE_INDEX|Nifty Bank',
  INDIA_VIX: 'NSE_INDEX|India VIX',
};

function normaliseKey(value: string): string {
  return value.trim().toUpperCase();
}

/** Reads the instrument master from JSON or CSV. */
export function loadInstrumentMaster(path: string): InstrumentMasterRow[] {
  if (!existsSync(path)) {
    throw new InstrumentResolutionError(
      `Instrument master not found at ${path}. Download the Upstox instrument ` +
        `master (complete NSE list) and save it there. Instrument keys are not ` +
        `hard-coded because equity keys embed ISINs.`,
    );
  }

  const content = readFileSync(path, 'utf8');
  const rows: InstrumentMasterRow[] = [];

  if (path.toLowerCase().endsWith('.json')) {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new InstrumentResolutionError('instrument master JSON must be an array');
    }
    for (const raw of parsed as Record<string, unknown>[]) {
      const instrumentKey = String(raw['instrument_key'] ?? raw['instrumentKey'] ?? '');
      const tradingSymbol = String(raw['trading_symbol'] ?? raw['tradingsymbol'] ?? '');
      if (instrumentKey === '' || tradingSymbol === '') continue;
      rows.push({
        instrumentKey,
        tradingSymbol,
        name: String(raw['name'] ?? ''),
        exchange: String(raw['exchange'] ?? ''),
        segment: String(raw['segment'] ?? ''),
        instrumentType: String(raw['instrument_type'] ?? raw['instrumentType'] ?? ''),
      });
    }
    return rows;
  }

  const { rows: csvRows } = parseCsv(content);
  for (const raw of csvRows) {
    const instrumentKey = raw['instrument_key'] ?? raw['instrumentkey'] ?? '';
    const tradingSymbol = raw['trading_symbol'] ?? raw['tradingsymbol'] ?? '';
    if (instrumentKey === '' || tradingSymbol === '') continue;
    rows.push({
      instrumentKey,
      tradingSymbol,
      name: raw['name'] ?? '',
      exchange: raw['exchange'] ?? '',
      segment: raw['segment'] ?? '',
      instrumentType: raw['instrument_type'] ?? '',
    });
  }
  return rows;
}

export interface ResolvedUniverse {
  /** Instrument key to internal symbol — the map the feed client consumes. */
  keyToSymbol: Map<string, string>;
  /** Internal symbol to instrument key. */
  symbolToKey: Map<string, string>;
  /** Symbols that could not be resolved, with the reason. */
  unresolved: { symbol: string; reason: string }[];
}

export interface ResolveOptions {
  /** Internal symbols to resolve, e.g. ['RELIANCE', 'HDFCBANK']. */
  equities: readonly string[];
  /** Internal index names, keys of DEFAULT_INDEX_KEYS. */
  indices: readonly string[];
  master?: readonly InstrumentMasterRow[];
  /** Restricts equity matching to this segment. */
  segment?: string;
}

/**
 * Resolves symbols to instrument keys.
 *
 * A symbol that cannot be resolved is reported, never guessed. Subscribing to
 * a wrong key produces confidently wrong data, which is worse than a gap.
 */
export function resolveUniverse(opts: ResolveOptions): ResolvedUniverse {
  const keyToSymbol = new Map<string, string>();
  const symbolToKey = new Map<string, string>();
  const unresolved: { symbol: string; reason: string }[] = [];
  const segment = opts.segment ?? 'NSE_EQ';

  const bySymbol = new Map<string, InstrumentMasterRow[]>();
  for (const row of opts.master ?? []) {
    const key = normaliseKey(row.tradingSymbol);
    const list = bySymbol.get(key);
    if (list) list.push(row);
    else bySymbol.set(key, [row]);
  }

  for (const symbol of opts.equities) {
    const wanted = normaliseKey(symbol);
    const matches = (bySymbol.get(wanted) ?? []).filter(
      (r) => normaliseKey(r.segment) === normaliseKey(segment),
    );

    if (matches.length === 0) {
      unresolved.push({
        symbol: wanted,
        reason:
          opts.master === undefined
            ? 'no instrument master loaded'
            : `not found in segment ${segment}`,
      });
      continue;
    }
    if (matches.length > 1) {
      unresolved.push({
        symbol: wanted,
        reason: `ambiguous: ${matches.length} matches in ${segment}`,
      });
      continue;
    }

    const key = matches[0]!.instrumentKey;
    keyToSymbol.set(key, wanted);
    symbolToKey.set(wanted, key);
  }

  for (const index of opts.indices) {
    const wanted = normaliseKey(index);
    const key = DEFAULT_INDEX_KEYS[wanted];
    if (key === undefined) {
      unresolved.push({ symbol: wanted, reason: 'unknown index name' });
      continue;
    }
    keyToSymbol.set(key, wanted);
    symbolToKey.set(wanted, key);
  }

  return { keyToSymbol, symbolToKey, unresolved };
}

export interface TestUniverseConfig {
  indices: string[];
  equities: string[];
  mode: string;
}

export function loadTestUniverse(path: string): TestUniverseConfig {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestUniverseConfig>;
  return {
    indices: parsed.indices ?? [],
    equities: parsed.equities ?? [],
    mode: parsed.mode ?? 'full',
  };
}
