-- Scan orchestration state (Milestone 6).
--
-- Additive only: nothing in 001 or 002 is altered. Raw feature vectors and
-- score contributions continue to live in candidate_features and
-- score_contributions, untouched, so historical data stays re-scorable when
-- weights change.

-- One row per ScanEngine cycle, local or GitHub Actions.
CREATE TABLE scan_runs (
  id                INTEGER PRIMARY KEY,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('LOCAL', 'ONCE', 'MANUAL', 'REPLAY')),
  trigger           TEXT NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL', 'STARTUP')),
  market_status     TEXT NOT NULL,
  market_regime     TEXT,
  regime_score      REAL,
  -- Stage 1 examined this many symbols; stage 2 promoted this many.
  symbols_screened  INTEGER NOT NULL DEFAULT 0,
  symbols_deep      INTEGER NOT NULL DEFAULT 0,
  new_events        INTEGER NOT NULL DEFAULT 0,
  candidates        INTEGER NOT NULL DEFAULT 0,
  paper_buys        INTEGER NOT NULL DEFAULT 0,
  watches           INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  no_trade_reason   TEXT,
  error             TEXT,
  data_freshness_json TEXT
);
CREATE INDEX idx_scan_runs_started ON scan_runs(started_at);

-- Links a scan run to the candidates it produced. The candidate itself, with
-- its features and explanations, stays in the existing tables.
CREATE TABLE scan_candidates (
  scan_run_id   INTEGER NOT NULL REFERENCES scan_runs(id),
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id),
  rank          INTEGER,
  triggered_by  TEXT,
  PRIMARY KEY (scan_run_id, candidate_id)
) WITHOUT ROWID;

-- Current signal state per symbol, so alerts fire on transitions rather than
-- on every scan. This is the table that stops a 5-minute workflow sending the
-- same alert twelve times an hour.
CREATE TABLE signal_state (
  symbol            TEXT PRIMARY KEY,
  action            TEXT NOT NULL,
  swing10_score     REAL,
  event_quality     REAL,
  trade_quality     REAL,
  event_id          INTEGER,
  candidate_id      INTEGER,
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  /* Set when a PAPER_BUY later fails its conditions. */
  invalidated_at    TEXT,
  invalidation_reason TEXT
);

-- Every alert considered, sent or suppressed, with the reason.
CREATE TABLE alert_log (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  symbol        TEXT,
  transition    TEXT NOT NULL,
  from_action   TEXT,
  to_action     TEXT,
  channel       TEXT NOT NULL,
  sent          INTEGER NOT NULL DEFAULT 0,
  suppressed_reason TEXT,
  payload_json  TEXT,
  error         TEXT
);
CREATE INDEX idx_alert_log_symbol_ts ON alert_log(symbol, ts);

-- Cooperative lock preventing overlapping scans within a process and across
-- a local scheduler and a manually triggered scan.
CREATE TABLE scan_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at    TEXT,
  locked_by    TEXT,
  expires_at   TEXT
);
INSERT INTO scan_lock (id, locked_at, locked_by, expires_at) VALUES (1, NULL, NULL, NULL);

-- Point-in-time market context per scan, so a historical candidate can be
-- read back with the regime that produced it.
CREATE TABLE market_snapshots (
  id             INTEGER PRIMARY KEY,
  scan_run_id    INTEGER REFERENCES scan_runs(id),
  ts             TEXT NOT NULL,
  nifty          REAL,
  nifty_change_pct REAL,
  banknifty_change_pct REAL,
  vix            REAL,
  breadth_ratio  REAL,
  regime_label   TEXT,
  regime_score   REAL,
  unstable       INTEGER NOT NULL DEFAULT 0,
  completeness   REAL,
  missing_json   TEXT
);

-- Widen data_sources.latency_class to admit NEAR_REALTIME.
-- SQLite cannot alter a CHECK constraint in place. This table is derived
-- entirely from config/sources.json and re-persisted on every db:init, so a
-- rebuild carries no risk of losing authored data.
CREATE TABLE data_sources_new (
  id                TEXT PRIMARY KEY,
  tier              INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
  latency_class     TEXT    NOT NULL CHECK (latency_class IN
                      ('REALTIME', 'NEAR_REALTIME', 'DELAYED', 'PERIODIC', 'UNKNOWN')),
  legal_basis       TEXT    NOT NULL CHECK (legal_basis IN
                      ('PUBLISHED_FILE', 'BROKER_LICENSED', 'RSS_SYNDICATION',
                       'MANUAL_HUMAN', 'TOS_GREY')),
  attribution_text  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  requires_opt_in   INTEGER NOT NULL DEFAULT 0,
  policy_json       TEXT    NOT NULL,
  breaker_state     TEXT    NOT NULL DEFAULT 'CLOSED' CHECK (breaker_state IN
                      ('CLOSED', 'OPEN', 'HALF_OPEN', 'HARD_STOPPED')),
  breaker_reason    TEXT,
  last_ok_at        TEXT,
  updated_at        TEXT    NOT NULL
);
INSERT INTO data_sources_new SELECT * FROM data_sources;
DROP TABLE data_sources;
ALTER TABLE data_sources_new RENAME TO data_sources;
