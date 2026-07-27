# GoldPulse

Gold (XAU/USD) news, read for direction. A focused day-trading copilot that:

1. **Daily brief** — a pre-session synthesis of what's driving gold today and the near-term directional bias, aware of the day's *scheduled* economic events.
2. **Real-time monitor** — aggregates free gold-relevant news feeds and uses AI to tag every headline **Bullish / Bearish / Neutral for the gold price**, with an impact score and a one-line "why".
3. **Economic calendar** — the week's high-impact + USD events (CPI, FOMC, NFP, Fed speakers) with forecast/previous/actual, so you see catalysts *before* they hit.
4. **Desktop alerts** — opt-in browser notifications fire the moment a high-impact bullish/bearish headline lands, so you don't have to watch the screen.
5. **Live price strip** — spot-ish gold (GC=F) and the dollar index (DXY), so classifications sit next to what price actually did.

This is **decision support, not financial advice** — it makes you faster at reading the tape; you still make the call. Everything above runs on **free, no-key data sources** — only the AI classification + brief need your Anthropic key.

## How it works

```
RSS sources ──▶ /api/feed ──▶ de-dupe ──▶ Claude (Haiku) classifies new headlines ──▶ dashboard
(Fed, Investing,                                     │ cached by headline id
 Yahoo Gold, DJ,                                     ▼
 MarketWatch, Mining)                        Claude (Sonnet) writes the daily brief ──▶ /api/brief
```

- **News sources** (`src/lib/sources.ts`) — free RSS only, no paid licence. The Federal Reserve feed is the single most valuable source for gold. Add or remove feeds in one place; the fetcher is resilient to any individual feed failing.
- **Classification** (`src/lib/claude.ts`) — batches headlines to a fast model (`claude-haiku-4-5`) and reasons through the standard transmission channels (USD, real yields, Fed path, risk sentiment, physical flows).
- **Daily brief** — a stronger model (`claude-sonnet-5`) synthesises the last ~35 headlines **plus the week's scheduled events** into a headline verdict, key drivers, and a "watch today" list. Cached for 30 minutes.
- **Economic calendar** (`src/lib/calendar.ts`) — ForexFactory data via FairEconomy's free JSON, filtered to High-impact + USD-Medium events, bucketed into released / still-to-come-today / rest-of-week.
- **Prices** (`src/lib/price.ts`) — Yahoo Finance quotes for GC=F and DX-Y.NYB, no key.
- **Alerts** — client-side `Notification` API; first load seeds the "seen" set so you're never spammed with the backlog, then only new headlines with impact ≥ 3 and a directional stance fire a notification.
- **Caching** (`src/lib/cache.ts`) — headlines are classified once and reused, so polling every 60s doesn't re-bill tokens.

## Setup

```bash
cd goldpulse
npm install
cp .env.example .env.local      # then paste your Anthropic API key
npm run dev                     # http://localhost:3000
```

`.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
# optional overrides:
# CLASSIFY_MODEL=claude-haiku-4-5-20251001
# BRIEF_MODEL=claude-sonnet-5
```

Without a key the live news feed still loads — only the AI classification and brief need it.

## Roadmap / next steps

- **Economic calendar** — plug a free calendar API (Finnhub / FMP) so the brief knows the day's scheduled CPI / FOMC / NFP prints in advance, not just what's already hit the wire.
- **Push alerts** — Telegram or web-push when a high-impact headline crosses a stance threshold, so you don't have to watch the screen.
- **Live price context** — overlay XAU/USD and DXY so classifications sit next to what price actually did.
- **Lower latency** — swap/augment RSS with a paid low-latency feed (Benzinga etc.) if you're trading the actual headline print.
- **Persistence** — move the in-memory cache to a small DB so history survives restarts and you can review hit-rate.
