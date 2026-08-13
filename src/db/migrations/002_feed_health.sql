-- Live feed connection health (Milestone 2, requirement 13).
--
-- Snapshots are appended rather than updated in place so that connection
-- quality over a session is reviewable after the fact — "why did the reaction
-- engine miss 11:03?" is answerable only with a history.
--
-- No credential material is ever stored here.

CREATE TABLE feed_health (
  id                        INTEGER PRIMARY KEY,
  ts                        TEXT NOT NULL,
  source_id                 TEXT NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN
                              ('IDLE', 'CONNECTING', 'AUTHENTICATING', 'CONNECTED',
                               'RECONNECTING', 'AUTH_FAILED', 'STOPPED')),
  connected_at              TEXT,
  last_tick_at              TEXT,
  last_message_at           TEXT,
  reconnect_count           INTEGER NOT NULL DEFAULT 0,
  consecutive_auth_failures INTEGER NOT NULL DEFAULT 0,
  subscribed_instruments    INTEGER NOT NULL DEFAULT 0,
  ticks_received            INTEGER NOT NULL DEFAULT 0,
  ticks_rejected            INTEGER NOT NULL DEFAULT 0,
  rejections_by_reason_json TEXT,
  decode_errors             INTEGER NOT NULL DEFAULT 0,
  socket_errors             INTEGER NOT NULL DEFAULT 0,
  mean_latency_ms           REAL,
  max_latency_ms            REAL,
  market_status             TEXT,
  last_error                TEXT
);
CREATE INDEX idx_feed_health_ts ON feed_health(source_id, ts);

-- Individual rejected ticks, so data-quality problems are diagnosable rather
-- than merely counted.
CREATE TABLE tick_rejections (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  instrument_key TEXT NOT NULL,
  reason         TEXT NOT NULL,
  detail         TEXT
);
CREATE INDEX idx_tick_rejections_reason ON tick_rejections(reason, ts);
