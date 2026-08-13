-- SWING-10 initial schema.
--
-- Design notes that matter:
--   * Raw features are persisted verbatim in candidate_features so all history
--     can be re-scored offline under new weights without refetching anything.
--   * Every candidate is stored, including rejects, with its rejection reason.
--   * Explainability is stored as ROWS (score_contributions), not a blob, so
--     "which features predict winners" is a query rather than a script.
--   * Every price-bearing row carries source_id + latency_class + fidelity.
--     Nothing in this database is allowed to claim real-time provenance it
--     cannot demonstrate.

-- ════════════════════ SOURCE GOVERNANCE ════════════════════

CREATE TABLE data_sources (
  id                TEXT PRIMARY KEY,
  tier              INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
  latency_class     TEXT    NOT NULL CHECK (latency_class IN
                      ('REALTIME', 'DELAYED', 'PERIODIC', 'UNKNOWN')),
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

-- Audit trail of our own outbound behaviour. If a source ever asks how we
-- behaved, this table is the answer.
CREATE TABLE source_requests (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT    NOT NULL REFERENCES data_sources(id),
  ts            TEXT    NOT NULL,
  url_hash      TEXT,
  http_status   INTEGER,
  latency_ms    INTEGER,
  from_cache    INTEGER NOT NULL DEFAULT 0,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX idx_source_requests_source_ts ON source_requests(source_id, ts);

-- ════════════════════ REFERENCE / MARKET DATA ════════════════════

CREATE TABLE instruments (
  symbol            TEXT PRIMARY KEY,
  isin              TEXT,
  bse_code          TEXT,
  name              TEXT,
  sector            TEXT,
  sector_index      TEXT,
  broker_token      TEXT,
  in_nifty500       INTEGER NOT NULL DEFAULT 0,
  avg_turnover_20d  REAL,
  is_tradeable      INTEGER NOT NULL DEFAULT 1,
  exclusion_reason  TEXT,
  updated_at        TEXT
);
CREATE INDEX idx_instruments_tradeable ON instruments(is_tradeable, in_nifty500);

CREATE TABLE candles (
  symbol         TEXT    NOT NULL,
  tf             TEXT    NOT NULL,   -- '1m','5m','15m','1d','1w'
  ts             TEXT    NOT NULL,
  open           REAL    NOT NULL,
  high           REAL    NOT NULL,
  low            REAL    NOT NULL,
  close          REAL    NOT NULL,
  volume         INTEGER,
  vwap           REAL,
  source_id      TEXT    NOT NULL,
  latency_class  TEXT    NOT NULL,
  fidelity       TEXT    NOT NULL CHECK (fidelity IN
                   ('HIGH', 'MEDIUM', 'LOW', 'UNAVAILABLE')),
  PRIMARY KEY (symbol, tf, ts)
) WITHOUT ROWID;

CREATE TABLE market_context (
  ts                    TEXT PRIMARY KEY,
  nifty                 REAL,
  nifty_change_pct      REAL,
  nifty_trend           TEXT,
  banknifty_change_pct  REAL,
  vix                   REAL,
  vix_change_pct        REAL,
  advances              INTEGER,
  declines              INTEGER,
  breadth_ratio         REAL,
  sector_returns_json   TEXT,
  fii_net               REAL,   -- EOD only; never populated intraday
  dii_net               REAL,   -- EOD only; never populated intraday
  regime_label          TEXT CHECK (regime_label IN
                          ('RISK_ON', 'NEUTRAL', 'RISK_OFF', 'UNSTABLE')),
  regime_score          REAL,
  unstable              INTEGER NOT NULL DEFAULT 0,
  completeness          REAL,
  missing_inputs_json   TEXT
);

-- ════════════════════ EVENTS + FUNDAMENTALS ════════════════════

CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  symbol             TEXT NOT NULL,
  exchange           TEXT,
  filed_at           TEXT,    -- exchange timestamp
  detected_at        TEXT,    -- when WE saw it — measures our true lag
  detection_lag_sec  INTEGER,
  event_type         TEXT,
  headline           TEXT,
  attachment_url     TEXT,
  source_id          TEXT NOT NULL,
  source_tier        TEXT CHECK (source_tier IN
                       ('PRIMARY_EXCHANGE', 'SECONDARY_NEWS')),
  materiality        REAL,
  sentiment          TEXT CHECK (sentiment IN
                       ('POSITIVE', 'NEGATIVE', 'NEUTRAL', 'AMBIGUOUS')),
  dedupe_key         TEXT UNIQUE,
  raw_path           TEXT
);
CREATE INDEX idx_events_symbol_filed ON events(symbol, filed_at);
CREATE INDEX idx_events_type ON events(event_type, filed_at);

CREATE TABLE fundamentals_quarterly (
  symbol                TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  filed_at              TEXT,
  event_id              INTEGER REFERENCES events(id),
  revenue               REAL,
  ebitda                REAL,
  ebitda_margin         REAL,
  pat                   REAL,
  eps                   REAL,
  other_income          REAL,
  exceptional_items     REAL,
  tax_expense           REAL,
  effective_tax_rate    REAL,
  interest              REAL,
  depreciation          REAL,
  revenue_yoy           REAL,
  revenue_qoq           REAL,
  pat_yoy               REAL,
  pat_qoq               REAL,
  ebitda_yoy            REAL,
  margin_delta_yoy      REAL,
  eps_yoy               REAL,
  -- The recurring-vs-one-off verdict. A and B..F score very differently.
  earnings_quality      TEXT CHECK (earnings_quality IN
                          ('OPERATING', 'ONE_OFF', 'EXCEPTIONAL_INCOME',
                           'TAX_BENEFIT', 'ASSET_SALE', 'ACCOUNTING', 'UNKNOWN')),
  quality_confidence    REAL,
  quality_evidence_json TEXT,
  source_id             TEXT,
  raw_xbrl_path         TEXT,
  PRIMARY KEY (symbol, period_end)
);

-- ════════════════════ PRICE REACTION ════════════════════

CREATE TABLE price_reactions (
  event_id                    INTEGER NOT NULL REFERENCES events(id),
  horizon                     TEXT    NOT NULL,  -- t0,1m,3m,5m,10m,15m,30m,60m
  ts                          TEXT,
  price                       REAL,
  volume                      INTEGER,
  cum_volume                  INTEGER,
  change_pct                  REAL,
  change_from_prev_close_pct  REAL,
  vwap                        REAL,
  vwap_dist_pct               REAL,
  vwap_position               TEXT CHECK (vwap_position IN ('ABOVE','BELOW','AT')),
  volume_ratio                REAL,
  nifty_change_pct            REAL,
  relative_to_nifty           REAL,
  sector_index                TEXT,
  sector_change_pct           REAL,
  relative_to_sector          REAL,
  is_idiosyncratic            INTEGER,
  source_id                   TEXT NOT NULL,
  latency_class               TEXT NOT NULL,
  fidelity                    TEXT NOT NULL,
  PRIMARY KEY (event_id, horizon)
) WITHOUT ROWID;

CREATE TABLE reaction_profiles (
  event_id                  INTEGER PRIMARY KEY REFERENCES events(id),
  shape                     TEXT CHECK (shape IN
                              ('IMPULSE_HOLD', 'IMPULSE_FADE', 'GRIND_UP',
                               'DELAYED', 'NO_REACTION', 'NEGATIVE')),
  peak_change_pct           REAL,
  peak_horizon              TEXT,
  retracement_from_peak_pct REAL,
  vwap_hold_rate            REAL,
  volume_decay_rate         REAL,
  idiosyncratic_share       REAL,
  completeness              REAL,
  degraded                  INTEGER NOT NULL DEFAULT 0,
  degraded_reason           TEXT
);

-- ════════════════════ PRICED-IN ════════════════════

CREATE TABLE priced_in_assessments (
  candidate_id                  INTEGER PRIMARY KEY,
  pre_event_drift_5d_pct        REAL,
  pre_event_drift_vs_sector_pct REAL,
  pre_event_volume_anomaly      REAL,
  leakage_suspected             INTEGER,
  gap_pct                       REAL,
  gap_filled_pct                REAL,
  move_since_event_pct          REAL,
  expected_move_pct             REAL,
  priced_in_ratio               REAL,
  expected_move_confidence      REAL,
  atr_burn_ratio                REAL,
  pct_from_20ema                REAL,
  distance_to_resistance_pct    REAL,
  pct_of_52w_range              REAL,
  verdict                       TEXT CHECK (verdict IN
                                  ('EARLY', 'DEVELOPING', 'MATURE',
                                   'PRICED_IN', 'OVEREXTENDED')),
  penalty_points                REAL,
  gate_triggered                INTEGER NOT NULL DEFAULT 0
);

-- ════════════════════ CANDIDATES (every evaluation, incl. rejects) ═════════

CREATE TABLE candidates (
  id                      INTEGER PRIMARY KEY,
  ts                      TEXT NOT NULL,
  symbol                  TEXT NOT NULL,
  event_id                INTEGER REFERENCES events(id),
  action                  TEXT NOT NULL CHECK (action IN
                            ('PAPER_BUY', 'WATCH', 'IGNORE', 'NO_TRADE')),
  event_quality           REAL,
  trade_quality           REAL,
  priced_in_penalty       REAL,
  event_buckets_json      TEXT,
  trade_buckets_json      TEXT,
  event_confidence        REAL,
  trade_confidence        REAL,
  gates_passed            INTEGER,
  gate_results_json       TEXT,
  veto_gate               TEXT,
  entry_gate_passed       INTEGER,
  entry_setup_type        TEXT,
  reaction_shape          TEXT,
  priced_in_verdict       TEXT,
  regime_label            TEXT,
  tier                    INTEGER,   -- which data tier produced this
  weights_version         TEXT,
  feature_schema_version  INTEGER,
  data_quality_flags_json TEXT
);
CREATE INDEX idx_candidates_action_ts ON candidates(action, ts);
CREATE INDEX idx_candidates_symbol_ts ON candidates(symbol, ts);

-- Raw feature values, verbatim. This table is what makes offline weight
-- re-optimisation possible. Never store only derived scores here.
CREATE TABLE candidate_features (
  candidate_id     INTEGER PRIMARY KEY REFERENCES candidates(id),
  features_json    TEXT NOT NULL,
  missing_json     TEXT,
  provenance_json  TEXT,
  schema_version   INTEGER NOT NULL
);

-- Explainability as rows: every point added or deducted, with the raw value
-- and threshold that produced it.
CREATE TABLE score_contributions (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id),
  dimension     TEXT NOT NULL CHECK (dimension IN
                  ('EVENT', 'TRADE', 'GATE', 'PRICED_IN')),
  bucket        TEXT,
  feature       TEXT NOT NULL,
  raw_value     TEXT,
  comparator    TEXT,
  threshold     TEXT,
  points        REAL,
  points_max    REAL,
  direction     TEXT CHECK (direction IN ('ADD', 'DEDUCT', 'NEUTRAL', 'VETO')),
  rationale     TEXT,
  source_ref    TEXT,
  confidence    REAL
);
CREATE INDEX idx_contrib_candidate ON score_contributions(candidate_id);
CREATE INDEX idx_contrib_feature ON score_contributions(feature, direction);

