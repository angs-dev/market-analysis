# SWING-10 — Architecture

Companion document: [`DATA-SOURCE-COMPLIANCE.md`](DATA-SOURCE-COMPLIANCE.md).

---

## 0. Known tensions in the specification

Recorded deliberately, so they are decided rather than discovered after 100
paper trades.

**0.1 A 1% target and a 1.5 risk/reward floor are close to incompatible.**
If target = +1% and R/R ≥ 1.5, then stop ≤ 0.67%. Typical Nifty 500 daily ATR is
1.5–3%. A 0.67% stop sits *inside* normal intraday noise — exits would be driven
by randomness, not by being wrong. **Resolution:** target and stop are both
ATR/structure-derived; the R/R gate does the filtering. Expect realised targets
around 2–4%, not 1%.

**0.2 "Swing" and a 1% target describe different strategies.** Swing implies
2–10 day holds; 1% is an intraday scalp. **Resolution:** outcomes are recorded at
*multiple* horizons (1m…60m, 1d, 3d, 5d, 10d) so the holding period where an
edge actually exists is determined empirically, not assumed.

**0.3 Cost drag on ₹10,000 is severe.** A round trip runs roughly ₹25–60 all-in
(brokerage, STT, exchange txn, SEBI, stamp, GST). Against a ₹100 gross target
that is 25–60% of gross edge. **Resolution:** ₹10,000 is a unit of account only;
the strategy is evaluated on **percentage returns net of a modelled cost**, never
on rupee P&L.

**0.4 Sample size.** 50–100 signals gives directional evidence, not confidence —
at a 50% win rate the 95% CI on 60 trades is roughly ±13 points. Expect to need
200–300+ across at least one regime change. Every tuned weight adds an
overfitting degree of freedom, which is why walk-forward validation is a
milestone rather than an afterthought.

---

## 1. Design commitments

1. **Never force a trade.** `NO_TRADE` is a first-class outcome.
2. **Twin scores, independent floors.** Event Quality and Trade Quality are
   scored separately and never averaged into one number for decisioning.
3. **Already-priced-in is a rejection.** Strong news plus an excessive move that
   already happened is `WATCH` or `IGNORE`, never `PAPER_BUY`.
4. **Store everything, including rejects,** with raw features and per-point
   explanations.
5. **Raw features are persisted separately from scores.** Storing
   `volume_ratio: 4.2` allows re-scoring all history under new weights offline.
   Storing only `volume_score: 8` makes weight optimisation impossible. This is
   the single most important schema decision in the project.
6. **Scoring is pure.** No I/O, no clock, no network. Fully unit-testable and
   replayable.
7. **Provenance is mandatory.** Every price carries source + latency class.
8. **Broker adapters are data-only by construction** — no order methods exist
   anywhere in the codebase.

---

## 2. Tiered capability model

The engine resolves its capabilities at boot from the source registry and
**degrades loudly**, never silently.

| Tier | Requires | Unlocks |
|---|---|---|
| **0** | Nothing | Full pipeline; reaction engine in `EOD_PROXY` mode (`fidelity: LOW`) |
| **1** | Free-API broker account | Real-time ticks, full 1/3/5/10/15/30/60m reaction capture, live scanning |
| **2** | Yahoo (opt-in) | Delayed 1m backfill — **research replay only** |

```typescript
export interface Capabilities {
  tier: 0 | 1 | 2;
  intradayReaction: Fidelity;      // HIGH with broker, LOW in Tier 0
  liveScanning: boolean;
  availableHorizons: Horizon[];    // Tier 0 → ['t0'] only
  degradations: string[];          // surfaced in every alert, stored per row
}
export function resolveCapabilities(reg: SourceRegistry): Capabilities;
```

---

## 3. Source policy layer

No polling interval is hard-coded.

