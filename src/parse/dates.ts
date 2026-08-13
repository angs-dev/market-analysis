/**
 * Date normalisation.
 *
 * Indian exchange files and news feeds use several formats interchangeably:
 * 2026-01-15, 15-01-2026, 15/01/2026, 15-Jan-2026, RFC 822 timestamps. All are
 * normalised to ISO. Ambiguous day/month ordering resolves to day-first, which
 * is the Indian convention — where a value could be either, that assumption is
 * applied and documented rather than guessed per-row.
 */

export class DateParseError extends Error {}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isValid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parses a calendar date to `YYYY-MM-DD`. Throws on anything unrecognised. */
export function parseDate(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new DateParseError('empty date');

  // ISO first — unambiguous.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isValid(y, m, d)) throw new DateParseError(`invalid date '${raw}'`);
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  // 15-Jan-2026 / 15 Jan 2026 / 15-JAN-26
  const named = /^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})$/.exec(raw);
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (month === undefined) throw new DateParseError(`unknown month in '${raw}'`);
    const d = Number(named[1]);
    const y = normaliseYear(Number(named[3]));
    if (!isValid(y, month, d)) throw new DateParseError(`invalid date '${raw}'`);
    return `${y}-${pad(month)}-${pad(d)}`;
  }

  // 15-01-2026 / 15/01/2026 — day-first (Indian convention).
  const numeric = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(raw);
  if (numeric) {
    const d = Number(numeric[1]);
    const m = Number(numeric[2]);
    const y = normaliseYear(Number(numeric[3]));
    if (!isValid(y, m, d)) throw new DateParseError(`invalid date '${raw}' (parsed day-first)`);
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  throw new DateParseError(`unrecognised date format: '${raw}'`);
}

function normaliseYear(y: number): number {
  if (y >= 1000) return y;
  // Two-digit years: 70-99 => 1900s, 00-69 => 2000s.
  return y >= 70 ? 1900 + y : 2000 + y;
}

/**
 * Parses a timestamp to a full ISO-8601 UTC string. Accepts RFC 822 (RSS
 * pubDate), ISO 8601 (Atom), and bare dates, which become midnight UTC.
 */
export function parseTimestamp(input: string): string {
  const raw = input.trim();
  if (raw === '') throw new DateParseError('empty timestamp');

  // Date only — no time component to interpret.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${parseDate(raw)}T00:00:00.000Z`;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  // Fall back to the date-only parsers for formats Date cannot read.
  return `${parseDate(raw)}T00:00:00.000Z`;
}

/** Best-effort timestamp parse: returns null instead of throwing. */
export function tryParseTimestamp(input: string | undefined): string | null {
  if (!input) return null;
  try {
    return parseTimestamp(input);
  } catch {
    return null;
  }
}

/** The IST trading date for a timestamp. NSE/BSE sessions are anchored to IST. */
export function tradingDate(isoTimestamp: string): string {
  const ms = new Date(isoTimestamp).getTime();
  if (Number.isNaN(ms)) throw new DateParseError(`invalid timestamp '${isoTimestamp}'`);
  const ist = new Date(ms + 5.5 * 3_600_000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}
