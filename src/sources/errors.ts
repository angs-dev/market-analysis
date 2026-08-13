import type { AttemptOutcome } from './types.ts';

/** Base for anything the governor raises. */
export class SourceError extends Error {
  readonly sourceId: string;

  constructor(message: string, sourceId: string) {
    super(message);
    this.name = new.target.name;
    this.sourceId = sourceId;
  }
}

/**
 * The source told us to stop (typically HTTP 403). Never retried.
 * Being blocked is an instruction, not a transient fault.
 */
export class SourceBlockedError extends SourceError {
  readonly httpStatus: number;

  constructor(sourceId: string, httpStatus: number) {
    super(
      `Source '${sourceId}' returned ${httpStatus} — treated as a stop instruction, not retried`,
      sourceId,
    );
    this.httpStatus = httpStatus;
  }
}

/** The circuit is open (soft failures) or hard-stopped (repeated blocks). */
export class SourceUnavailableError extends SourceError {
  readonly reason: string;

  constructor(sourceId: string, reason: string) {
    super(`Source '${sourceId}' unavailable: ${reason}`, sourceId);
    this.reason = reason;
  }
}

/** Retries were exhausted against a retryable status. */
export class SourceExhaustedError extends SourceError {
  readonly attempts: number;
  readonly lastOutcome: AttemptOutcome | undefined;

  constructor(sourceId: string, attempts: number, lastOutcome?: AttemptOutcome) {
    super(
      `Source '${sourceId}' failed after ${attempts} attempt(s)` +
        (lastOutcome?.httpStatus ? ` (last status ${lastOutcome.httpStatus})` : ''),
      sourceId,
    );
    this.attempts = attempts;
    this.lastOutcome = lastOutcome;
  }
}

/** A source was requested that is disabled, unregistered, or not opted into. */
export class SourceNotPermittedError extends SourceError {}

/** Raised by adapters so the governor can read the HTTP status. */
export class HttpStatusError extends Error {
  readonly httpStatus: number;
  readonly retryAfterMs: number | undefined;

  constructor(httpStatus: number, retryAfterMs?: number, message?: string) {
    super(message ?? `HTTP ${httpStatus}`);
    this.name = 'HttpStatusError';
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}
