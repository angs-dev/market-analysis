/**
 * Test-only protobuf encoder.
 *
 * Builds real binary FeedResponse frames so the decoder is exercised against
 * genuine wire format rather than a hand-rolled object. Written independently
 * of the decoder — it shares no code with src/, so a bug in one cannot be
 * masked by a matching bug in the other.
 */

export function varint(value: number | bigint): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function tag(fieldNumber: number, wireType: number): Uint8Array {
  return varint((fieldNumber << 3) | wireType);
}

export function fieldDouble(fieldNumber: number, value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, value, true);
  return concat([tag(fieldNumber, 1), buf]);
}

export function fieldVarint(fieldNumber: number, value: number | bigint): Uint8Array {
  return concat([tag(fieldNumber, 0), varint(value)]);
}

export function fieldBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  return concat([tag(fieldNumber, 2), varint(value.length), value]);
}

export function fieldString(fieldNumber: number, value: string): Uint8Array {
  return fieldBytes(fieldNumber, new TextEncoder().encode(value));
}

export function message(...parts: Uint8Array[]): Uint8Array {
  return concat(parts);
}

// ── MarketDataFeedV3 builders ───────────────────────────────────────────────

export interface LtpcInput {
  ltp: number;
  ltt?: number;
  ltq?: number;
  cp?: number;
}

export function ltpc(input: LtpcInput): Uint8Array {
  const parts = [fieldDouble(1, input.ltp)];
  if (input.ltt !== undefined) parts.push(fieldVarint(2, input.ltt));
  if (input.ltq !== undefined) parts.push(fieldVarint(3, input.ltq));
  if (input.cp !== undefined) parts.push(fieldDouble(4, input.cp));
  return message(...parts);
}

export interface OhlcInput {
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol?: number;
  ts?: number;
}

export function ohlc(input: OhlcInput): Uint8Array {
  const parts = [
    fieldString(1, input.interval),
    fieldDouble(2, input.open),
    fieldDouble(3, input.high),
    fieldDouble(4, input.low),
    fieldDouble(5, input.close),
  ];
  if (input.vol !== undefined) parts.push(fieldVarint(6, input.vol));
  if (input.ts !== undefined) parts.push(fieldVarint(7, input.ts));
  return message(...parts);
}

export function marketFullFeed(opts: {
  ltpc: LtpcInput;
  vtt?: number;
  atp?: number;
  ohlc?: OhlcInput[];
}): Uint8Array {
  const parts = [fieldBytes(1, ltpc(opts.ltpc))];
  if (opts.ohlc && opts.ohlc.length > 0) {
    const marketOhlc = message(...opts.ohlc.map((o) => fieldBytes(1, ohlc(o))));
    parts.push(fieldBytes(4, marketOhlc));
  }
  if (opts.atp !== undefined) parts.push(fieldDouble(5, opts.atp));
  if (opts.vtt !== undefined) parts.push(fieldVarint(6, opts.vtt));
  return message(...parts);
}

export function indexFullFeed(opts: { ltpc: LtpcInput; ohlc?: OhlcInput[] }): Uint8Array {
  const parts = [fieldBytes(1, ltpc(opts.ltpc))];
  if (opts.ohlc && opts.ohlc.length > 0) {
    const marketOhlc = message(...opts.ohlc.map((o) => fieldBytes(1, ohlc(o))));
    parts.push(fieldBytes(2, marketOhlc));
  }
  return message(...parts);
}

/** Feed with a fullFeed.marketFF payload. */
export function equityFeed(opts: {
  ltpc: LtpcInput;
  vtt?: number;
  atp?: number;
  ohlc?: OhlcInput[];
  requestMode?: number;
}): Uint8Array {
  const full = message(fieldBytes(1, marketFullFeed(opts)));
  const parts = [fieldBytes(2, full)];
  if (opts.requestMode !== undefined) parts.push(fieldVarint(4, opts.requestMode));
  return message(...parts);
}

/** Feed with a fullFeed.indexFF payload. */
export function indexFeed(opts: { ltpc: LtpcInput; ohlc?: OhlcInput[] }): Uint8Array {
  const full = message(fieldBytes(2, indexFullFeed(opts)));
  return message(fieldBytes(2, full));
}

/** Feed carrying a bare LTPC (ltpc subscription mode). */
export function ltpcFeed(input: LtpcInput): Uint8Array {
  return message(fieldBytes(1, ltpc(input)));
}

/** map<string, Feed> entry. */
function feedMapEntry(key: string, feed: Uint8Array): Uint8Array {
  return fieldBytes(2, message(fieldString(1, key), fieldBytes(2, feed)));
}

/** map<string, MarketStatus> entry. */
function statusMapEntry(segment: string, status: number): Uint8Array {
  return fieldBytes(1, message(fieldString(1, segment), fieldVarint(2, status)));
}

export function feedResponse(opts: {
  type?: number;
  currentTs?: number;
  feeds?: Record<string, Uint8Array>;
  segmentStatus?: Record<string, number>;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.type !== undefined) parts.push(fieldVarint(1, opts.type));
  for (const [key, feed] of Object.entries(opts.feeds ?? {})) {
    parts.push(feedMapEntry(key, feed));
  }
  if (opts.currentTs !== undefined) parts.push(fieldVarint(3, opts.currentTs));
  if (opts.segmentStatus) {
    const info = message(
      ...Object.entries(opts.segmentStatus).map(([seg, st]) => statusMapEntry(seg, st)),
    );
    parts.push(fieldBytes(4, info));
  }
  return message(...parts);
}
