/**
 * Injectable clock. Rate limiting and backoff are time-dependent, so time is a
 * dependency rather than an ambient global — otherwise the tests for those
 * behaviours would have to actually wait.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Returns a value in [0, 1). Injected so jitter is deterministic in tests. */
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Test clock: time only advances when told to. `sleep` resolves immediately
 * but advances virtual time, so rate-limit waits are instant and exact.
 */
export class FakeClock implements Clock {
  #now: number;
  #random: number;
  /** Every sleep duration requested, in order — lets tests assert on backoff. */
  readonly sleeps: number[] = [];

  constructor(startMs = 0, random = 0.5) {
    this.#now = startMs;
    this.#random = random;
  }

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
  }

  random(): number {
    return this.#random;
  }

  setRandom(value: number): void {
    this.#random = value;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
