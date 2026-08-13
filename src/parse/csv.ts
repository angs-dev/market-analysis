/**
 * Minimal RFC 4180 CSV reader.
 *
 * Handles quoted fields, embedded commas and newlines, escaped quotes (""),
 * CRLF, and a UTF-8 BOM. No dependencies — CSV is the one format simple enough
 * that pulling in a library costs more than it saves.
 */

export interface CsvOptions {
  delimiter?: string;
  /** Treat the first non-empty row as a header. Default true. */
  header?: boolean;
  /** Skip rows that are entirely empty. Default true. */
  skipEmptyLines?: boolean;
}

export class CsvError extends Error {}

/** Parses to a matrix of raw string cells. */
export function parseCsvRows(input: string, opts: CsvOptions = {}): string[][] {
  const delimiter = opts.delimiter ?? ',';
  if (delimiter.length !== 1) throw new CsvError('delimiter must be a single character');

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = (): void => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      field = '';
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }

  // Trailing field, unless the input ended exactly on a row boundary.
  if (field !== '' || row.length > 0) endRow();
  if (inQuotes) throw new CsvError('unterminated quoted field');

  return opts.skipEmptyLines === false
    ? rows
    : rows.filter((r) => r.some((c) => c !== ''));
}

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parses to objects keyed by header. Headers are lower-cased and trimmed so
 * `Symbol`, `SYMBOL` and `symbol` all resolve the same way — exchange files are
 * inconsistent about this.
 */
export function parseCsv(input: string, opts: CsvOptions = {}): CsvTable {
  const raw = parseCsvRows(input, opts);
  if (raw.length === 0) return { headers: [], rows: [] };

  if (opts.header === false) {
    const width = Math.max(...raw.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => `col${i}`);
    return {
      headers,
      rows: raw.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    };
  }

  const headers = raw[0]!.map((h) => h.trim().toLowerCase());
  const rows = raw.slice(1).map((cells, rowIndex) => {
    if (cells.length !== headers.length) {
      throw new CsvError(
        `row ${rowIndex + 2} has ${cells.length} field(s), expected ${headers.length}`,
      );
    }
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });

  return { headers, rows };
}

/** Reads a required column, failing loudly rather than coercing silently. */
export function requireField(row: Record<string, string>, key: string, context: string): string {
  const value = row[key];
  if (value === undefined || value === '') {
    throw new CsvError(`${context}: missing required column '${key}'`);
  }
  return value;
}

/**
 * Numeric parse that rejects junk instead of producing NaN. Handles the comma
 * grouping and '-' placeholders that appear in Indian exchange files.
 */
export function parseNumber(
  value: string | undefined,
  context: string,
  opts: { optional?: boolean } = {},
): number | null {
  const raw = (value ?? '').trim().replace(/,/g, '');
  if (raw === '' || raw === '-' || raw.toUpperCase() === 'NA' || raw.toUpperCase() === 'NULL') {
    if (opts.optional) return null;
    throw new CsvError(`${context}: expected a number, got '${value ?? ''}'`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new CsvError(`${context}: '${value}' is not a finite number`);
  return n;
}