```typescript
export interface SourcePolicy {
  id: string;
  latencyClass: 'REALTIME' | 'DELAYED' | 'PERIODIC' | 'UNKNOWN';
  legalBasis: 'PUBLISHED_FILE' | 'BROKER_LICENSED' | 'RSS_SYNDICATION'
            | 'MANUAL_HUMAN' | 'TOS_GREY';
  enabledByDefault: boolean;
  requiresExplicitOptIn: boolean;        // true for anything TOS_GREY

  poll: {
    intervalMs: number;                  // configuration, not code
    jitterPct: number;                   // avoid lockstep request patterns
    marketHoursOnly: boolean;
    tradingDaysOnly: boolean;
    minIntervalMsFloor: number;          // config cannot go below this
  };
  rateLimit: {
    maxPerMinute: number; maxPerHour: number;
    maxConcurrent: number; minGapMs: number;
  };
  backoff: {
    strategy: 'EXPONENTIAL_JITTER';
    baseMs: number; maxMs: number; maxRetries: number;
    respectRetryAfter: boolean;
    on: number[];                        // [429, 503]
  };
  circuitBreaker: {
    failureThreshold: number; cooldownMs: number;
    hardStopOn: number[];                // [403] — being blocked is a STOP
  };
  cache: { ttlMs: number; persistRaw: boolean };
  attribution?: string;                  // BSE requires source acknowledgement
}
```

**A 403 is treated as "you are being told to stop", not as a retryable error.**
It circuit-breaks the source and alerts. This is the most important rule in the
policy layer.

---

## 4. System diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  SOURCE REGISTRY  — capability + legal basis + policy, per source  │
│  Tier0: bse_ann · bse_xbrl · nse_archive · rss   (always available)│
│  Tier1: broker_ws · broker_rest      (opt-in)                      │
│  Tier2: yahoo_intraday               (opt-in, research replay only)│
└──────────────────────────────┬─────────────────────────────────────┘
                               │  capabilities resolved at boot
┌──────────────────────────────▼─────────────────────────────────────┐
│  RATE-LIMIT GOVERNOR  (token bucket · jitter · backoff · breaker)  │
└──────────────────────────────┬─────────────────────────────────────┘
                    ┌──────────▼──────────┐
                    │   INGEST ADAPTERS   │  raw → cached → normalised
                    └──────────┬──────────┘
        ┌──────────────────────┼──────────────────────┐
┌───────▼────────┐   ┌─────────▼─────────┐  ┌─────────▼──────────┐
│ EVENT PIPELINE │   │  MARKET CONTEXT   │  │  FUNDAMENTALS      │
│ detect·dedupe  │   │  Nifty·VIX·breadth│  │  XBRL parse        │
│ classify       │   │  sector strength  │  │  earnings quality  │
│ materiality    │   │  regime label     │  │  A=operating       │
└───────┬────────┘   └─────────┬─────────┘  │  B..F=one-off      │
        │  event detected, t0  │            └─────────┬──────────┘
┌───────▼──────────────────────▼──────────────────────▼────────────┐
│ PRICE-REACTION ENGINE                                            │
│   t0 → 1m → 3m → 5m → 10m → 15m → 30m → 60m                      │
│   per horizon: price · Δ% · VWAP pos · vol ratio                 │
│              · Nifty Δ% · sector Δ% · rel-to-Nifty · rel-to-sector│
│   emits: reaction shape · fade/hold · idiosyncratic share         │
└──────────────────────────────┬───────────────────────────────────┘
┌──────────────────────────────▼───────────────────────────────────┐
│ PRICED-IN ENGINE                                                 │
│   pre-event drift (leak) · gap · move-vs-expected · ATR burn     │
│   → priced_in_ratio → penalty curve → hard gate at extreme       │
└──────────────────────────────┬───────────────────────────────────┘
                    ┌──────────▼──────────┐
                    │  FEATURE BUILDER    │  raw values, provenance stamped
                    └──────────┬──────────┘
        ┌──────────────────────┴──────────────────────┐
┌───────▼─────────────────┐        ┌──────────────────▼────────────┐
│ EVENT QUALITY  (0-100)  │        │ TRADE QUALITY  (0-100)        │
│ "is the news real,      │        │ "is this a good trade NOW?"   │
│  material, durable?"    │        │  regime·trend·momentum·candle │
│ type·magnitude·quality  │        │  ·volume·entry·PRICED-IN·R:R  │
│ ·source·surprise·confirm│        │                               │
└───────┬─────────────────┘        └──────────────────┬────────────┘
        └──────────────┬─────────────────────────────┘
          ┌────────────▼─────────────┐
          │ GATES → DECISION ENGINE  │
          │ PAPER_BUY  WATCH         │
          │ IGNORE     NO_TRADE      │
          └────────────┬─────────────┘
     ┌─────────────────┼──────────────────┐
