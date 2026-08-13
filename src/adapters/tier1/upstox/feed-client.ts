/**
 * Market Data Feed V3 WebSocket client.
 *
 * Responsibilities: connect, authorise, subscribe, decode, normalise, and stay
 * alive across disconnects. Everything time-dependent takes an injected Clock
 * and the socket comes from an injected factory, so reconnect, backoff and
 * heartbeat behaviour are tested deterministically without a network.
 *
 * Error philosophy: this client never throws to the caller for a runtime
 * condition. A dropped socket, an expired token, or a malformed frame is an
 * event on the health record and a scheduled retry — never a process exit
 * (requirements 10 and 11).
 */

import { decodeFeedResponse, FEED_TYPE, isMarketClosed } from './proto/feed.ts';
import { ProtoError } from './proto/wire.ts';
import { redact, redactUrl, type UpstoxCredentials } from './credentials.ts';
import { HealthTracker, type FeedHealth } from './health.ts';
import { TickSequencer, type RejectedTick, type Tick } from '../../../market/tick.ts';
import type { Clock } from '../../../sources/clock.ts';
import type { Provenance } from '../../../market/types.ts';

/** Subscription modes, using the documented request strings. */
export type FeedMode = 'ltpc' | 'full' | 'option_greeks' | 'full_d30';

export interface FeedSocket {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (data: Uint8Array) => void;
  onClose: (code: number, reason: string) => void;
  onError: (error: Error) => void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => FeedSocket;

/** Resolves the authorised wss endpoint. Injected so it can be faked. */
export type Authorizer = (credentials: UpstoxCredentials) => Promise<string>;

export class AuthError extends Error {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'AuthError';
    this.httpStatus = httpStatus;
  }
}

export interface FeedClientOptions {
  credentials: UpstoxCredentials;
  authorize: Authorizer;
  socketFactory: SocketFactory;
  clock: Clock;
  /** Instrument key to internal symbol. Unknown keys are rejected, not guessed. */
  instrumentMap: ReadonlyMap<string, string>;
  mode?: FeedMode;
  provenance?: Provenance;

  reconnect?: {
    baseMs?: number;
    maxMs?: number;
    /** 0 means retry forever, which is the sensible default for a live feed. */
    maxAttempts?: number;
  };
  /** Force a reconnect when no message arrives for this long. */
  heartbeatTimeoutMs?: number;
  /** Consecutive auth failures before the client stops retrying. */
  maxAuthFailures?: number;

  onTick?: (tick: Tick) => void;
  onRejected?: (rejected: RejectedTick) => void;
  onLog?: (line: string) => void;
  onStateChange?: (health: FeedHealth) => void;
}

const DEFAULT_PROVENANCE: Provenance = {
  sourceId: 'upstox_feed_v3',
  latencyClass: 'REALTIME',
  fidelity: 'HIGH',
};

export class UpstoxFeedClient {
  readonly #opts: FeedClientOptions;
  readonly #clock: Clock;
  readonly #health = new HealthTracker();
  readonly #sequencer = new TickSequencer();
  readonly #provenance: Provenance;

