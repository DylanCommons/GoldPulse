"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Brief,
  CalendarEvent,
  Classification,
  ClassifiedItem,
  EventImpact,
  GoldLevels,
  LevelTimeframe,
  NewsItem,
  PriceLevel,
  Quote,
  SetupType,
  Stance,
  Trade,
  TradeIdea,
  Trend,
} from "@/lib/types";

const POLL_MS = 60_000;
const CALENDAR_POLL_MS = 5 * 60_000;
// Fire a desktop alert only for genuinely market-moving, directional headlines.
const ALERT_IMPACT = 3;
// Price-approach alerts: flag when price comes within NEAR of a level, and only
// re-arm that level once price has backed off beyond CLEAR (hysteresis).
const NEAR_PCT = 0.001; // 0.1%
const CLEAR_PCT = 0.002; // 0.2%
// Classify unseen headlines in small parallel batches so the UI colourises fast.
const CLASSIFY_CHUNK = 20;
const CLASS_CACHE_KEY = "gp_class_v1";
const BRIEF_CACHE_KEY = "gp_brief_v1";
const BRIEF_TTL_MS = 30 * 60_000;

type ClassMap = Record<string, Classification>;

// Classifications are cached in the browser so a headline is only ever sent to
// the model once — polls re-classify nothing already seen. This also sidesteps
// serverless statelessness: the cache lives with the user, not the function.
function readClassCache(): ClassMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(CLASS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeClassCache(map: ClassMap) {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(map);
    const capped = entries.length > 800 ? entries.slice(entries.length - 800) : entries;
    localStorage.setItem(CLASS_CACHE_KEY, JSON.stringify(Object.fromEntries(capped)));
  } catch {
    /* storage full/unavailable — non-fatal */
  }
}

function readBriefCache(): { brief: Brief; at: number } | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(BRIEF_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

function writeBriefCache(brief: Brief) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BRIEF_CACHE_KEY, JSON.stringify({ brief, at: Date.now() }));
  } catch {
    /* non-fatal */
  }
}

const TRADES_KEY = "gp_trades_v1";

function readTrades(): Trade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    return raw ? (JSON.parse(raw) as Trade[]) : [];
  } catch {
    return [];
  }
}

function writeTrades(trades: Trade[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TRADES_KEY, JSON.stringify(trades.slice(-200)));
  } catch {
    /* non-fatal */
  }
}

const SETUP_LABEL: Record<SetupType, string> = {
  "trend-retest": "Trend retest",
  "trend-breakout": "Trend breakout",
  "range-fade": "Range fade",
};

type Filter = "all" | "bullish" | "bearish" | "high-impact";

// Reusable card surface — white, hairline border, whisper of a shadow.
const CARD =
  "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]";
const EYEBROW =
  "text-[11px] font-semibold uppercase tracking-wider text-stone-400";

const STANCE_UI: Record<
  Stance,
  { label: string; dot: string; text: string; pill: string; accent: string }
> = {
  bullish: {
    label: "Bullish",
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    pill: "border-emerald-200 bg-emerald-50",
    accent: "border-l-emerald-400",
  },
  bearish: {
    label: "Bearish",
    dot: "bg-rose-500",
    text: "text-rose-700",
    pill: "border-rose-200 bg-rose-50",
    accent: "border-l-rose-400",
  },
  neutral: {
    label: "Neutral",
    dot: "bg-stone-300",
    text: "text-stone-500",
    pill: "border-stone-200 bg-stone-50",
    accent: "border-l-stone-200",
  },
};

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StanceBadge({ stance }: { stance: Stance }) {
  const ui = STANCE_UI[stance];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${ui.pill} ${ui.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
      {ui.label}
    </span>
  );
}