┌────▼──────────┐ ┌────▼──────────┐ ┌─────▼─────────────┐
│ EXPLAINER     │ │ CANDIDATE     │ │ NOTIFIER (opt)    │
│ every ± point │ │ STORE         │ │ no-op by default  │
│ w/ raw value, │ │ ALL candidates│ └───────────────────┘
│ threshold,    │ │ incl. rejected│
│ rationale     │ │ + raw features│
└───────────────┘ └────┬──────────┘
            ┌──────────▼───────────┐
            │ OUTCOME LABELLER +   │
            │ VALIDATION SUITE     │
            └──────────────────────┘
```

---

## 5. Price-Reaction Engine

```typescript
export type Horizon = 't0'|'1m'|'3m'|'5m'|'10m'|'15m'|'30m'|'60m';
export type Fidelity = 'HIGH'|'MEDIUM'|'LOW'|'UNAVAILABLE';

export interface ReactionSample {
  eventId: number; horizon: Horizon; ts: string;
  price: number; volume: number; cumVolume: number;
  changePct: number;                    // vs t0
  changeFromPrevClosePct: number;
  vwap: number; vwapDistPct: number;
  vwapPosition: 'ABOVE'|'BELOW'|'AT';
  volumeRatio: number;                  // vs same-time-of-day 20d average
  niftyChangePct: number;
  relativeToNifty: number;              // stock − nifty
  sectorIndex: string;
  sectorChangePct: number;
  relativeToSector: number;             // stock − sector
  isIdiosyncratic: boolean;             // move is stock-specific, not beta
  source: string; latencyClass: LatencyClass; fidelity: Fidelity;
}

export interface ReactionProfile {
  eventId: number; samples: ReactionSample[];
  shape: 'IMPULSE_HOLD'      // pops and holds → healthiest
       | 'IMPULSE_FADE'      // pops and gives back → distribution
       | 'GRIND_UP'          // steady accumulation → often best
       | 'DELAYED'           // no reaction yet → may still be early
       | 'NO_REACTION'       // market disagrees, or hasn't seen it
       | 'NEGATIVE';         // "good news", price down → red flag
  peakChangePct: number; peakHorizon: Horizon;
  retracementFromPeakPct: number;
  vwapHoldRate: number; volumeDecayRate: number;
  idiosyncraticShare: number;
  completeness: number;                 // 0-1, horizons actually captured
  degraded: boolean; degradedReason?: string;
}
```

Two notes. `DELAYED` is **not** a rejection — a genuine result the market has not
yet reacted to is the most interesting state this system can find. And the
relative-to-Nifty/sector fields exist so a stock up 1.8% on a day Nifty is up
1.6% is correctly identified as *not reacting at all*.

---

## 6. Priced-In Engine

Four independent evidence streams, because "already priced in" has four causes.

```typescript
export interface PricedInAssessment {
  // 1. LEAKAGE — did it run up BEFORE the announcement?
  preEventDrift5dPct: number;
  preEventDriftVsSectorPct: number;
  preEventVolumeAnomaly: number;
  leakageSuspected: boolean;

  // 2. GAP — how much repriced before we could ever act?
  gapPct: number; gapFilledPct: number;

  // 3. MOVE vs EXPECTED — the core ratio
  moveSinceEventPct: number;
  expectedMovePct: number;        // from historical response distribution for
                                  // (eventType, magnitudeBucket, ATR)
  pricedInRatio: number;          // move / expected. >1 = fully priced
  expectedMoveConfidence: number; // LOW until enough history accumulates

  // 4. EXTENSION — how much room is structurally left?
  atrBurnRatio: number;           // today's range / ATR14
  pctFrom20EMA: number;
  distanceToResistancePct: number;
  pctOf52wRange: number;