  #socket: FeedSocket | null = null;
  #instrumentKeys: string[] = [];
  #running = false;
  #attempt = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FeedClientOptions) {
    this.#opts = opts;
    this.#clock = opts.clock;
    this.#provenance = opts.provenance ?? DEFAULT_PROVENANCE;
  }

  get health(): FeedHealth {
    return this.#health.snapshot();
  }

  /** Redacts every log line, so a token can never reach the console. */
  #log(line: string): void {
    this.#opts.onLog?.(redact(line, this.#opts.credentials));
  }

  #setState(state: Parameters<HealthTracker['setState']>[0]): void {
    this.#health.setState(state, new Date(this.#clock.now()).toISOString());
    this.#opts.onStateChange?.(this.#health.snapshot());
  }

  async start(instrumentKeys: readonly string[]): Promise<void> {
    this.#instrumentKeys = [...instrumentKeys];
    this.#health.setSubscribed(this.#instrumentKeys.length);
    this.#running = true;
    this.#attempt = 0;
    await this.#connect();
  }

  stop(): void {
    this.#running = false;
    this.#stopHeartbeat();
    if (this.#socket) {
      try {
        this.#socket.close(1000, 'client shutdown');
      } catch {
        // Closing an already-dead socket is not an error worth surfacing.
      }
      this.#socket = null;
    }
    this.#setState('STOPPED');
  }

  async #connect(): Promise<void> {
    if (!this.#running) return;

    this.#setState(this.#attempt === 0 ? 'CONNECTING' : 'RECONNECTING');

    let url: string;
    try {
      this.#setState('AUTHENTICATING');
      url = await this.#opts.authorize(this.#opts.credentials);
    } catch (err) {
      await this.#handleAuthFailure(err);
      return;
    }

    this.#log(`connecting to ${redactUrl(url, this.#opts.credentials)}`);

    try {
      this.#socket = this.#opts.socketFactory(url, {
        onOpen: () => this.#handleOpen(),
        onMessage: (data) => this.#handleMessage(data),
        // WebSocket handlers are synchronous, so the async follow-up is
        // detached — but never silently. An unexpected throw in the reconnect
        // path is recorded rather than becoming an unhandled rejection.
        onClose: (code, reason) => {
          this.#handleClose(code, reason).catch((err: unknown) => {
            this.#health.recordSocketError(
              redact(`reconnect path failed: ${String(err)}`, this.#opts.credentials),
            );
          });
        },
        onError: (error) => this.#handleSocketError(error),
      });
    } catch (err) {
      this.#health.recordSocketError(redact(String(err), this.#opts.credentials));
      await this.#scheduleReconnect();
    }
  }

  #handleOpen(): void {
    this.#attempt = 0;
    this.#setState('CONNECTED');
    // The feed replays current state after a reconnect; those values are new to
    // the rebuilt candle even though they duplicate pre-drop ticks.
    this.#sequencer.softResetForReconnect();
    this.#health.recordMessage(new Date(this.#clock.now()).toISOString());
    this.#subscribe();
    this.#startHeartbeat();
  }

  /**
   * Subscription request. Sent as a binary frame — V3 rejects text frames.
   */
  #subscribe(): void {
    const payload = {
      guid: `swing10-${this.#clock.now()}`,
      method: 'sub',
      data: {
        mode: this.#opts.mode ?? 'full',
        instrumentKeys: this.#instrumentKeys,
      },
    };
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    this.#socket?.send(encoded);
    this.#log(
      `subscribed ${this.#instrumentKeys.length} instrument(s) in ` +
        `'${this.#opts.mode ?? 'full'}' mode`,
    );
  }

  #handleMessage(data: Uint8Array): void {
    const nowIso = new Date(this.#clock.now()).toISOString();
    this.#health.recordMessage(nowIso);

    let decoded;
    try {
      decoded = decodeFeedResponse(data);
    } catch (err) {
      const detail = err instanceof ProtoError ? err.message : String(err);
      this.#health.recordDecodeError(redact(detail, this.#opts.credentials));
      this.#log(`decode error, frame dropped: ${detail}`);
      return; // One bad frame must never take down the stream.
    }

    if (decoded.segmentStatus.size > 0) {
      const closed = isMarketClosed(decoded.segmentStatus);
      this.#health.setMarketStatus(
        closed ? 'CLOSED' : ([...decoded.segmentStatus.values()][0] ?? null),
      );
      if (closed) this.#log('feed reports all segments closed');
    }

    if (decoded.type === FEED_TYPE.market_info) return;

    for (const feed of decoded.feeds) {
      const tick = this.#normalize(feed, decoded.currentTs, nowIso);
      if (tick === null) continue;

      const rejection = this.#sequencer.accept(tick);
      if (rejection) {
        this.#health.recordRejection(rejection.reason);
        this.#opts.onRejected?.(rejection);
        continue;
      }

      this.#health.recordTick(nowIso, tick.latencyMs);
      this.#opts.onTick?.(tick);
    }
  }

  /** Provider payload to internal Tick (requirements 14 and 15). */
  #normalize(
    feed: ReturnType<typeof decodeFeedResponse>['feeds'][number],
    currentTs: number | null,
    receivedAt: string,
  ): Tick | null {
    const symbol = this.#opts.instrumentMap.get(feed.instrumentKey);
    if (symbol === undefined) {
      this.#health.recordRejection('UNKNOWN_INSTRUMENT');
      this.#opts.onRejected?.({
        reason: 'UNKNOWN_INSTRUMENT',
        instrumentKey: feed.instrumentKey,
        detail: 'instrument key is not in the configured universe',
      });
      return null;
    }

    if (!feed.ltpc) {
      this.#health.recordRejection('NO_PRICE');
      this.#opts.onRejected?.({
        reason: 'NO_PRICE',
        instrumentKey: feed.instrumentKey,
        detail: 'feed carried no LTPC block',
      });
      return null;
    }

    const { ltp } = feed.ltpc;
    if (!Number.isFinite(ltp) || ltp <= 0) {
      this.#health.recordRejection('NON_POSITIVE_PRICE');
      this.#opts.onRejected?.({
        reason: 'NON_POSITIVE_PRICE',
        instrumentKey: feed.instrumentKey,
        detail: `last traded price was ${ltp}`,
      });
      return null;
    }

    // Prefer the trade's own timestamp; fall back to the frame timestamp.
    const exchangeMs = feed.ltpc.ltt ?? currentTs;
    const exchangeTs =
      exchangeMs !== null && exchangeMs > 0 ? new Date(exchangeMs).toISOString() : null;
    const latencyMs =
      exchangeMs !== null && exchangeMs > 0 ? this.#clock.now() - exchangeMs : null;

    return {
      symbol,
      instrumentKey: feed.instrumentKey,
      ltp,
      ltq: feed.ltpc.ltq,
      volumeToday: feed.vtt,
      atp: feed.atp,
      prevClose: feed.ltpc.cp,
      exchangeTs,
      receivedAt,
      latencyMs,
      isIndex: feed.isIndex,
      provenance: this.#provenance,
    };
  }

  async #handleClose(code: number, reason: string): Promise<void> {
    this.#stopHeartbeat();
    this.#socket = null;
    if (!this.#running) return;

    this.#log(`socket closed (${code}${reason ? `: ${reason}` : ''})`);

    // 1008/4401/4403 are policy or auth closes rather than transport faults.
    if (code === 1008 || code === 4401 || code === 4403) {
      await this.#handleAuthFailure(new AuthError(`socket closed with code ${code}`, code));
      return;
    }
    await this.#scheduleReconnect();
  }

  #handleSocketError(error: Error): void {
    this.#health.recordSocketError(redact(error.message, this.#opts.credentials));
    this.#log(`socket error: ${error.message}`);
    // A close event follows an error; reconnect is scheduled there so the two
    // paths cannot race and produce two concurrent sockets.
  }

  /**
   * Auth failures never kill the process (requirement 10). The token is
   * re-read from the environment on each attempt, so refreshing it externally
   * is enough to recover without a restart.
   */
  async #handleAuthFailure(err: unknown): Promise<void> {
    const detail = redact(
      err instanceof Error ? err.message : String(err),
      this.#opts.credentials,
    );
    this.#health.recordAuthFailure(detail);
    this.#log(`authentication failed: ${detail}`);

    const limit = this.#opts.maxAuthFailures ?? 5;
    if (this.#health.snapshot().consecutiveAuthFailures >= limit) {
      this.#setState('AUTH_FAILED');
      this.#log(
        `giving up after ${limit} consecutive auth failures — the Analytics Token ` +
          `is likely expired or revoked. Regenerate it and restart. ` +
          `The process stays alive; the feed is simply stopped.`,
      );
      this.#running = false;
      return;
    }
    await this.#scheduleReconnect();
  }

  async #scheduleReconnect(): Promise<void> {
    if (!this.#running) return;

    const cfg = this.#opts.reconnect ?? {};
    const maxAttempts = cfg.maxAttempts ?? 0;
    if (maxAttempts > 0 && this.#attempt >= maxAttempts) {
      this.#log(`giving up after ${this.#attempt} reconnect attempt(s)`);
      this.#setState('STOPPED');
      this.#running = false;
      return;
    }

    const base = cfg.baseMs ?? 1_000;
    const max = cfg.maxMs ?? 60_000;
    // Exponential with full jitter, so many clients do not retry in lockstep.
    const exponential = Math.min(base * 2 ** this.#attempt, max);
    const delay = Math.round(exponential * (0.5 + this.#clock.random() * 0.5));

    this.#attempt++;
    this.#health.recordReconnect();
    this.#setState('RECONNECTING');
    this.#log(`reconnecting in ${delay}ms (attempt ${this.#attempt})`);

    await this.#clock.sleep(delay);
    await this.#connect();
  }

  // ── Heartbeat / staleness (requirement 12) ────────────────────────────────

  #startHeartbeat(): void {
    const timeout = this.#opts.heartbeatTimeoutMs ?? 30_000;
    if (timeout <= 0) return;
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => this.checkHeartbeat(), Math.max(1_000, timeout / 2));
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /**
   * Forces a reconnect when the socket is open but silent. A half-open TCP
   * connection looks perfectly healthy from the application's side, so silence
   * is the only available signal.
   *
   * Exposed for tests rather than being purely timer-driven.
   */
  checkHeartbeat(): boolean {
    const timeout = this.#opts.heartbeatTimeoutMs ?? 30_000;
    const silentFor = this.#health.msSinceLastMessage(this.#clock.now());
    if (silentFor === null || silentFor < timeout) return false;

    this.#log(`no message for ${silentFor}ms (timeout ${timeout}ms) — forcing reconnect`);
    this.#stopHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close(4000, 'heartbeat timeout');
    } catch {
      // Already gone; the reconnect below is what matters.
    }
    this.#scheduleReconnect().catch((err: unknown) => {
      this.#health.recordSocketError(
        redact(`heartbeat reconnect failed: ${String(err)}`, this.#opts.credentials),
      );
    });
    return true;
  }
}