function ImpactMeter({ impact }: { impact: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`Impact ${impact}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={`h-3 w-1 rounded-full ${n <= impact ? "bg-amber-400" : "bg-stone-200"}`}
        />
      ))}
    </span>
  );
}

function BriefCard({ brief }: { brief: Brief }) {
  return (
    <section className={`${CARD} p-6`}>
      <div className="flex items-center justify-between gap-3">
        <span className={EYEBROW}>Daily Brief</span>
        <StanceBadge stance={brief.bias} />
      </div>
      <h2 className="mt-2.5 text-xl font-semibold leading-snug text-stone-900">
        {brief.headline}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-stone-600">
        {brief.summary
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
      </div>

      {brief.drivers.length > 0 && (
        <div className="mt-5 border-t border-stone-100 pt-4">
          <h3 className={EYEBROW}>Key drivers</h3>
          <ul className="mt-2.5 space-y-2.5">
            {brief.drivers.map((d, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                <span
                  className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${STANCE_UI[d.stance].dot}`}
                />
                <span className="text-stone-600">
                  <span className="font-medium text-stone-900">{d.title}.</span> {d.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {brief.watchlist.length > 0 && (
        <div className="mt-5 border-t border-stone-100 pt-4">
          <h3 className={EYEBROW}>Watch today</h3>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {brief.watchlist.map((w, i) => (
              <li
                key={i}
                className="rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs text-stone-600"
              >
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-5 text-[11px] text-stone-400">
        Generated {timeAgo(brief.generatedAt)} · decision support, not financial advice
      </p>
    </section>
  );
}

function NewsRow({ item }: { item: ClassifiedItem }) {
  const c = item.classification;
  const ui = STANCE_UI[c?.stance ?? "neutral"];
  return (
    <article
      className={`rounded-xl border border-l-[3px] border-stone-200/80 ${ui.accent} bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition hover:shadow-[0_3px_10px_rgba(0,0,0,0.06)]`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="text-[15px] font-medium leading-snug text-stone-900 hover:text-blue-700 hover:underline"
          >
            {item.title}
          </a>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-stone-400">
            <span>{item.source}</span>
            <span>·</span>
            <span>{timeAgo(item.publishedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {c ? (
            <StanceBadge stance={c.stance} />
          ) : (
            <span className="inline-flex h-5 items-center rounded-full border border-stone-200 bg-stone-50 px-2 text-[11px] text-stone-400">
              analyzing…
            </span>
          )}
          {c && c.impact > 0 && <ImpactMeter impact={c.impact} />}
        </div>
      </div>
      {c?.rationale && (
        <p className="mt-2 text-[13px] leading-relaxed text-stone-500">
          {c.rationale}
          {c.confidence != null && (
            <span className="text-stone-400"> · {Math.round(c.confidence * 100)}% conf</span>
          )}
        </p>
      )}
    </article>
  );
}

function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function near(price: number, levelPrice: number): boolean {
  return price > 0 && Math.abs(levelPrice - price) / price <= NEAR_PCT;
}

function LevelRow({ level, current }: { level: PriceLevel; current: number }) {
  const above = level.price > current;
  const pct = current ? ((level.price - current) / current) * 100 : 0;
  const isPivot = level.kind === "pivot";
  const color = isPivot ? "text-stone-400" : above ? "text-rose-600" : "text-emerald-600";
  const dot = isPivot ? "bg-stone-300" : above ? "bg-rose-400" : "bg-emerald-400";
  const isNear = near(current, level.price);
  return (
    <div
      className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
        isNear ? "bg-amber-50/70 ring-1 ring-amber-200" : ""
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="w-12 font-medium text-stone-600">{level.label}</span>
        {isNear && (
          <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            near
          </span>
        )}
      </span>
      <span className="flex items-baseline gap-3">
        <span className="tabular-nums text-stone-800">${fmtPrice(level.price)}</span>
        <span className={`w-16 text-right text-xs tabular-nums ${color}`}>
          {pct >= 0 ? "+" : ""}
          {pct.toFixed(2)}%
        </span>
      </span>
    </div>
  );
}

// Inline SVG sparkline of recent price action with nearby pivot levels overlaid.
function MiniChart({ series, levels, up }: { series: number[]; levels: PriceLevel[]; up: boolean }) {
  if (series.length < 2) return null;
  const W = 600;
  const H = 120;
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const pad = (hi - lo) * 0.12 || 1;
  const min = lo - pad;
  const max = hi + pad;
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / (max - min)) * H;

  const linePts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPath = `M0,${H} L ${linePts} L ${W},${H} Z`;
  const stroke = up ? "#10b981" : "#f43f5e";
  const gid = up ? "gp-up" : "gp-down";

  // Only overlay levels that fall inside the visible price window.
  const shown = levels
    .filter((l) => l.price >= min && l.price <= max)
    .map((l) => ({
      ...l,
      yPct: (y(l.price) / H) * 100,
      color: l.kind === "pivot" ? "#a8a29e" : l.price > series[series.length - 1] ? "#fb7185" : "#34d399",
    }));

  return (
    <div className="relative mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-20 w-full">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {shown.map((l, i) => (
          <line
            key={i}
            x1="0"
            x2={W}
            y1={y(l.price)}
            y2={y(l.price)}
            stroke={l.color}
            strokeWidth="1"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
            opacity="0.6"
          />
        ))}
        <path d={areaPath} fill={`url(#${gid})`} />
        <polyline
          points={linePts}
          fill="none"
          stroke={stroke}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* crisp HTML overlays so labels + dot aren't distorted by the stretch */}
      {shown.map((l, i) => (
        <span
          key={i}
          style={{ top: `${l.yPct}%` }}
          className="pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-white/80 px-1 text-[9px] font-medium tabular-nums text-stone-400"
        >
          {l.label}
        </span>
      ))}
      <span
        style={{ top: `${(y(series[series.length - 1]) / H) * 100}%` }}
        className="pointer-events-none absolute right-0 h-2 w-2 -translate-y-1/2 translate-x-1/2 rounded-full ring-2 ring-white"
        // color set inline to match the line
      >
        <span
          className="block h-full w-full rounded-full"
          style={{ backgroundColor: stroke }}
        />
      </span>
    </div>
  );
}

function LevelsCard({
  data,
  timeframe,
  onTimeframe,
}: {
  data: GoldLevels;
  timeframe: LevelTimeframe;
  onTimeframe: (tf: LevelTimeframe) => void;
}) {
  const up = data.change >= 0;
  const asOf = new Date(data.asOf).toLocaleString("en-GB", {
    month: "short",
    day: "numeric",
    ...(timeframe === "intraday" ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    timeZone: "Europe/Dublin",
  });

  const trendUI: Record<Trend, { label: string; cls: string }> = {
    bullish: { label: "Uptrend", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    bearish: { label: "Downtrend", cls: "border-rose-200 bg-rose-50 text-rose-700" },
    mixed: { label: "Ranging", cls: "border-stone-200 bg-stone-50 text-stone-600" },
  };
  const tr = trendUI[data.trend];

  const rows: Array<{ type: "level"; level: PriceLevel } | { type: "current"; price: number }> = [
    ...data.levels.map((level) => ({ type: "level" as const, level })),
    { type: "current" as const, price: data.price },
  ].sort((a, b) => (b.type === "current" ? b.price : b.level.price) - (a.type === "current" ? a.price : a.level.price));

  return (
    <section className={`${CARD} p-6`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <span className={EYEBROW}>Gold · Live Price</span>
          <div className="mt-1 flex items-baseline gap-2.5">
            <span className="text-3xl font-semibold tracking-tight tabular-nums text-stone-900">
              ${fmtPrice(data.price)}
            </span>
            <span
              className={`text-sm font-medium tabular-nums ${up ? "text-emerald-600" : "text-rose-600"}`}
            >
              {up ? "▲" : "▼"} {up ? "+" : ""}
              {fmtPrice(data.change)} ({Math.abs(data.changePct).toFixed(2)}%)
            </span>
          </div>
        </div>
        <p className="text-xs text-stone-400">
          {data.dayLow != null && data.dayHigh != null && (
            <>Day {fmtPrice(data.dayLow)}–{fmtPrice(data.dayHigh)}</>
          )}
          {data.yearLow != null && data.yearHigh != null && (
            <> · 52w {fmtPrice(data.yearLow)}–{fmtPrice(data.yearHigh)}</>
          )}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium ${tr.cls}`}
          title="Daily 50/200 EMA trend — trade with this"
        >
          Trend: {tr.label}
        </span>
        {data.ema50 != null && (
          <span className="text-stone-400">
            50 EMA <span className="tabular-nums text-stone-600">{fmtPrice(data.ema50)}</span>
          </span>
        )}
        {data.ema200 != null && (
          <span className="text-stone-400">
            200 EMA <span className="tabular-nums text-stone-600">{fmtPrice(data.ema200)}</span>
          </span>
        )}
        {data.atr14 != null && (
          <span className="text-stone-400" title="Daily ATR(14) — stop-sizing reference">
            ATR <span className="tabular-nums text-stone-600">{fmtPrice(data.atr14)}</span>
          </span>
        )}
      </div>

      <MiniChart series={data.series} levels={data.levels} up={up} />

      <div className="mt-4 border-t border-stone-100 pt-3">
        <div className="flex items-center justify-between">
          <span className={EYEBROW}>Key Levels</span>
          <div className="flex items-center gap-1.5">
            <Pill active={timeframe === "daily"} onClick={() => onTimeframe("daily")}>
              Daily
            </Pill>
            <Pill active={timeframe === "intraday"} onClick={() => onTimeframe("intraday")}>
              Intraday
            </Pill>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-stone-400">
          {timeframe === "intraday" ? "hourly pivots" : "daily pivots"} · {asOf}
        </p>
        <div className="mt-2 space-y-0.5">
          {rows.map((r, i) =>
            r.type === "current" ? (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-200"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-amber-700">
                  <span className="text-amber-500">◆</span> Gold now
                </span>
                <span className="text-sm font-semibold tabular-nums text-stone-900">
                  ${fmtPrice(r.price)}
                </span>
              </div>
            ) : (
              <LevelRow key={i} level={r.level} current={data.price} />
            )
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-stone-400">
          <span className="text-rose-600">Resistance / supply</span> above ·{" "}
          <span className="text-emerald-600">support / demand</span> below · floor-trader pivots
          from real price data
        </p>
      </div>
    </section>
  );
}

function PriceStrip({ quotes, updatedAt }: { quotes: Quote[]; updatedAt: string | null }) {
  if (quotes.length === 0) return null;
  return (
    <div className={`${CARD} flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3`}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        {quotes.map((q) => {
          const up = q.change >= 0;
          return (
            <div key={q.symbol} className="flex items-baseline gap-1.5">
              <span className="text-xs text-stone-400">{q.name}</span>
              <span className="text-sm font-semibold tabular-nums text-stone-900">
                {q.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              <span
                className={`text-xs font-medium tabular-nums ${up ? "text-emerald-600" : "text-rose-600"}`}
              >
                {up ? "▲" : "▼"} {Math.abs(q.changePct).toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
      {updatedAt && (
        <span className="flex items-center gap-1.5 text-[11px] text-stone-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Live · {timeAgo(updatedAt)}
        </span>
      )}
    </div>
  );
}

const IMPACT_UI: Record<EventImpact, { dot: string }> = {
  high: { dot: "bg-rose-500" },
  medium: { dot: "bg-amber-400" },
  low: { dot: "bg-stone-300" },
  none: { dot: "bg-stone-200" },
};

function eventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Dublin",
  });
}

function eventDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "Europe/Dublin",
  });
}

function EventRow({ e, showDay }: { e: CalendarEvent; showDay?: boolean }) {
  const ui = IMPACT_UI[e.impact];
  // beat/miss arrow is factual only — direction-for-gold is left to the brief.
  let surprise: "up" | "down" | null = null;
  if (e.actual && e.forecast) {
    const a = parseFloat(e.actual.replace(/[^0-9.-]/g, ""));
    const f = parseFloat(e.forecast.replace(/[^0-9.-]/g, ""));
    if (!Number.isNaN(a) && !Number.isNaN(f) && a !== f) surprise = a > f ? "up" : "down";
  }
  return (
    <div className="flex items-center gap-2.5 py-2 text-[13px]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ui.dot}`} />
      <span className="w-24 shrink-0 tabular-nums text-stone-400">
        {showDay ? `${eventDay(e.date)} ` : ""}
        {eventTime(e.date)} IST
      </span>
      <span className="w-9 shrink-0 font-medium text-stone-400">{e.country}</span>
      <span className="min-w-0 flex-1 truncate text-stone-700">{e.title}</span>
      <span className="shrink-0 tabular-nums">
        {e.actual != null ? (
          <span
            className={
              surprise === "up"
                ? "text-emerald-600"
                : surprise === "down"
                  ? "text-rose-600"
                  : "text-stone-700"
            }
          >
            {e.actual}
            {surprise && (surprise === "up" ? " ↑" : " ↓")}
          </span>
        ) : e.forecast != null ? (
          <span className="text-stone-400">f/c {e.forecast}</span>
        ) : null}
      </span>
    </div>
  );
}

function CalendarPanel({
  released,
  todayUpcoming,
  later,
}: {
  released: CalendarEvent[];
  todayUpcoming: CalendarEvent[];
  later: CalendarEvent[];
}) {
  const [tab, setTab] = useState<"today" | "week">("today");
  const hasToday = todayUpcoming.length > 0 || released.length > 0;
  return (
    <section className={`${CARD} p-6`}>
      <div className="flex items-center justify-between">
        <span className={EYEBROW}>Economic Calendar</span>
        <div className="flex gap-1.5">
          <Pill active={tab === "today"} onClick={() => setTab("today")}>
            Today
          </Pill>
          <Pill active={tab === "week"} onClick={() => setTab("week")}>
            Rest of week
          </Pill>
        </div>
      </div>

      {tab === "today" ? (
        <div className="mt-3 divide-y divide-stone-100">
          {todayUpcoming.length > 0 && (
            <div className="pb-1">
              <p className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-amber-600">
                Still to come
              </p>
              {todayUpcoming.map((e, i) => (
                <EventRow key={`u${i}`} e={e} />
              ))}
            </div>
          )}
          {released.length > 0 && (
            <div className="pt-2">
              <p className="pt-1 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Released
              </p>
              {released.map((e, i) => (
                <EventRow key={`r${i}`} e={e} showDay />
              ))}
            </div>
          )}
          {!hasToday && (
            <p className="py-3 text-sm text-stone-400">No high-impact events left today.</p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          {later.length > 0 ? (
            later.map((e, i) => <EventRow key={`l${i}`} e={e} showDay />)
          ) : (
            <p className="py-3 text-sm text-stone-400">Nothing else scheduled this week.</p>
          )}
        </div>
      )}
      <p className="mt-3 border-t border-stone-100 pt-3 text-[11px] text-stone-400">
        High-impact + USD events · times Irish (IST) · via ForexFactory
      </p>
    </section>
  );
}

function SkeletonRow() {
  return (
    <div className="rounded-xl border border-stone-200/80 bg-white p-4">
      <div className="h-4 w-3/4 animate-pulse rounded bg-stone-100" />
      <div className="mt-2 h-3 w-1/4 animate-pulse rounded bg-stone-100" />
    </div>
  );
}

// ————— Session / timing (Dylan's Irish-time trading windows) —————
function irishParts(ts: number) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString("en-GB", {
    timeZone: "Europe/Dublin",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [h, m] = hm.split(":").map(Number);
  const weekday = d.toLocaleDateString("en-US", { timeZone: "Europe/Dublin", weekday: "short" });
  return { minutes: h * 60 + m, hm, weekday };
}

type SessionState = "prime" | "caution" | "off";

// Windows in IST minutes. Prime: London 09:00–11:00 (540–660) and NY 15:00–16:30
// (900–990). Caution: the 13:30 US data spike, and the NY open (14:30) chop that
// Dylan sits out until ~15:00 before taking a cleaner continuation.
const CAUTIONS: { a: number; b: number; label: string }[] = [
  { a: 805, b: 820, label: "US 13:30 data spike — wait for the dust to settle" },
  { a: 865, b: 900, label: "NY open (14:30) chop — you wait until ~15:00 for a cleaner continuation" },
];

function sessionInfo(minutes: number): { state: SessionState; label: string } {
  for (const c of CAUTIONS) {
    if (minutes >= c.a && minutes < c.b) return { state: "caution", label: c.label };
  }
  if (minutes >= 540 && minutes < 660) return { state: "prime", label: "London session — prime (first trend leg)" };
  if (minutes >= 900 && minutes < 990) return { state: "prime", label: "NY session — prime (post-open, chop cleared)" };
  return { state: "off", label: "Outside your prime windows" };
}

function minsToNextPrime(minutes: number): { mins: number; name: string } {
  if (minutes < 540) return { mins: 540 - minutes, name: "London" };
  if (minutes < 900) return { mins: 900 - minutes, name: "NY overlap" };
  return { mins: 540 + (1440 - minutes), name: "London" };
}

function fmtDur(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function SessionPanel({ now, upcoming }: { now: number; upcoming: CalendarEvent[] }) {
  const { minutes, hm, weekday } = irishParts(now);
  const sess = sessionInfo(minutes);
  const next = minsToNextPrime(minutes);

  const stateUI: Record<SessionState, { dot: string; chip: string }> = {
    prime: { dot: "bg-emerald-500", chip: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    caution: { dot: "bg-amber-500", chip: "border-amber-200 bg-amber-50 text-amber-700" },
    off: { dot: "bg-stone-300", chip: "border-stone-200 bg-stone-50 text-stone-500" },
  };
  const ui = stateUI[sess.state];
  const dayNote = ["Tue", "Wed", "Thu"].includes(weekday)
    ? "prime day"
    : weekday === "Mon"
      ? "slow start"
      : weekday === "Fri"
        ? "thin afternoon"
        : "weekend";

  const highs = upcoming.filter((e) => e.impact === "high");
  const nextHigh = highs[0] ?? null;
  const nextHighMins = nextHigh ? Math.round((Date.parse(nextHigh.date) - now) / 60000) : null;
  const releaseImminent = nextHighMins != null && nextHighMins <= 30 && nextHighMins >= -10;

  return (
    <section className={`${CARD} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-stone-900">{hm}</span>
          <span className="text-xs text-stone-400">
            {weekday} · {dayNote} · Irish time
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${ui.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
            {sess.state === "prime" ? "Prime window" : sess.state === "caution" ? "Caution" : "Off-window"}
          </span>
          {sess.state !== "prime" && (
            <span className="text-xs text-stone-400">{next.name} in {fmtDur(next.mins)}</span>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-stone-500">{sess.label}</p>

      <div className="mt-3 border-t border-stone-100 pt-2.5 text-xs">
        {nextHigh ? (
          <span
            className={`inline-flex items-center gap-1.5 font-medium ${releaseImminent ? "text-rose-700" : "text-amber-700"}`}
          >
            <span>{releaseImminent ? "⛔" : "⚠️"}</span>
            Event day: {nextHigh.country} {nextHigh.title} at {eventTime(nextHigh.date)} IST
            {nextHighMins != null && nextHighMins >= 0 && <span className="text-stone-400"> · in {fmtDur(nextHighMins)}</span>}
            {releaseImminent && <span className="text-rose-600"> — sit out the release</span>}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
            <span>✓</span> Clean day — no high-impact events left. News-check passed.
          </span>
        )}
      </div>
    </section>
  );
}

// ————— Pre-trade discipline checklist (Dylan's hard rules) —————
const CHECKLIST_ITEMS = [
  "With the higher-timeframe trend (D / 4H / 1H bias)",
  "Confirmed ICC continuation — broke last minor HL/LH (not mid-correction)",
  "Reward ≥ 3R with a tight stop just beyond the structure",
  "Stop placed — and I will NOT move it",
  "Target banks into a pre-identified level",
  "Good window (London 09–11 / NY 15–16:30), not chop or a data spike",
  "Planned & carded — not an impulse phone trade",
  "Risk size deliberate — not scaled up on a streak",
];

function irishDateKey(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Europe/Dublin" });
}

function ChecklistCard({ now }: { now: number }) {
  const storageKey = `gp_checklist_${irishDateKey(now)}`;
  const [checks, setChecks] = useState<boolean[]>(() => CHECKLIST_ITEMS.map(() => false));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setChecks(raw ? JSON.parse(raw) : CHECKLIST_ITEMS.map(() => false));
    } catch {
      setChecks(CHECKLIST_ITEMS.map(() => false));
    }
  }, [storageKey]);

  const toggle = (i: number) => {
    setChecks((prev) => {
      const next = prev.map((v, j) => (j === i ? !v : v));
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* non-fatal */
      }
      return next;
    });
  };

  const reset = () => {
    const cleared = CHECKLIST_ITEMS.map(() => false);
    setChecks(cleared);
    try {
      localStorage.setItem(storageKey, JSON.stringify(cleared));
    } catch {
      /* non-fatal */
    }
  };

  const done = checks.filter(Boolean).length;
  const all = done === CHECKLIST_ITEMS.length;

  return (
    <section className={`${CARD} p-5`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <span className={EYEBROW}>Pre-trade checklist</span>
        <span className="flex items-center gap-2">
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              all ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-50 text-stone-500"
            }`}
          >
            {all ? "✓ Cleared to trade" : `${done}/${CHECKLIST_ITEMS.length}`}
          </span>
          <span className="text-stone-400">{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {CHECKLIST_ITEMS.map((item, i) => (
            <button
              key={i}
              onClick={() => toggle(i)}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-stone-50"
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                  checks[i]
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-stone-300 bg-white text-transparent"
                }`}
              >
                ✓
              </span>
              <span className={checks[i] ? "text-stone-400 line-through" : "text-stone-700"}>{item}</span>
            </button>
          ))}
          <div className="flex items-center justify-between pt-1">
            <p className="text-[11px] text-stone-400">Resets daily · &ldquo;If it&rsquo;s not worth logging, it&rsquo;s not worth taking.&rdquo;</p>
            <button onClick={reset} className="text-[11px] text-stone-400 underline hover:text-stone-600">
              reset
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ————— Recommendations (with-trend, level-triggered plans) —————
const DIR_UI: Record<"long" | "short", { label: string; cls: string; arrow: string }> = {
  long: { label: "LONG", cls: "border-emerald-200 bg-emerald-50 text-emerald-700", arrow: "▲" },
  short: { label: "SHORT", cls: "border-rose-200 bg-rose-50 text-rose-700", arrow: "▼" },
};
const CONVICTION_UI: Record<string, string> = {
  high: "text-emerald-600",
  medium: "text-stone-500",
  low: "text-amber-600",
};

function RecommendationsCard({
  ideas,
  trades,
  price,
  onTake,
}: {
  ideas: TradeIdea[];
  trades: Trade[];
  price: number;
  onTake: (idea: TradeIdea) => void;
}) {
  const resolved = trades.filter((t) => t.status === "win" || t.status === "loss");
  const wins = resolved.filter((t) => t.status === "win").length;
  const totalR = resolved.reduce((s, t) => s + (t.resultR ?? 0), 0);
  const winRate = resolved.length ? Math.round((wins / resolved.length) * 100) : null;
  const statForType = (type: SetupType) => {
    const d = resolved.filter((t) => t.setupType === type);
    return { n: d.length, w: d.filter((t) => t.status === "win").length };
  };

  return (
    <section className={`${CARD} p-6`}>
      <div className="flex items-center justify-between">
        <span className={EYEBROW}>Setups</span>
        {winRate != null && (
          <span className="text-[11px] text-stone-400">
            Your record:{" "}
            <span className="font-medium text-stone-600">
              {winRate}% ({wins}/{resolved.length})
            </span>{" "}
            ·{" "}
            <span className={totalR >= 0 ? "text-emerald-600" : "text-rose-600"}>
              {totalR >= 0 ? "+" : ""}
              {totalR.toFixed(1)}R
            </span>
          </span>
        )}
      </div>

      {ideas.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">
          No ICC continuation set up right now — waiting for a correction to complete with the
          trend at ≥3R. Nothing to force.
        </p>
      ) : (
        <div className="mt-3 space-y-2.5">
          {ideas.map((idea) => {
            const dir = DIR_UI[idea.direction];
            const away = price ? ((idea.entry - price) / price) * 100 : 0;
            const st = statForType(idea.setupType);
            const watching = trades.some((t) => t.status === "open" && t.id.startsWith(idea.id));
            const weak = st.n >= 4 && st.w / st.n < 0.4;
            return (
              <div key={idea.id} className="rounded-xl border border-stone-200/80 bg-stone-50/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${dir.cls}`}
                    >
                      {dir.arrow} {dir.label}
                    </span>
                    <span className="text-xs text-stone-400">
                      {SETUP_LABEL[idea.setupType]} ·{" "}
                      <span className={CONVICTION_UI[idea.conviction]}>{idea.conviction} conviction</span>
                    </span>
                  </div>
                  <span className="text-xs font-medium tabular-nums text-stone-500">{idea.rr}R</span>
                </div>

                <p className="mt-2 text-sm text-stone-800">
                  On the {idea.direction === "long" ? "break above" : "break below"}{" "}
                  <span className="font-semibold tabular-nums">${fmtPrice(idea.entry)}</span>{" "}
                  <span className="text-stone-400">({idea.triggerLabel})</span> →{" "}
                  <span className="font-semibold">{idea.direction === "long" ? "long" : "short"}</span>{" "}
                  to <span className="font-semibold tabular-nums">${fmtPrice(idea.target)}</span>{" "}
                  <span className="text-stone-400">({idea.targetLabel})</span>, stop{" "}
                  <span className="tabular-nums">${fmtPrice(idea.stop)}</span>
                </p>
                <p className="mt-1 text-xs text-stone-500">{idea.rationale}</p>

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-stone-400">
                    {Math.abs(away) < 0.01 ? "at level now" : `entry ${away >= 0 ? "+" : ""}${away.toFixed(2)}% away`}
                    {st.n > 0 && (
                      <>
                        {" · "}
                        <span className={weak ? "text-amber-600" : "text-stone-500"}>
                          your {SETUP_LABEL[idea.setupType].toLowerCase()}: {st.w}/{st.n}
                          {weak ? " ⚠" : ""}
                        </span>
                      </>
                    )}
                  </span>
                  {watching ? (
                    <span className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-400">
                      Watching…
                    </span>
                  ) : (
                    <button
                      onClick={() => onTake(idea)}
                      className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-stone-700"
                    >
                      Took trade
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-stone-400">
        ICC continuation setups from 15m swing structure, with the daily trend, ≥3R into prior
        demand/supply. Plans, not signals — you confirm the continuation. Not financial advice.
      </p>
    </section>
  );
}

function TradesCard({
  trades,
  price,
  onResolve,
  onClose,
}: {
  trades: Trade[];
  price: number;
  onResolve: (id: string, result: "win" | "loss") => void;
  onClose: (id: string) => void;
}) {
  const [showHist, setShowHist] = useState(false);
  const open = trades.filter((t) => t.status === "open");
  const resolved = trades.filter((t) => t.status !== "open").slice().reverse();
  const wins = resolved.filter((t) => t.status === "win").length;
  const losses = resolved.filter((t) => t.status === "loss").length;
  const totalR = resolved.reduce((s, t) => s + (t.resultR ?? 0), 0);
  if (trades.length === 0) return null;

  return (
    <section className={`${CARD} p-6`}>
      <div className="flex items-center justify-between">
        <span className={EYEBROW}>Trades — watch &amp; learn</span>
        <span className="text-[11px] text-stone-400">
          {wins}W / {losses}L ·{" "}
          <span className={totalR >= 0 ? "text-emerald-600" : "text-rose-600"}>
            {totalR >= 0 ? "+" : ""}
            {totalR.toFixed(1)}R
          </span>
        </span>
      </div>

      {open.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {open.map((t) => {
            const dir = DIR_UI[t.direction];
            const span = t.target - t.stop;
            const pos = span ? Math.max(0, Math.min(1, (price - t.stop) / span)) : 0;
            const toTarget = t.direction === "long" ? t.target - price : price - t.target;
            const toStop = t.direction === "long" ? price - t.stop : t.stop - price;
            return (
              <div key={t.id} className="rounded-xl border border-stone-200/80 bg-white p-3.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${dir.cls}`}
                    >
                      {dir.arrow} {dir.label}
                    </span>
                    <span className="text-xs text-stone-400">
                      {SETUP_LABEL[t.setupType]} · {t.rr}R
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-stone-500">
                    ${fmtPrice(t.entry)} → ${fmtPrice(t.target)}
                  </span>
                </div>

                {/* stop —— price —— target progress */}
                <div className="relative mt-2.5 h-1.5 rounded-full bg-gradient-to-r from-rose-200 via-stone-200 to-emerald-200">
                  <span
                    style={{ left: `${pos * 100}%` }}
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-stone-900 shadow"
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] tabular-nums text-stone-400">
                  <span>stop ${fmtPrice(t.stop)}</span>
                  <span className="text-stone-500">now ${fmtPrice(price)}</span>
                  <span>target ${fmtPrice(t.target)}</span>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] text-stone-400">
                    {toTarget >= 0 ? `${fmtPrice(Math.abs(toTarget))} to target` : "past target"} ·{" "}
                    {toStop >= 0 ? `${fmtPrice(Math.abs(toStop))} to stop` : "past stop"} · watching live
                  </span>
                  <span className="flex gap-1.5">
                    <button
                      onClick={() => onResolve(t.id, "win")}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
                    >
                      Win
                    </button>
                    <button
                      onClick={() => onResolve(t.id, "loss")}
                      className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
                    >
                      Loss
                    </button>
                    <button
                      onClick={() => onClose(t.id)}
                      className="rounded-md border border-stone-200 bg-white px-2 py-1 text-[11px] font-medium text-stone-500 hover:bg-stone-50"
                    >
                      Scratch
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {resolved.length > 0 && (
        <div className={open.length > 0 ? "mt-4 border-t border-stone-100 pt-3" : "mt-3"}>
          <button onClick={() => setShowHist((s) => !s)} className="flex w-full items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
              History ({resolved.length})
            </span>
            <span className="text-stone-400">{showHist ? "▲" : "▼"}</span>
          </button>
          {showHist && (
            <div className="mt-2 space-y-1">
              {resolved.slice(0, 20).map((t) => {
                const c =
                  t.status === "win" ? "text-emerald-600" : t.status === "loss" ? "text-rose-600" : "text-stone-400";
                return (
                  <div key={t.id} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2">
                      <span className={`font-medium ${DIR_UI[t.direction].cls.includes("emerald") ? "text-emerald-700" : "text-rose-700"}`}>
                        {DIR_UI[t.direction].label}
                      </span>
                      <span className="text-stone-500">
                        {SETUP_LABEL[t.setupType]} · ${fmtPrice(t.entry)}→${fmtPrice(t.target)}
                      </span>
                    </span>
                    <span className={`font-medium tabular-nums ${c}`}>
                      {t.status === "win" ? "Win" : t.status === "loss" ? "Loss" : "Scratch"}{" "}
                      {t.resultR != null && t.status !== "closed" ? `${t.resultR >= 0 ? "+" : ""}${t.resultR.toFixed(1)}R` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <p className="mt-3 text-[11px] text-stone-400">
        Auto-resolves when price hits target/stop while this page is open; use the buttons if you
        close manually.
      </p>
    </section>
  );
}

export default function Home() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [items, setItems] = useState<ClassifiedItem[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [levels, setLevels] = useState<GoldLevels | null>(null);
  const [timeframe, setTimeframe] = useState<LevelTimeframe>("daily");
  const [trades, setTrades] = useState<Trade[]>([]);
  const [setups, setSetups] = useState<TradeIdea[]>([]);
  const [calendar, setCalendar] = useState<{
    released: CalendarEvent[];
    todayUpcoming: CalendarEvent[];
    later: CalendarEvent[];
  }>({ released: [], todayUpcoming: [], later: [] });
  const [configured, setConfigured] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [alertsOn, setAlertsOn] = useState(false);
  // Set on mount (not during SSR) to avoid a hydration mismatch on time.
  const [now, setNow] = useState<number | null>(null);

  const briefLoaded = useRef(false);
  const classCache = useRef<ClassMap>({});
  const seenIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const notifyQueue = useRef<Set<string>>(new Set());
  const alertsOnRef = useRef(false);
  const timeframeRef = useRef<LevelTimeframe>("daily");
  // Levels currently "armed" (already alerted) — cleared once price backs off,
  // so we alert once per approach rather than every poll.
  const armedLevels = useRef<Set<string>>(new Set());

  const decorate = useCallback(
    (news: NewsItem[]): ClassifiedItem[] =>
      news.map((n) => ({ ...n, classification: classCache.current[n.id] })),
    []
  );

  const fireNotification = useCallback((it: ClassifiedItem) => {
    const c = it.classification;
    if (!c || !alertsOnRef.current) return;
    if (c.stance === "neutral" || c.impact < ALERT_IMPACT) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const arrow = c.stance === "bullish" ? "▲" : "▼";
    new Notification(`${arrow} ${c.stance.toUpperCase()} for gold`, {
      body: `${it.title}\n${c.rationale}`,
      tag: it.id,
    });
  }, []);

  // Send only headlines we haven't classified yet, in small parallel chunks,
  // updating the UI (and cache) as each chunk returns.
  const classifyMissing = useCallback(
    async (news: NewsItem[]) => {
      const missing = news.filter((n) => !classCache.current[n.id]);
      if (missing.length === 0) return;
      const chunks: NewsItem[][] = [];
      for (let i = 0; i < missing.length; i += CLASSIFY_CHUNK) {
        chunks.push(missing.slice(i, i + CLASSIFY_CHUNK));
      }
      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const res = await fetch("/api/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                items: chunk.map((n) => ({
                  id: n.id,
                  title: n.title,
                  source: n.source,
                  summary: n.summary,
                })),
              }),
            });
            const data = await res.json();
            const list: Array<{ id: string } & Classification> = data.classifications ?? [];
            if (list.length === 0) return;
            for (const c of list) {
              classCache.current[c.id] = {
                stance: c.stance,
                confidence: c.confidence,
                impact: c.impact,
                rationale: c.rationale,
              };
              if (notifyQueue.current.has(c.id)) {
                notifyQueue.current.delete(c.id);
                const src = chunk.find((m) => m.id === c.id);
                if (src) fireNotification({ ...src, classification: classCache.current[c.id] });
              }
            }
            writeClassCache(classCache.current);
            setItems((prev) =>
              prev.map((it) =>
                classCache.current[it.id]
                  ? { ...it, classification: classCache.current[it.id] }
                  : it
              )
            );
          } catch {
            /* leave this chunk unclassified; a later poll retries */
          }
        })
      );
    },
    [fireNotification]
  );

  const loadFeed = useCallback(async () => {
    try {
      const res = await fetch("/api/feed", { cache: "no-store" });
      const data = await res.json();
      setConfigured(data.configured);
      const news: NewsItem[] = data.items ?? [];

      // Seed the "seen" set silently on first load; after that, new arrivals
      // become alert-eligible once their classification comes back.
      if (!seeded.current) {
        for (const n of news) seenIds.current.add(n.id);
        seeded.current = true;
      } else {
        for (const n of news) {
          if (!seenIds.current.has(n.id)) {
            seenIds.current.add(n.id);
            notifyQueue.current.add(n.id);
          }
        }
      }

      setItems(decorate(news));
      setUpdatedAt(data.updatedAt ?? null);
      setLoading(false);
      if (data.configured) classifyMissing(news);
    } catch {
      setLoading(false);
    }
  }, [decorate, classifyMissing]);

  const loadPrice = useCallback(async () => {
    try {
      const res = await fetch("/api/price", { cache: "no-store" });
      const data = await res.json();
      setQuotes(data.quotes ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  // Fire a desktop alert the moment price comes within NEAR of a level; re-arm
  // only after it backs off beyond CLEAR so we don't spam on every poll.
  const checkLevelAlerts = useCallback((data: GoldLevels) => {
    const price = data.price;
    if (!price) return;
    for (const lvl of data.levels) {
      const key = `${data.timeframe}:${lvl.label}`;
      const dist = Math.abs(lvl.price - price) / price;
      if (dist <= NEAR_PCT) {
        if (
          !armedLevels.current.has(key) &&
          alertsOnRef.current &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          const side = lvl.kind === "resistance" ? "resistance" : lvl.kind === "support" ? "support" : "pivot";
          new Notification(`◆ Gold approaching ${lvl.label}`, {
            body: `$${fmtPrice(price)} — within 0.1% of ${lvl.label} (${side}) at $${fmtPrice(lvl.price)}`,
            tag: key,
          });
        }
        armedLevels.current.add(key);
      } else if (dist > CLEAR_PCT) {
        armedLevels.current.delete(key);
      }
    }
  }, []);

  const loadLevels = useCallback(
    async (tf?: LevelTimeframe) => {
      const active = tf ?? timeframeRef.current;
      try {
        const res = await fetch(`/api/levels?tf=${active}`, { cache: "no-store" });
        const data = await res.json();
        if (data.levels) {
          setLevels(data.levels);
          checkLevelAlerts(data.levels);
        }
      } catch {
        /* ignore */
      }
    },
    [checkLevelAlerts]
  );

  const changeTimeframe = useCallback(
    (tf: LevelTimeframe) => {
      timeframeRef.current = tf;
      armedLevels.current.clear(); // different level set — reset arming
      setTimeframe(tf);
      loadLevels(tf);
    },
    [loadLevels]
  );

  const persistTrades = useCallback((updater: (prev: Trade[]) => Trade[]) => {
    setTrades((prev) => {
      const next = updater(prev);
      writeTrades(next);
      return next;
    });
  }, []);

  const takeTrade = useCallback(
    (idea: TradeIdea) => {
      const trade: Trade = {
        id: `${idea.id}#${Date.now()}`,
        takenAt: Date.now(),
        direction: idea.direction,
        setupType: idea.setupType,
        triggerLabel: idea.triggerLabel,
        targetLabel: idea.targetLabel,
        entry: idea.entry,
        target: idea.target,
        stop: idea.stop,
        rr: idea.rr,
        rationale: idea.rationale,
        status: "open",
      };
      persistTrades((prev) => [...prev, trade]);
    },
    [persistTrades]
  );

  const resolveTrade = useCallback(
    (id: string, result: "win" | "loss") => {
      persistTrades((prev) =>
        prev.map((t) =>
          t.id === id && t.status === "open"
            ? { ...t, status: result, resolvedAt: Date.now(), resultR: result === "win" ? t.rr : -1 }
            : t
        )
      );
    },
    [persistTrades]
  );

  const closeTrade = useCallback(
    (id: string) => {
      persistTrades((prev) =>
        prev.map((t) =>
          t.id === id && t.status === "open"
            ? { ...t, status: "closed", resolvedAt: Date.now(), resultR: 0 }
            : t
        )
      );
    },
    [persistTrades]
  );

  // Watch open trades against the live price and auto-resolve win/loss.
  useEffect(() => {
    if (!levels) return;
    const price = levels.price;
    persistTrades((prev) => {
      let changed = false;
      const next: Trade[] = prev.map((t): Trade => {
        if (t.status !== "open") return t;
        const hitTarget = t.direction === "long" ? price >= t.target : price <= t.target;
        const hitStop = t.direction === "long" ? price <= t.stop : price >= t.stop;
        if (hitTarget || hitStop) {
          changed = true;
          const won = hitTarget && !hitStop;
          if (
            alertsOnRef.current &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            new Notification(won ? "✓ Trade hit target" : "✗ Trade hit stop", {
              body: `${t.direction.toUpperCase()} ${SETUP_LABEL[t.setupType]} · ${won ? `+${t.rr}` : "-1"}R`,
              tag: t.id,
            });
          }
          return {
            ...t,
            status: won ? "win" : "loss",
            resolvedAt: Date.now(),
            resultR: won ? t.rr : -1,
          };
        }
        return t;
      });
      return changed ? next : prev;
    });
    // persistTrades is stable; only re-run when levels (price) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels]);

  const loadSetups = useCallback(async () => {
    try {
      const res = await fetch("/api/setups", { cache: "no-store" });
      const data = await res.json();
      setSetups(data.setups ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadCalendar = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar", { cache: "no-store" });
      const data = await res.json();
      setCalendar({
        released: data.released ?? [],
        todayUpcoming: data.todayUpcoming ?? [],
        later: data.later ?? [],
      });
    } catch {
      /* ignore */
    }
  }, []);

  const toggleAlerts = useCallback(async () => {
    if (alertsOn) {
      setAlertsOn(false);
      alertsOnRef.current = false;
      return;
    }
    if (typeof Notification === "undefined") return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") {
      setAlertsOn(true);
      alertsOnRef.current = true;
    }
  }, [alertsOn]);

  const loadBrief = useCallback(async (refresh = false) => {
    if (!refresh) {
      const cached = readBriefCache();
      if (cached && Date.now() - cached.at < BRIEF_TTL_MS) {
        setBrief(cached.brief);
        return;
      }
    }
    try {
      const res = await fetch(`/api/brief${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      setConfigured(data.configured);
      if (data.brief) {
        setBrief(data.brief);
        writeBriefCache(data.brief);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    classCache.current = readClassCache();
    const cachedBrief = readBriefCache();
    if (cachedBrief) setBrief(cachedBrief.brief);
    setTrades(readTrades());

    setNow(Date.now());
    const clockId = setInterval(() => setNow(Date.now()), 15_000);

    loadFeed();
    loadPrice();
    loadLevels();
    loadSetups();
    loadCalendar();
    if (!briefLoaded.current) {
      briefLoaded.current = true;
      loadBrief();
    }
    const feedId = setInterval(loadFeed, POLL_MS);
    const priceId = setInterval(loadPrice, POLL_MS);
    const levelsId = setInterval(loadLevels, POLL_MS);
    const setupsId = setInterval(loadSetups, POLL_MS);
    const calId = setInterval(loadCalendar, CALENDAR_POLL_MS);
    return () => {
      clearInterval(clockId);
      clearInterval(feedId);
      clearInterval(priceId);
      clearInterval(levelsId);
      clearInterval(setupsId);
      clearInterval(calId);
    };
  }, [loadFeed, loadBrief, loadPrice, loadLevels, loadSetups, loadCalendar]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "bullish":
        return items.filter((i) => i.classification?.stance === "bullish");
      case "bearish":
        return items.filter((i) => i.classification?.stance === "bearish");
      case "high-impact":
        return items.filter((i) => (i.classification?.impact ?? 0) >= 3);
      default:
        return items;
    }
  }, [items, filter]);

  const counts = useMemo(() => {
    let bull = 0,
      bear = 0,
      hot = 0;
    for (const i of items) {
      const c = i.classification;
      if (c?.stance === "bullish") bull++;
      if (c?.stance === "bearish") bear++;
      if ((c?.impact ?? 0) >= 3) hot++;
    }
    return { bull, bear, hot };
  }, [items]);

  const hasCalendar =
    calendar.todayUpcoming.length > 0 ||
    calendar.released.length > 0 ||
    calendar.later.length > 0;

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-stone-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400/15 text-[15px] text-amber-500">
              ◆
            </span>
            <div className="leading-tight">
              <h1 className="text-[15px] font-semibold text-stone-900">GoldPulse</h1>
              <p className="text-[11px] text-stone-400">Gold news, read for direction</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleAlerts}
              title="Desktop alerts for high-impact bullish/bearish headlines"
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                alertsOn
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${alertsOn ? "bg-emerald-500" : "bg-stone-300"}`}
              />
              {alertsOn ? "Alerts on" : "Alerts"}
            </button>
            <button
              onClick={() => {
                loadFeed();
                loadPrice();
                loadLevels();
                loadSetups();
                loadCalendar();
                loadBrief(true);
              }}
              className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-50"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-6 sm:py-8">
        {now != null && (
          <div className="mb-4">
            <SessionPanel now={now} upcoming={calendar.todayUpcoming} />
          </div>
        )}

        {quotes.length > 0 && (
          <div className="mb-4">
            <PriceStrip quotes={quotes} updatedAt={updatedAt} />
          </div>
        )}

        {levels && (
          <div className="mb-4">
            <LevelsCard data={levels} timeframe={timeframe} onTimeframe={changeTimeframe} />
          </div>
        )}

        {levels && (
          <div className="mb-4">
            <RecommendationsCard ideas={setups} trades={trades} price={levels.price} onTake={takeTrade} />
          </div>
        )}

        {trades.length > 0 && levels && (
          <div className="mb-4">
            <TradesCard
              trades={trades}
              price={levels.price}
              onResolve={resolveTrade}
              onClose={closeTrade}
            />
          </div>
        )}

        {now != null && (
          <div className="mb-6">
            <ChecklistCard now={now} />
          </div>
        )}

        {!configured && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <p className="font-medium">No Anthropic API key detected.</p>
            <p className="mt-1 text-amber-700">
              Add <code className="rounded bg-amber-100 px-1">ANTHROPIC_API_KEY</code> as an
              environment variable. The live news feed and calendar still work below — only the
              AI classification and daily brief need the key.
            </p>
          </div>
        )}

        {brief ? (
          <div className="mb-6">
            <BriefCard brief={brief} />
          </div>
        ) : configured ? (
          <div className={`${CARD} mb-6 p-6`}>
            <span className={EYEBROW}>Daily Brief</span>
            <div className="mt-3 space-y-2">
              <div className="h-5 w-2/3 animate-pulse rounded bg-stone-100" />
              <div className="h-3 w-full animate-pulse rounded bg-stone-100" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-stone-100" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-stone-100" />
            </div>
            <p className="mt-3 text-xs text-stone-400">Generating today’s brief…</p>
          </div>
        ) : null}

        {hasCalendar && (
          <div className="mb-8">
            <CalendarPanel
              released={calendar.released}
              todayUpcoming={calendar.todayUpcoming}
              later={calendar.later}
            />
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <span className={EYEBROW}>Live Feed</span>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Pill active={filter === "all"} onClick={() => setFilter("all")}>
            All ({items.length})
          </Pill>
          <Pill active={filter === "bullish"} onClick={() => setFilter("bullish")}>
            <span className="text-emerald-500">▲</span> Bullish ({counts.bull})
          </Pill>
          <Pill active={filter === "bearish"} onClick={() => setFilter("bearish")}>
            <span className="text-rose-500">▼</span> Bearish ({counts.bear})
          </Pill>
          <Pill active={filter === "high-impact"} onClick={() => setFilter("high-impact")}>
            <span className="text-amber-500">★</span> High impact ({counts.hot})
          </Pill>
        </div>

        <section className="space-y-2.5">
          {loading && items.length === 0 ? (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          ) : filtered.length === 0 ? (
            <div className={`${CARD} py-12 text-center text-sm text-stone-400`}>
              Nothing matches this filter yet.
            </div>
          ) : (
            filtered.map((item) => <NewsRow key={item.id} item={item} />)
          )}
        </section>

        <footer className="mt-10 border-t border-stone-200 pt-5 text-center text-[11px] text-stone-400">
          GoldPulse · free RSS sources · AI classification is probabilistic and for research only
          — not financial advice.
        </footer>
      </main>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-stone-900 text-white"
          : "border border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
      }`}
    >
      {children}
    </button>
  );
}
