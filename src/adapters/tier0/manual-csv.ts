/**
 * Manual CSV provider — Tier 0, the zero-dependency baseline.
 *
 * Reads files a human downloaded and dropped into a directory. This is the one
 * source with an entirely unambiguous legal basis, and it is why the pipeline
 * can run end-to-end with no broker and no network access at all.
 *
 * Expected layout (all optional):
 *   <dir>/universe.csv          symbol,name,isin,sector,...
 *   <dir>/candles/*.csv         symbol,date,open,high,low,close,volume
 *   <dir>/events/*.csv          symbol,date,headline,...
 *
 * Implements MarketDataProvider — data only, no orders.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv, parseNumber, requireField, CsvError } from '../../parse/csv.ts';
import { parseDate, tryParseTimestamp } from '../../parse/dates.ts';
import type {
  Candle,
  DateRange,
  InstrumentRef,
  Provenance,
  RawAnnouncement,
} from '../../market/types.ts';
import type { MarketDataProvider, ProviderCapabilities } from '../../market/provider.ts';

export const MANUAL_CSV_SOURCE_ID = 'manual_csv';

const PROVENANCE: Provenance = {
  sourceId: MANUAL_CSV_SOURCE_ID,
  latencyClass: 'PERIODIC',
  fidelity: 'LOW',
};

export interface ManualCsvOptions {
  /** Root directory, typically data/manual. */
  dir: string;
}

function listCsvFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort()
    .map((f) => join(dir, f));
}

/** Column aliases, because downloaded files are not consistent. */
function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

export function parseCandleCsv(content: string, fileLabel: string): Candle[] {
  const { rows } = parseCsv(content);
  return rows.map((row, i) => {
    const where = `${fileLabel} row ${i + 2}`;
    const symbol = requireField(row, 'symbol', where).toUpperCase();
    const dateRaw = pick(row, 'date', 'timestamp', 'ts');
    if (dateRaw === undefined) throw new CsvError(`${where}: missing 'date' column`);

    const high = parseNumber(pick(row, 'high'), `${where} high`)!;
    const low = parseNumber(pick(row, 'low'), `${where} low`)!;
    const open = parseNumber(pick(row, 'open'), `${where} open`)!;
    const close = parseNumber(pick(row, 'close'), `${where} close`)!;

    if (high < low) throw new CsvError(`${where}: high ${high} is below low ${low}`);
    for (const [name, value] of [['open', open], ['close', close]] as const) {
      if (value > high || value < low) {
        throw new CsvError(`${where}: ${name} ${value} is outside the bar range ${low}-${high}`);
      }
    }

    return {
      symbol,
      timeframe: '1d',
      ts: parseDate(dateRaw),
      open,
      high,
      low,
      close,
      volume: parseNumber(pick(row, 'volume', 'qty', 'totaltradedquantity'), `${where} volume`, {
        optional: true,
      }),
      vwap: parseNumber(pick(row, 'vwap', 'avgprice'), `${where} vwap`, { optional: true }),
      provenance: PROVENANCE,
    } satisfies Candle;
  });
}

export function parseUniverseCsv(content: string, fileLabel: string): InstrumentRef[] {
  const { rows } = parseCsv(content);
  return rows.map((row, i) => {
    const where = `${fileLabel} row ${i + 2}`;
    const ref: InstrumentRef = {
      symbol: requireField(row, 'symbol', where).toUpperCase(),
    };
    const isin = pick(row, 'isin', 'isin code', 'isin_code');
    const name = pick(row, 'name', 'company name', 'company_name', 'security name');
    const sector = pick(row, 'sector', 'industry');
    const sectorIndex = pick(row, 'sector_index', 'sectorindex');
    const bseCode = pick(row, 'bse_code', 'bsecode', 'scrip_code');
    if (isin) ref.isin = isin;
    if (name) ref.name = name;
    if (sector) ref.sector = sector;
    if (sectorIndex) ref.sectorIndex = sectorIndex;
    if (bseCode) ref.bseCode = bseCode;
    return ref;
  });
}

