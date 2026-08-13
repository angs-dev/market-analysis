# Data-Source Compliance & Capability Register

Every data source used by this project is registered here with its **legal
basis**, **verified limits**, and **latency class**. This document is the
authority; `config/sources.json` must mirror it.

**Verification status legend**

- ✅ **VERIFIED** — confirmed against the source's own published policy/docs.
- ⚠️ **UNVERIFIED** — could not be confirmed; must be checked locally before use.
- ❌ **PROHIBITED** — the source's own terms forbid our intended use.

---

## 1. The finding that shapes this project

**NSE's Terms of Use contain two clauses that both apply to this system.**

1. ✅ **Automated collection is prohibited.** NSE prohibits "any systematic or
   automated data collection activities (including scraping, data mining, data
   extraction and data harvesting)" on its website/app without express written
   consent. BSE's website policy carries near-identical language.

2. ✅ **NSE data may not be used for simulation.** NSE's Terms of Use state that
   users must not use data or content from the site "for any gaming, virtual
   trading or simulation activities." NSE's Data Usage and Data Sharing Policy
   reinforces this, and NSE issued a circular to members on the point.

**Read plainly: scraping NSE's website to drive a paper-trading simulator is
inside what NSE's terms forbid, on both counts simultaneously.**

### Proportionate reading

- The gaming/virtual-trading clause is aimed at **commercial platforms** —
  fantasy-trading apps, paper-trading products, gaming operators monetising
  exchange data. NSE's data policy frames it in terms of *entities and
  platforms*. A single person doing private research is not the target, and
  private backtesting is near-universal practice.
- But the wording is broad, it is NSE's own published term, and "this is
  private" is a mitigation of risk rather than a compliance argument.
- The **scraping** clause is the more concretely enforceable one. NSE fronts its
  site with Akamai and actively blocks automated clients. The realistic failure
  mode is not litigation — it is an IP block that kills the project mid-build.

### Consequence for the design

A broker API is **not the expensive option — it is the legally clean one**,
because the broker holds a licensed data agreement with the exchange and their
terms of service govern our use. This is why the architecture is tiered rather
than scraper-first.

---

## 2. Source register

### Tier 0 — no account required (always available)

| Source | Provides | Latency | Legal basis | Status |
|---|---|---|---|---|
| Manual CSV drop (`data/manual/`) | Anything downloaded by hand | PERIODIC | A human downloading a published file. Unambiguous. | ✅ Clean |
| RSS feeds (Moneycontrol, ET, Mint, Business Standard) | Corroborating news only — never a primary trigger | PERIODIC | RSS is published *for* syndication | ✅ Clean |
| BSE announcements + XBRL results | Events, quarterly financials | PERIODIC | BSE permits viewing/downloading for **personal, non-commercial or educational** purposes **with attribution**. Automated scraping still requires consent → low-rate, cached, attributed, opt-in | ⚠️ Grey — automated access |
| NSE published archive files (bhavcopy, delivery, corp actions) | Daily OHLCV, delivery %, universe | PERIODIC (EOD) | Files published for download, but NSE ToU restrictions above still apply | ⚠️ Grey — see §1 |

**Tier 0 capability:** full pipeline — universe, events, fundamentals, earnings
quality, daily technicals, scoring, gating, storage, validation.
**Tier 0 cannot do:** true intraday price-reaction capture. The reaction engine
runs in `EOD_PROXY` mode; every row is stamped `fidelity: 'LOW'`.

### Tier 1 — broker account (opt-in)