  verdict: 'EARLY'          // <35% priced  → full points
         | 'DEVELOPING'     // 35–65%       → mild penalty
         | 'MATURE'         // 65–90%       → heavy penalty, WATCH bias
         | 'PRICED_IN'      // 90–120%      → hard gate → WATCH
         | 'OVEREXTENDED';  // >120%        → hard gate → IGNORE
  penaltyPoints: number;          // subtracted from TRADE QUALITY
  gateTriggered: boolean;
  evidence: Explanation[];
}
```

**Worked example.** Q1 print, PAT +48%, stock already +10% when detected:
`pricedInRatio ≈ 1.33` → `OVEREXTENDED` → gate fires → **IGNORE**, reason
*"stock has already moved 10.0% vs 7.5% expected for this event class (ratio
1.33); 92% of ATR consumed."* Event Quality still scores ~88 and is stored, so
the question "did the ones I skipped keep running?" remains answerable.

**Honest caveat.** `expectedMovePct` requires a historical event-response
distribution that does not exist yet. Milestone 1 bootstraps it from a static
ATR-multiple table by event type, flagged `confidence: LOW`. It becomes
empirical after roughly 200 labelled events.

---

## 7. Twin scoring and explainability

```typescript
export interface EventQualityScore {
  total: number;                        // 0-100
  buckets: {
    eventType: number;          // 20  results / order win / buyback weighting
    magnitude: number;          // 25  size of fundamental improvement
    earningsQuality: number;    // 25  A=operating vs B–F=one-off
    sourceReliability: number;  // 15  primary exchange vs secondary news
    surprise: number;           // 10  vs prior trend / expectation
    corroboration: number;      //  5  multi-source confirmation
  };
  confidence: number;                   // reduced by missing inputs
  explanations: Explanation[];
}

export interface TradeQualityScore {
  total: number;                        // 0-100
  buckets: {
    marketRegime: number;       // 15
    trendRS: number;            // 15
    entryQuality: number;       // 25
    reactionQuality: number;    // 15   from ReactionProfile
    volumeAccumulation: number; // 10
    candleStructure: number;    // 10
    riskReward: number;         // 10
  };
  pricedInPenalty: number;              // subtracted, reported separately
  confidence: number;
  explanations: Explanation[];
}

/** The unit of "why". Emitted for every point added or deducted. */
export interface Explanation {
  dimension: 'EVENT'|'TRADE'|'GATE'|'PRICED_IN';
  bucket: string; feature: string;
  rawValue: number|string|boolean;      // the actual observed value
  comparator: '>'|'<'|'>='|'<='|'=='|'in'|'range';
  threshold: number|string;
  pointsAwarded: number;                // may be negative
  pointsMax: number;
  direction: 'ADD'|'DEDUCT'|'NEUTRAL'|'VETO';
  rationale: string;                    // human sentence
  sourceRef: string;                    // which source produced rawValue
  confidence: number;
}
```

Rendered:

```
EVENT QUALITY 88/100
  +22/25  pat_yoy = 48.0%        > 25%        Strong PAT growth
  +21/25  earnings_quality = A   == OPERATING Operating-driven; exceptional
                                              items ₹0, tax rate 25.2% normal
  +15/15  source = BSE_XBRL      in PRIMARY   Primary exchange filing
  +12/20  event_type = RESULTS   in TIER_1    Quarterly results
   +8/10  revenue_yoy = 16.0%    > 12%        Revenue confirms PAT growth
TRADE QUALITY 41/100   (priced-in penalty −28)
  −28     priced_in_ratio = 1.33 > 1.20       Move of 10.0% exceeds 7.5%
                                              expected for this event class
   +4/25  entry: extension = 9.2% > 4%        Entry far from any support
   +3/15  reaction: IMPULSE_FADE              Gave back 40% from peak
  +12/15  regime = RISK_ON                    Nifty above 20EMA, VIX 12.4
DECISION: IGNORE — gate PRICED_IN_EXTREME
```

### Decision rule — both floors, never an average

```
if (regime.unstable || dataStale)                    → NO_TRADE
if (anyHardGateFails)                                → IGNORE    (+reasons)
if (eventQuality >= 70 && tradeQuality >= 75
    && entryGatePassed && rr >= 1.5)                 → PAPER_BUY