export function parseEventCsv(content: string, fileLabel: string): RawAnnouncement[] {
  const { rows } = parseCsv(content);
  const detectedAt = new Date().toISOString();

  return rows.map((row, i) => {
    const where = `${fileLabel} row ${i + 2}`;
    const symbol = requireField(row, 'symbol', where).toUpperCase();
    const headline = requireField(row, 'headline', where);
    const filedRaw = pick(row, 'date', 'filed_at', 'timestamp');
    const filedAt = filedRaw ? tryParseTimestamp(filedRaw) : null;

    const announcement: RawAnnouncement = {
      dedupeKey: `${MANUAL_CSV_SOURCE_ID}:${symbol}:${filedAt ?? 'nodate'}:${headline.slice(0, 120)}`,
      symbol,
      exchange: pick(row, 'exchange') ?? null,
      headline,
      filedAt,
      detectedAt,
      sourceId: MANUAL_CSV_SOURCE_ID,
      sourceTier: 'PRIMARY_EXCHANGE',
    };
    const url = pick(row, 'url', 'link');
    const body = pick(row, 'body', 'description');
    if (url) announcement.url = url;
    if (body) announcement.body = body;
    return announcement;
  });
}

export class ManualCsvProvider implements MarketDataProvider {
  readonly id = MANUAL_CSV_SOURCE_ID;

  readonly capabilities: ProviderCapabilities = {
    timeframes: ['1d'],
    latencyClass: 'PERIODIC',
    fidelity: 'LOW',
    supportsQuotes: false,
    supportsStreaming: false,
    notes: [
      'Daily bars only. Whatever a human downloaded is all there is.',
      'No intraday data, so the price-reaction engine runs in EOD_PROXY mode.',
    ],
  };

  readonly #dir: string;
  #cache: Map<string, Candle[]> | null = null;

  constructor(opts: ManualCsvOptions) {
    this.#dir = opts.dir;
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(this.#dir);
  }

  /** All daily candles on disk, grouped by symbol and sorted by date. */
  loadAllCandles(): Map<string, Candle[]> {
    if (this.#cache) return this.#cache;

    const bySymbol = new Map<string, Candle[]>();
    for (const file of listCsvFiles(join(this.#dir, 'candles'))) {
      for (const candle of parseCandleCsv(readFileSync(file, 'utf8'), file)) {
        const list = bySymbol.get(candle.symbol);
        if (list) list.push(candle);
        else bySymbol.set(candle.symbol, [candle]);
      }
    }

    for (const [symbol, candles] of bySymbol) {
      candles.sort((a, b) => a.ts.localeCompare(b.ts));
      // Duplicate dates would silently corrupt every indicator downstream.
      for (let i = 1; i < candles.length; i++) {
        if (candles[i]!.ts === candles[i - 1]!.ts) {
          throw new CsvError(`duplicate candle for ${symbol} on ${candles[i]!.ts}`);
        }
      }
    }

    this.#cache = bySymbol;
    return bySymbol;
  }

  async getDailyCandles(symbol: string, range: DateRange): Promise<Candle[]> {
    const all = this.loadAllCandles().get(symbol.toUpperCase()) ?? [];
    const from = range.from.slice(0, 10);
    const to = range.to.slice(0, 10);
    return all.filter((c) => c.ts >= from && c.ts <= to);
  }

  async listInstruments(): Promise<InstrumentRef[]> {
    const path = join(this.#dir, 'universe.csv');
    if (!existsSync(path)) return [];
    return parseUniverseCsv(readFileSync(path, 'utf8'), path);
  }

  /** Announcements dropped as CSV. Not part of MarketDataProvider. */
  loadEvents(): RawAnnouncement[] {
    return listCsvFiles(join(this.#dir, 'events')).flatMap((file) =>
      parseEventCsv(readFileSync(file, 'utf8'), file),
    );
  }

  /** Forces a re-read on the next call. */
  invalidate(): void {
    this.#cache = null;
  }
}