| Broker | API cost | Market data included? | Historical depth | Status |
|---|---|---|---|---|
| **Zerodha Kite Connect Personal** | **₹0** | ❌ **No** — excludes market data, both real-time and historical | — | ✅ Verified. Account/order access only; **useless as a data source** |
| **Zerodha Kite Connect (paid)** | **₹500/month** per API key | ✅ Live + historical (separate ₹2,000 historical add-on removed 8 Feb 2025) | Up to ~10 years intraday | ✅ Verified — **violates zero-budget constraint** |
| **Groww API** | **₹499 + tax/month** flat | ✅ Market feed, orders, portfolio, historical, margin | **Only ~3 months** of candles | ✅ Verified — violates zero-budget constraint, and shallow history |
| **Upstox** | ₹0 API fee | ✅ | Minute/hour from **Jan 2022**; daily/weekly/monthly from **Jan 2000** | ⚠️ Verify limits locally |
| **Dhan** | ₹0 API fee | ✅ | Verify | ⚠️ Verify limits locally |
| **Angel One SmartAPI** | ₹0 API fee | ✅ REST + WebSocket | Verify | ⚠️ Verify limits locally |
| **ICICI Direct Breeze** | ₹0 to connect | ✅ Streaming OHLC + WebSocket | Verify | ⚠️ Verify limits locally |
| **Fyers** | ₹0 API fee | ✅ | Verify | ⚠️ Verify limits locally |

**Broker data is licensed for personal, non-redistributive use.** A private
paper-trading scanner is within that. Publishing the feed, or operating an
alerting service for others, is not.

### Tier 2 — Yahoo Finance (opt-in, off by default)

| Property | Value | Status |
|---|---|---|
| Intraday depth | 1m ≈ 7 days back; 5m ≈ 60 days; intraday capped at 60 days | ✅ Verified |
| Daily/weekly | Back to listing | ✅ Verified |
| NSE latency | Quotes labelled **DELAYED** | ✅ Verified |
| Terms | Unofficial endpoint, ToS-grey for programmatic use | ⚠️ Grey |

**Permitted use in this project: research replay only.** Never live signals.
Stamped `fidelity: 'MEDIUM'`, `latencyClass: 'DELAYED'`.

---

## 3. Fidelity segregation rule

> **Reaction and outcome data of differing fidelity are never pooled into one
> validation cohort without an explicit flag.**

A win rate computed from delayed Yahoo 1-minute bars is not comparable to one
computed from real-time ticks. `validation/metrics.ts` must refuse to merge
cohorts of differing `fidelity` silently.

---

## 4. Rate-limit and politeness policy

No polling interval is hard-coded. Every source declares a `SourcePolicy`
(see `ARCHITECTURE.md` §3) enforced by a shared governor.

Non-negotiable commitments:

- **Config floors are enforced in code.** A polling interval cannot be set below
  the source's declared floor.
- **HTTP 403 is a hard stop, not a retryable error.** Three consecutive 403s
  circuit-break the source for the session and raise an alert. Being blocked is
  an instruction to stop, and the system treats it as one.
- **429 / `Retry-After` are always respected.**
- Conservative defaults: announcements 60s (floor 30s), everything else slower.
- Market-hours-only and trading-days-only gating for intraday sources.
- Aggressive caching; raw responses persisted so development replays hit disk,
  not the network.
- All requests logged to `source_requests` so our own behaviour is auditable.
- BSE's required source attribution is carried in `SourcePolicy.attribution`.

---

## 5. Open decision — the zero-cost data path

The user holds accounts at **Groww** and **Zerodha**. Both charge for API market
data (₹499 and ₹500/month respectively), which conflicts with the project's
zero-budget constraint. Zerodha's free Personal API explicitly excludes market
data and is therefore not usable as a source.

**Economics note.** Against ₹10,000 of paper capital, ₹500/month is ₹6,000/year
— a 60% annual return required merely to cover the data subscription. Paid data
is not rational at this capital size during validation.

Options:

- **(A) Recommended — open a free-API account (Dhan or Upstox) purely as a data
  source.** Account opening is free; there is no obligation to trade or fund it.
  Investing continues at Groww/Zerodha. Result: ₹0, real-time WebSocket,
  licensed data, deep history (Upstox: minute bars from Jan 2022). Verify any
  AMC before opening.
- **(B) Tier 0 only.** No broker, no account. Conservative, fully functional for
  the end-of-day research loop, but no true intraday reaction capture.
- **(C) Pay ~₹500/month** to Zerodha (better: ~10y intraday history) or Groww
  (only ~3 months). Violates the stated constraint; poor economics at ₹10k.

Milestone 1 is **Tier 0 only** and does not depend on this decision.

---

## 5a. Upstox — Analytics Token and Market Data Feed V3 (Milestone 2 target)

Investigated ahead of Milestone 2. The **Analytics Token** is a materially better
fit for this project than a standard trading token.