if (eventQuality >= 70 && tradeQuality <  75)        → WATCH   good news, bad entry
if (eventQuality <  70 && tradeQuality >= 75)        → WATCH   good chart, weak catalyst
else                                                 → IGNORE
```

A 95 Event Quality can never rescue a 40 Trade Quality. That asymmetry is the
reason for splitting the scores.

---

## 8. Module interfaces

```typescript
export interface DataSource {
  readonly policy: SourcePolicy;
  isAvailable(): Promise<boolean>;
  health(): SourceHealth;
}
export interface IntradaySource extends DataSource {           // Tier 1 / 2
  getCandles(sym: string, tf: Timeframe, from: Date, to: Date): Promise<Candle[]>;
  getQuote?(sym: string): Promise<Quote>;
  subscribe?(syms: string[], cb: (t: Tick) => void): Unsubscribe;
}
export interface EodSource extends DataSource {                // Tier 0
  getDailyBars(date: Date): Promise<Candle[]>;
}
export interface AnnouncementSource extends DataSource {
  fetchSince(since: Date): Promise<RawAnnouncement[]>;
}
export interface FundamentalsSource extends DataSource {
  fetchResults(sym: string, since: Date): Promise<RawFiling[]>;
}

export interface EventPipeline {
  classify(raw: RawAnnouncement): ClassifiedEvent;
  assessMateriality(e: ClassifiedEvent): MaterialityResult;
  dedupe(e: ClassifiedEvent): boolean;
}
export interface ReactionEngine {
  capture(e: Event, h: Horizon, caps: Capabilities): Promise<ReactionSample|null>;
  buildProfile(eventId: number): Promise<ReactionProfile>;
}
export interface PricedInEngine {
  assess(f: FeatureVector, r: ReactionProfile): PricedInAssessment;
}
export interface FeatureBuilder {
  build(ctx: BuildContext): Promise<FeatureVector>;    // stamps provenance
}

// Scoring: PURE. No I/O, no clock, no network.
export function scoreEventQuality(f: FeatureVector, w: Weights): EventQualityScore;
export function scoreTradeQuality(
  f: FeatureVector, r: ReactionProfile, p: PricedInAssessment, w: Weights
): TradeQualityScore;

export interface Gate {
  id: string; severity: 'VETO'|'DOWNGRADE';
  check(ctx: GateContext): GateResult;                 // returns Explanation[]
}
export function decide(input: DecisionInput): Decision;

