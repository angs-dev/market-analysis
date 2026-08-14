/**
 * NSE market session logic, in Asia/Kolkata.
 *
 * Every scheduling decision in the system goes through here. Cron — whether
 * node-cron locally or GitHub Actions in UTC — is never trusted to know
 * whether the market is open; it only decides how often to ask.
 *
 * Timezone handling uses Intl rather than a fixed +5:30 offset. India does not
 * observe DST today, but hard-coding an offset is the kind of assumption that
 * silently breaks and is impossible to notice from the output.
 */

export const MARKET_TIMEZONE = 'Asia/Kolkata';

export type MarketStatus =
  | 'PRE_OPEN'
  | 'OPEN'
  | 'CLOSED'
  | 'WEEKEND'
  | 'HOLIDAY'
  | 'POST_CLOSE';

export interface SessionWindow {
  /** Minutes from IST midnight. */
  preOpenStart: number;
  preOpenEnd: number;
  open: number;
  close: number;
  postCloseEnd: number;
}

/** NSE equity segment. Minutes from IST midnight. */
export const DEFAULT_SESSION: SessionWindow = {
  preOpenStart: 9 * 60,       // 09:00
  preOpenEnd: 9 * 60 + 8,     // 09:08
  open: 9 * 60 + 15,          // 09:15
  close: 15 * 60 + 30,        // 15:30
  postCloseEnd: 16 * 60,      // 16:00
};

export interface SessionConfig {
  window?: SessionWindow;
  /** ISO dates (YYYY-MM-DD) on which the exchange is shut. */
  holidays?: ReadonlySet<string>;
  /** Dates that are open despite falling on a weekend (muhurat, special sessions). */
  specialSessions?: ReadonlySet<string>;
}

interface IstParts {
  date: string;
  minutes: number;
  weekday: number;
}

/** Decomposes an instant into IST date, minutes-from-midnight and weekday. */
export function toIst(at: Date = new Date()): IstParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const weekdayIndex: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    // Intl renders midnight as "24" in some locales; normalise it.
    minutes: (Number(parts['hour']) % 24) * 60 + Number(parts['minute']),
    weekday: weekdayIndex[parts['weekday'] ?? 'Mon'] ?? 1,
  };
}

export interface SessionState {
  status: MarketStatus;
  /** IST date of the instant examined. */
  date: string;
  /** IST clock, HH:MM. */
  time: string;
  /** True only during the continuous trading session. */
  isOpen: boolean;
  /** True when scanning is worthwhile: pre-open through post-close. */
  isScanWindow: boolean;
  /** Minutes until the next state change, when knowable. */
  minutesToOpen: number | null;
  minutesToClose: number | null;
  reason: string;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function marketSession(at: Date = new Date(), config: SessionConfig = {}): SessionState {
  const window = config.window ?? DEFAULT_SESSION;
  const { date, minutes, weekday } = toIst(at);
  const time = hhmm(minutes);

  const base = {
    date, time, isOpen: false, isScanWindow: false,
    minutesToOpen: null as number | null,
    minutesToClose: null as number | null,
  };

  const isSpecial = config.specialSessions?.has(date) ?? false;

  if (config.holidays?.has(date) && !isSpecial) {
    return { ...base, status: 'HOLIDAY', reason: `${date} is an exchange holiday` };
  }

  if ((weekday === 0 || weekday === 6) && !isSpecial) {
    return { ...base, status: 'WEEKEND', reason: `${date} falls on a weekend` };
  }

  if (minutes >= window.open && minutes < window.close) {
    return {
      ...base,
      status: 'OPEN',
      isOpen: true,
      isScanWindow: true,
      minutesToClose: window.close - minutes,
      reason: `continuous session, closes at ${hhmm(window.close)} IST`,
    };
  }

  if (minutes >= window.preOpenStart && minutes < window.open) {
    return {
      ...base,
      status: 'PRE_OPEN',
      isScanWindow: true,
      minutesToOpen: window.open - minutes,
      reason: `pre-open, continuous session begins at ${hhmm(window.open)} IST`,
    };
  }

  if (minutes >= window.close && minutes < window.postCloseEnd) {
    return {
      ...base,
      status: 'POST_CLOSE',
      // Announcements land heavily after the close; keep scanning for events.
      isScanWindow: true,
      reason: 'post-close window — results and filings are commonly published now',
    };
  }

  return {
    ...base,
    status: 'CLOSED',
    minutesToOpen: minutes < window.open ? window.open - minutes : null,
    reason: `outside session hours (${hhmm(window.open)}-${hhmm(window.close)} IST)`,
  };
}

/**
 * Holiday list. Deliberately empty by default rather than guessed.
 *
 * NSE publishes holidays annually and they shift every year; inventing dates
 * would cause the scanner to either skip a trading day or hammer sources on a
 * closed one. Populate config/holidays.json from the official list.
 */
export function loadHolidays(dates: readonly string[] = []): Set<string> {
  const valid = new Set<string>();
  for (const date of dates) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) valid.add(date);
  }
  return valid;
}
