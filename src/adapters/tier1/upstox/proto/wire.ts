/**
 * Minimal protobuf wire-format reader.
 *
 * Only what the Market Data Feed V3 schema needs: varint, fixed64 (double),
 * fixed32 and length-delimited fields. No reflection, no code generation, no
 * dependency. Unknown fields are skipped rather than erroring, which is what
 * protobuf compatibility requires — Upstox adding a field must not break us.
 *
 * Wire types:
 *   0 varint            int32/int64/uint/bool/enum
 *   1 fixed64           double
 *   2 length-delimited  string/bytes/embedded message/map entry
 *   5 fixed32           float
 */

export class ProtoError extends Error {}

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH = 2;
export const WIRE_FIXED32 = 5;

export interface Field {
  wireType: number;
  /** Varints and fixed ints. */
  varint?: bigint;
  /** Fixed64/32 raw bytes, for float interpretation. */
  bytes?: Uint8Array;
}

/** Decoded message: field number to the list of values seen for it. */
export type Message = Map<number, Field[]>;

class Reader {
  readonly #buf: Uint8Array;
  readonly #view: DataView;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done(): boolean {
    return this.#pos >= this.#buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.#pos >= this.#buf.length) throw new ProtoError('truncated varint');
      const byte = this.#buf[this.#pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new ProtoError('varint exceeds 10 bytes');
  }

  fixed(n: number): Uint8Array {
    if (this.#pos + n > this.#buf.length) throw new ProtoError(`truncated fixed${n * 8}`);
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  length(): Uint8Array {
    const len = Number(this.varint());
    if (len < 0 || this.#pos + len > this.#buf.length) {
      throw new ProtoError('length-delimited field overruns buffer');
    }
    const out = this.#buf.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    return out;
  }

  get view(): DataView {
    return this.#view;
  }
}

export function decodeMessage(buf: Uint8Array): Message {
  const reader = new Reader(buf);
  const out: Message = new Map();

  while (!reader.done) {
    const tag = reader.varint();
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (fieldNumber === 0) throw new ProtoError('field number 0 is invalid');

    let field: Field;
    switch (wireType) {
      case WIRE_VARINT:
        field = { wireType, varint: reader.varint() };
        break;
      case WIRE_FIXED64:
        field = { wireType, bytes: reader.fixed(8) };
        break;
      case WIRE_LENGTH:
        field = { wireType, bytes: reader.length() };
        break;
      case WIRE_FIXED32:
        field = { wireType, bytes: reader.fixed(4) };
        break;
      default:
        // Groups (3, 4) are not used by this schema and cannot be skipped safely.
        throw new ProtoError(`unsupported wire type ${wireType} on field ${fieldNumber}`);
    }

    const existing = out.get(fieldNumber);
    if (existing) existing.push(field);
    else out.set(fieldNumber, [field]);
  }
  return out;
}

// ── Typed accessors. Each returns undefined when the field is absent, so a
// missing field is distinguishable from a zero value. ──────────────────────

function first(msg: Message, field: number): Field | undefined {
  return msg.get(field)?.[0];
}

export function getDouble(msg: Message, field: number): number | undefined {
  const f = first(msg, field);
  if (!f?.bytes || f.wireType !== WIRE_FIXED64) return undefined;
  return new DataView(f.bytes.buffer, f.bytes.byteOffset, 8).getFloat64(0, true);
}

export function getInt64(msg: Message, field: number): number | undefined {
  const f = first(msg, field);
  if (f?.varint === undefined) return undefined;
  // Values here are timestamps, quantities and enums — all well inside the
  // safe integer range. Anything larger indicates a decode error, not real data.
  const asBigInt = BigInt.asIntN(64, f.varint);
  const n = Number(asBigInt);
  if (!Number.isSafeInteger(n)) {
    throw new ProtoError(`int64 field ${field} exceeds safe integer range: ${asBigInt}`);
  }
  return n;
}

export function getEnum(msg: Message, field: number): number | undefined {
  return getInt64(msg, field);
}

export function getString(msg: Message, field: number): string | undefined {
  const f = first(msg, field);
  if (!f?.bytes || f.wireType !== WIRE_LENGTH) return undefined;
  return new TextDecoder().decode(f.bytes);
}

export function getMessage(msg: Message, field: number): Message | undefined {
  const f = first(msg, field);
  if (!f?.bytes || f.wireType !== WIRE_LENGTH) return undefined;
  return decodeMessage(f.bytes);
}

export function getRepeatedMessage(msg: Message, field: number): Message[] {
  return (msg.get(field) ?? [])
    .filter((f) => f.wireType === WIRE_LENGTH && f.bytes)
    .map((f) => decodeMessage(f.bytes!));
}

/**
 * Decodes a protobuf `map<string, V>` field. Map entries are encoded as
 * repeated messages with key at field 1 and value at field 2.
 */
export function getMap(msg: Message, field: number): Map<string, Message> {
  const out = new Map<string, Message>();
  for (const entry of getRepeatedMessage(msg, field)) {
    const key = getString(entry, 1);
    if (key === undefined) continue;
    out.set(key, getMessage(entry, 2) ?? new Map());
  }
  return out;
}

/** Map whose values are enums/varints rather than messages. */
export function getEnumMap(msg: Message, field: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of getRepeatedMessage(msg, field)) {
    const key = getString(entry, 1);
    if (key === undefined) continue;
    out.set(key, getInt64(entry, 2) ?? 0);
  }
  return out;
}
