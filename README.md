# SWING-10 — Event-Driven Indian Equity Swing Scanner

An event-driven scanner for NSE-listed equities that detects material corporate
news, measures the price reaction to it, and scores whether that reaction
represents a tradeable repricing opportunity — or one that has already happened.

**PAPER TRADING ONLY.** This repository contains no order-placement code, and
never will. Broker adapters are data-only by construction.

## Status

| Stage | State |
|---|---|
| Architecture | Approved (see `docs/ARCHITECTURE.md`) |
| Data-source compliance review | Complete (see `docs/DATA-SOURCE-COMPLIANCE.md`) |
| Data-source decision | **Open** — see "Open Decisions" below |
| Milestone 1 implementation | Not started |

## What this is not

- Not a "top gainers" screen.
- Not a claim of edge. The strategy is unvalidated. No profitability is
  promised or implied.
- Not investment advice, and not to be distributed to others — doing so would
  place it in investment-advisory territory under SEBI rules.

## Core design commitments

1. **Never force a trade.** `NO_TRADE` is a first-class outcome.
2. **Two independent scores.** Event Quality (is the news real and material?)
   and Trade Quality (is this a good trade right now?). Both must clear their
   own floor. A great event can never rescue a bad entry.
3. **Already-priced-in is a rejection, not a bonus.** A strong result that has
   already produced an excessive move is `WATCH` or `IGNORE`, never `PAPER_BUY`.
4. **Every candidate is stored, including rejects**, with raw features and a
   per-point explanation of why it scored what it scored.
5. **Provenance is mandatory.** Every price carries its source and a latency
   class of `REALTIME` / `DELAYED` / `PERIODIC` / `UNKNOWN`. The system never
   claims data is real-time unless the source is verified as such.
6. **Zero cost, local only.** SQLite, Node, your laptop. No cloud, no paid feeds.

## Open decisions

See `docs/DATA-SOURCE-COMPLIANCE.md` §5. In short: both Zerodha and Groww
charge ~₹500/month for API market data, which conflicts with the zero-budget
constraint. The zero-cost paths are a free-API broker account used purely as a
data source, or Tier 0 (no broker, end-of-day only).

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design, engines, schema, module interfaces
- [`docs/DATA-SOURCE-COMPLIANCE.md`](docs/DATA-SOURCE-COMPLIANCE.md) — every data source, its legal basis, its verified limits