export interface CandidateStore {
  save(d: Decision, f: FeatureVector, ex: Explanation[]): Promise<number>;
  /** Replay all history under new weights without refetching anything. */
  rescoreAll(w: Weights): Promise<RescoreReport>;
}
export interface Notifier { send(d: Decision): Promise<void>; }
```

`rescoreAll` is the payoff for persisting raw features: weight optimisation
becomes a seconds-long offline operation over stored data.

---

## 9. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript, Node 22 LTS | Strongest existing skill; polyglot MVPs die of friction |
| Database | SQLite (`better-sqlite3`) | Zero-config, single file, synchronous API, fast enough for millions of candles |
| Scheduler | `node-cron`, in-process | No external daemon |
| HTTP | native `fetch` + `p-queue` | No axios |
| Indicators | hand-written, in-repo | TA libraries disagree on RSI/VWAP conventions; an edge you cannot debug is not an edge |
| XBRL | `fast-xml-parser` | Small, fast |
| Tests | `node:test` | Built in |
| Reports | Static HTML | Not a web app — a file |
| Analysis (M6) | Python + pandas, read-only on the same SQLite file | Statistics work is genuinely better in pandas |

**Rejected:** NestJS (DI ceremony for a cron job), Docker, Redis, message
queues, any ORM (raw SQL — the queries here are analytical), any cloud service.

---

## 10. Database schema

See `src/db/schema.sql` once implemented. Table inventory:

**Governance:** `data_sources`, `source_requests`
**Reference/market:** `instruments`, `candles`, `market_context`
**Events/fundamentals:** `events`, `fundamentals_quarterly`
**Reaction:** `price_reactions`, `reaction_profiles`
**Priced-in:** `priced_in_assessments`
**Decisions:** `candidates` (all four states), `candidate_features` (raw,
verbatim), `score_contributions` (explainability as rows, indexed by feature so
you can query which features predict winners)
**Outcome:** `trade_plans`, `paper_trades`, `outcome_labels` (forward returns for
*all* candidates, including rejected ones)

Labelling rejected candidates is what makes the only question that matters
answerable: *were the things I skipped actually bad?*

---

## 11. Milestone 1 — exact scope

**Tier 0 only. No broker. No live scanning.**

| # | Deliverable | Done when |
|---|---|---|
| 1 | Repo scaffold, TS strict, `node:test`, config loading | `npm test` green |
| 2 | SQLite schema + migrations | `npm run db:init` builds every table |
| 3 | Source registry + rate-limit governor + circuit breaker | Unit-tested incl. 403 → hard stop |
| 4 | `ManualCsvSource` + `RssSource` | Ingests to `events` |
| 5 | BSE announcements + XBRL adapter (opt-in, 60s floor, attributed) | Populates `events`, `fundamentals_quarterly` |
| 6 | Universe loader + liquidity filter | `instruments` populated, Nifty 500 |
| 7 | Daily candles from published archive / manual CSV | 2–3y daily OHLCV |
| 8 | Indicator library + tests | Verified against known fixtures |
| 9 | XBRL parser + earnings-quality classifier v1 | Each result → A–F with evidence |
| 10 | Feature builder with provenance stamping | `(symbol, ts)` → `FeatureVector` |
| 11 | Reaction engine, `EOD_PROXY` mode | `t0` + daily proxy, `fidelity: LOW` |
| 12 | Priced-in engine (static expected-move table) | Verdict + penalty + evidence |
| 13 | Twin scorers + gates + decision engine | Four states, both floors enforced |
| 14 | Explainability layer | Every candidate → `score_contributions` rows |
| 15 | Candidate store + raw feature persistence | Rejects stored with reasons |
| 16 | Historical replay CLI | `npm run replay -- --from … --to …` |
| 17 | Outcome labeller (T+1/3/5/10) for **all** candidates | `outcome_labels` populated |
| 18 | Static HTML validation report | Counts by state, win rate, expectancy, PF, max DD, gate hit rates |

**Out of scope for Milestone 1:** broker adapters, WebSocket, live scanning,
Telegram, true intraday reaction capture, Yahoo adapter, ROE/ROCE/FCF/holdings,
weight optimisation, and order placement (permanently out, all milestones).

**Exit criterion.** Across N historical events, does the `PAPER_BUY` bucket show
materially better risk-adjusted forward returns than `WATCH` and `IGNORE`, and
does the priced-in gate reject candidates that genuinely underperform? If not,
the algorithm is fixed before any WebSocket code is written.

**Later milestones.** M2 intraday candles and 5m/15m features · M3 broker
adapter, live scanner, Telegram · M4 extended fundamentals · M5 position monitor
and invalidation · M6 walk-forward weight optimisation (train on the first 60%
of signals, test on a held-out 40%; never optimise and evaluate on the same
data).

---

## 12. Folder structure

```
market-analysis/
├── config/
│   ├── sources.json            # per-source policy, tier, legal basis
│   ├── weights.event.json      # event-quality weights
│   ├── weights.trade.json      # trade-quality weights
│   ├── gates.json  costs.json  universe.json
│   └── expected-moves.json     # priced-in bootstrap table
├── data/{swing10.db, raw/, manual/}
├── docs/{ARCHITECTURE.md, DATA-SOURCE-COMPLIANCE.md}
├── src/
│   ├── sources/                # registry · policy · governor · breaker · capabilities
│   ├── adapters/
│   │   ├── tier0/{bse-announcements,bse-xbrl,archive-eod,rss,manual-csv}.ts
│   │   ├── tier1/{broker-rest,broker-ws}.ts        # M3 — DATA ONLY
│   │   └── tier2/yahoo-intraday.ts                 # M4 — opt-in
│   ├── events/{classifier,materiality,dedupe}.ts
│   ├── fundamentals/{xbrl-parser,metrics,quality}.ts
│   ├── technicals/{candles,indicators/,structure,patterns,relative-strength}.ts
│   ├── regime/{market,calendar}.ts
│   ├── reaction/{engine,profile,horizons}.ts
│   ├── pricedin/{engine,expected-move,leakage}.ts
│   ├── scoring/{features,event-quality,trade-quality,gates,entry,decide}.ts
│   ├── explain/{builder,renderer}.ts
│   ├── paper/{position-sizer,cost-model,monitor}.ts
│   ├── validation/{labeller,metrics,walk-forward}.ts
│   ├── db/{schema.sql,migrations/,queries.ts}
│   ├── jobs/{eod,nightly,replay}.ts
│   └── cli.ts
├── analysis/                   # Python/pandas, read-only (M6)
└── tests/fixtures/             # recorded real responses → deterministic tests
```
