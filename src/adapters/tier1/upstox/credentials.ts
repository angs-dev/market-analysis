/**
 * Upstox credential handling.
 *
 * The Analytics Token is read-only and cannot place, modify, or cancel orders.
 * It is still a bearer credential with a one-year life, so it is treated as a
 * secret: loaded only from the local environment, never written to the
 * database, never included in a log line, error message, or health snapshot.
 *
 * Everything that could carry the token outward goes through redact().
 */

export const TOKEN_ENV = 'UPSTOX_ANALYTICS_TOKEN';

export class CredentialError extends Error {}

/**
 * Opaque wrapper. The token is held in a private field and the class overrides
 * every implicit stringification path, so an accidental
 * `console.log(credentials)` or `JSON.stringify(credentials)` cannot leak it.
 */
export class UpstoxCredentials {
  readonly #token: string;

  private constructor(token: string) {
    this.#token = token;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): UpstoxCredentials {
    const token = env[TOKEN_ENV];
    if (!token || token.trim() === '') {
      throw new CredentialError(
        `${TOKEN_ENV} is not set. Generate a read-only Analytics Token from the ` +
          `Upstox Developer Apps page and export it locally. Never commit it.`,
      );
    }
    return new UpstoxCredentials(token.trim());
  }

  /** Explicit, greppable accessor — the only way to read the raw value. */
  reveal(): string {
    return this.#token;
  }

  authHeader(): { Authorization: string } {
    return { Authorization: `Bearer ${this.#token}` };
  }

  /** Non-reversible fingerprint, safe to log, for telling two tokens apart. */
  fingerprint(): string {
    let hash = 0;
    for (let i = 0; i < this.#token.length; i++) {
      hash = (Math.imul(31, hash) + this.#token.charCodeAt(i)) | 0;
    }
    return `tok_${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  toString(): string {
    return `UpstoxCredentials(${this.fingerprint()})`;
  }

  toJSON(): string {
    return `UpstoxCredentials(${this.fingerprint()})`;
  }

  get [Symbol.toStringTag](): string {
    return 'UpstoxCredentials';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

/**
 * Removes anything token-shaped from arbitrary text before it is logged.
 *
 * Applied to every outbound log line and error message. Deliberately
 * over-broad: redacting a harmless string is free, leaking a bearer token is
 * not. When `known` is supplied its exact value is removed too, which covers
 * tokens that do not match the generic shapes.
 */
export function redact(text: string, known?: UpstoxCredentials): string {
  let out = text;

  if (known) {
    const raw = known.reveal();
    if (raw.length > 0) out = out.split(raw).join('[REDACTED]');
  }

  return out
    // Authorization: Bearer <token>
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    // JWT-shaped values
    .replace(/\beyJ[A-Za-z0-9._-]{16,}/g, '[REDACTED]')
    // token=... / access_token=... in query strings or bodies
    .replace(
      /\b((?:access_)?token|auth|apikey|api_key)([=:"']\s*)[A-Za-z0-9._~+/=-]{8,}/gi,
      '$1$2[REDACTED]',
    );
}

/** Strips credential-bearing query parameters from a URL before logging. */
export function redactUrl(url: string, known?: UpstoxCredentials): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|auth|key|sig|signature/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return redact(parsed.toString(), known);
  } catch {
    return redact(url, known);
  }
}