-- ════════════════════ TRADE PLAN + OUTCOME ════════════════════

CREATE TABLE trade_plans (
  candidate_id         INTEGER PRIMARY KEY REFERENCES candidates(id),
  entry_price          REAL,
  quantity             INTEGER,
  capital_used         REAL,
  stop_loss            REAL,
  target               REAL,
  risk_per_share       REAL,
  max_loss             REAL,
  expected_profit      REAL,
  risk_reward          REAL,
  est_costs            REAL,
  expected_profit_net  REAL,
  stop_basis           TEXT,   -- ATR | SWING_LOW | SUPPORT
  target_basis         TEXT    -- ATR | RESISTANCE | MEASURED_MOVE
);

CREATE TABLE paper_trades (
  id                  INTEGER PRIMARY KEY,
  candidate_id        INTEGER NOT NULL REFERENCES candidates(id),
  entry_ts            TEXT,
  entry_price         REAL,
  quantity            INTEGER,
  exit_ts             TEXT,
  exit_price          REAL,
  exit_reason         TEXT CHECK (exit_reason IN
                        ('TARGET', 'STOP', 'TIME', 'INVALIDATION', 'REGIME')),
  mfe_pct             REAL,
  mae_pct             REAL,
  time_to_target_min  INTEGER,
  time_to_stop_min    INTEGER,
  gross_pnl           REAL,
  costs               REAL,
  net_pnl             REAL,
  return_pct          REAL,
  result              TEXT CHECK (result IN ('WIN','LOSS','BREAKEVEN','OPEN'))
);

-- Forward returns for ALL candidates, including rejected ones. Without this,
-- "were the things I skipped actually bad?" is unanswerable.
CREATE TABLE outcome_labels (
  candidate_id        INTEGER NOT NULL REFERENCES candidates(id),
  horizon             TEXT    NOT NULL,   -- '1d','3d','5d','10d'
  price               REAL,
  return_pct          REAL,
  return_vs_nifty_pct REAL,
  mfe_pct             REAL,
  mae_pct             REAL,
  fidelity            TEXT NOT NULL,
  PRIMARY KEY (candidate_id, horizon)
) WITHOUT ROWID;