| Property | Finding | Status |
|---|---|---|
| Access scope | **Read-only.** Cannot place, modify, or cancel orders — write operations are not available with this token at all | ✅ Verified |
| Validity | Long-lived, **1 year**; no daily OAuth login and no authorization redirect | ✅ Verified |
| Generation | Directly from the Developer Apps page | ✅ Verified |
| Market data APIs | Market Quote, Historical Data, Option Chain, Market Information, Fundamentals, News, IPO and **WebSocket** work **without Static IP** | ✅ Verified |
| Portfolio / Accounts / Funds | Also supported, but **require Static IP**. **This project will not use them** — the provider seam has no place to put them | ✅ Verified |
| Feed | Market Data Feed **V3**; V2 deprecated | ✅ Verified |
| Wire format | **Protobuf** binary, using Upstox's `.proto`; subscription requests must be sent as **binary** frames, not text | ✅ Verified |
| Connection | `wss:`, and the client must follow the redirect to the authorized endpoint after auth | ✅ Verified |
| Subscription limit | Category-dependent; **up to 5,000 instrument keys for `LTPC`** on a single-category subscription. Nifty 500 fits comfortably | ✅ Verified |
| Historical depth | Minute/hour from **Jan 2022**; daily/weekly/monthly from **Jan 2000** | ✅ Verified |
| Cost | Upstox API access is documented as free of subscription fee; **confirm no API subscription charge applies to the Analytics Token before relying on it** | ⚠️ Verify |

**Why this token and not a trading token:** it removes order placement as a
*capability*, not merely as a coding convention. Combined with the
`MarketDataProvider` seam — which exposes no order, position, or funds method,
asserted by test — there are then two independent barriers between this system
and a live order.

### Design implication found: the 403 rule needs a per-source exception

The governor treats HTTP 403 as a stop instruction that hard-stops a source for
the session. That is correct for a public endpoint refusing automated access.
It is **wrong for an authenticated broker API**, where 403 (and 401) normally
mean *the token expired*, not *go away* — and Upstox's community forum shows
403s arising from WebSocket authorization handling specifically.

Because policy is per-source, this needs no change to the governor. The broker
source will be configured with:

- `circuitBreaker.hardStopOn: []` — a broker 403 must not hard-stop the session
- 401/403 handled by the adapter as a re-authentication trigger, with a bounded
  number of refresh attempts before the circuit opens normally

The Tier 0 public sources keep `hardStopOn: [403]` unchanged. Milestone 2 must
add a test asserting both behaviours, so the two never get conflated.

---

## 6. Local verification checklist

The development sandbox blocks `nseindia.com`, `zerodha.com`, `upstox.com`,
`dhanhq.co` and Yahoo's API at the network egress proxy, so live endpoint
behaviour, `robots.txt` contents and rate limits **could not be verified there**.
Run this locally and record the results before writing any ingester:

```bash
# 1. What do they actually disallow?
curl -s https://www.nseindia.com/robots.txt
curl -s https://www.bseindia.com/robots.txt

# 2. Do endpoints respond to a plain client? (single request, no loop)
curl -sS -o /dev/null -w "NSE  %{http_code}\n" https://www.nseindia.com/
curl -sS -o /dev/null -w "YHOO %{http_code}\n" \
  "https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=1m&range=1d"

# 3. Read in full before building against them:
#    https://www.nseindia.com/static/nse-terms-of-use
#    https://www.bseindia.com/static/about/website_policy.html
```

---

## 7. Sources

- NSE Terms of Use — <https://www.nseindia.com/static/nse-terms-of-use>
- NSE Data Sharing & Usage Policy — <https://www.nseindia.com/static/market-data/nse-data-policy>
- BSE Website Policy — <https://www.bseindia.com/static/about/website_policy.html>
- BSE XBRL — <https://www.bseindia.com/corporates/xbrldetails>
- Kite Connect Personal APIs — <https://zerodha.com/z-connect/updates/free-personal-apis-from-kite-connect>
- Kite Connect pricing — <https://zerodha.com/products/api/>
- Groww Trade API docs — <https://groww.in/trade-api/docs>
- Upstox historical candle API — <https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/>
