"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Brief,
  CalendarEvent,
  Classification,
  ClassifiedItem,
  EventImpact,
  NewsItem,
  Quote,
  Stance,
} from "@/lib/types";

const POLL_MS = 60_000;
const CALENDAR_POLL_MS = 5 * 60_000;
// Fire a desktop alert only for genuinely market-moving, directional headlines.
const ALERT_IMPACT = 3;
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

type Filter = "all" | "bullish" | "bearish" | "high-impact";

const STANCE_UI: Record<
  Stance,
  { label: string; dot: string; text: string; ring: string; bg: string }
> = {
  bullish: {
    label: "Bullish",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    ring: "ring-emerald-500/30",
    bg: "bg-emerald-500/5",
  },
  bearish: {
    label: "Bearish",
    dot: "bg-rose-400",
    text: "text-rose-300",
    ring: "ring-rose-500/30",
    bg: "bg-rose-500/5",
  },
  neutral: {
    label: "Neutral",
    dot: "bg-zinc-400",
    text: "text-zinc-300",
    ring: "ring-zinc-500/20",
    bg: "bg-transparent",
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
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${ui.text} ring-1 ${ui.ring}`}
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
          className={`h-3 w-1 rounded-sm ${
            n <= impact ? "bg-amber-400" : "bg-zinc-700"
          }`}
        />
      ))}
    </span>
  );
}

function BriefCard({ brief }: { brief: Brief }) {
  const ui = STANCE_UI[brief.bias];
  return (
    <section
      className={`rounded-2xl border border-zinc-800 ${ui.bg} p-5 ring-1 ${ui.ring}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Daily Brief
        </h2>
        <StanceBadge stance={brief.bias} />
      </div>
      <p className="mt-2 text-lg font-semibold text-zinc-100">{brief.headline}</p>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-300">
        {brief.summary
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
      </div>

      {brief.drivers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Key drivers
          </h3>
          <ul className="mt-2 space-y-2">
            {brief.drivers.map((d, i) => (
              <li key={i} className="flex gap-2.5 text-sm">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STANCE_UI[d.stance].dot}`}
                />
                <span className="text-zinc-300">
                  <span className="font-medium text-zinc-100">{d.title}.</span>{" "}
                  {d.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {brief.watchlist.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Watch today
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {brief.watchlist.map((w, i) => (
              <li
                key={i}
                className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300"
              >
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-[11px] text-zinc-600">
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
      className={`rounded-xl border border-zinc-800/80 ${ui.bg} p-4 transition-colors hover:border-zinc-700`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-zinc-100 hover:underline"
          >
            {item.title}
          </a>
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
            <span>{item.source}</span>
            <span>·</span>
            <span>{timeAgo(item.publishedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {c ? <StanceBadge stance={c.stance} /> : (
            <span className="text-xs text-zinc-600">…</span>
          )}
          {c && c.impact > 0 && <ImpactMeter impact={c.impact} />}
        </div>
      </div>
      {c?.rationale && (
        <p className="mt-2 text-xs leading-relaxed text-zinc-400">
          {c.rationale}
          {c.confidence != null && (
            <span className="text-zinc-600">
              {" "}
              · {Math.round(c.confidence * 100)}% conf
            </span>
          )}
        </p>
      )}
    </article>
  );
}

function PriceStrip({ quotes }: { quotes: Quote[] }) {
  if (quotes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      {quotes.map((q) => {
        const up = q.change >= 0;
        return (
          <div key={q.symbol} className="flex items-baseline gap-1.5">
            <span className="text-xs text-zinc-500">{q.name}</span>
            <span className="text-sm font-semibold text-zinc-100">
              {q.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className={`text-xs font-medium ${up ? "text-emerald-400" : "text-rose-400"}`}>
              {up ? "▲" : "▼"} {Math.abs(q.changePct).toFixed(2)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

const IMPACT_UI: Record<EventImpact, { dot: string; label: string }> = {
  high: { dot: "bg-rose-400", label: "High" },
  medium: { dot: "bg-amber-400", label: "Med" },
  low: { dot: "bg-zinc-500", label: "Low" },
  none: { dot: "bg-zinc-600", label: "" },
};

function eventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function eventDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "America/New_York",
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
    <div className="flex items-center gap-2.5 py-1.5 text-xs">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ui.dot}`} />
      <span className="w-24 shrink-0 tabular-nums text-zinc-500">
        {showDay ? `${eventDay(e.date)} ` : ""}
        {eventTime(e.date)} ET
      </span>
      <span className="w-9 shrink-0 font-medium text-zinc-500">{e.country}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-200">{e.title}</span>
      <span className="shrink-0 tabular-nums text-zinc-500">
        {e.actual != null ? (
          <span className={surprise === "up" ? "text-emerald-300" : surprise === "down" ? "text-rose-300" : "text-zinc-200"}>
            {e.actual}
            {surprise && (surprise === "up" ? " ↑" : " ↓")}
          </span>
        ) : e.forecast != null ? (
          <span className="text-zinc-500">f/c {e.forecast}</span>
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
    <section className="rounded-2xl border border-zinc-800 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Economic Calendar
        </h2>
        <div className="flex gap-1.5">
          <FilterTab active={tab === "today"} onClick={() => setTab("today")}>
            Today
          </FilterTab>
          <FilterTab active={tab === "week"} onClick={() => setTab("week")}>
            Rest of week
          </FilterTab>
        </div>
      </div>

      {tab === "today" ? (
        <div className="mt-3 divide-y divide-zinc-900">
          {todayUpcoming.length > 0 && (
            <div className="pb-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-400/80">
                Still to come
              </p>
              {todayUpcoming.map((e, i) => (
                <EventRow key={`u${i}`} e={e} />
              ))}
            </div>
          )}
          {released.length > 0 && (
            <div className="pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600">
                Released
              </p>
              {released.map((e, i) => (
                <EventRow key={`r${i}`} e={e} showDay />
              ))}
            </div>
          )}
          {!hasToday && (
            <p className="py-3 text-xs text-zinc-600">No high-impact events left today.</p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          {later.length > 0 ? (
            later.map((e, i) => <EventRow key={`l${i}`} e={e} showDay />)
          ) : (
            <p className="py-3 text-xs text-zinc-600">Nothing else scheduled this week.</p>
          )}
        </div>
      )}
      <p className="mt-3 text-[11px] text-zinc-600">
        High-impact + USD events · times US Eastern · via ForexFactory
      </p>
    </section>
  );
}

export default function Home() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [items, setItems] = useState<ClassifiedItem[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
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

  const briefLoaded = useRef(false);
  const classCache = useRef<ClassMap>({});
  const seenIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const notifyQueue = useRef<Set<string>>(new Set());
  const alertsOnRef = useRef(false);

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

    loadFeed();
    loadPrice();
    loadCalendar();
    if (!briefLoaded.current) {
      briefLoaded.current = true;
      loadBrief();
    }
    const feedId = setInterval(loadFeed, POLL_MS);
    const priceId = setInterval(loadPrice, POLL_MS);
    const calId = setInterval(loadCalendar, CALENDAR_POLL_MS);
    return () => {
      clearInterval(feedId);
      clearInterval(priceId);
      clearInterval(calId);
    };
  }, [loadFeed, loadBrief, loadPrice, loadCalendar]);

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

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-zinc-100">
              <span className="text-amber-400">◆</span> GoldPulse
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Gold (XAU/USD) news, read for direction
              {updatedAt && ` · updated ${timeAgo(updatedAt)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleAlerts}
              title="Desktop alerts for high-impact bullish/bearish headlines"
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                alertsOn
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
              }`}
            >
              {alertsOn ? "🔔 Alerts on" : "🔕 Alerts off"}
            </button>
            <button
              onClick={() => {
                loadFeed();
                loadPrice();
                loadCalendar();
                loadBrief(true);
              }}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-700"
            >
              Refresh
            </button>
          </div>
        </div>
        {quotes.length > 0 && (
          <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
            <PriceStrip quotes={quotes} />
          </div>
        )}
      </header>

      {!configured && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200">
          <p className="font-medium">No Anthropic API key detected.</p>
          <p className="mt-1 text-amber-200/80">
            Add <code className="rounded bg-black/30 px-1">ANTHROPIC_API_KEY</code>{" "}
            to a <code className="rounded bg-black/30 px-1">.env.local</code> file and
            restart. The live news feed still loads below — only the AI
            classification and daily brief need the key.
          </p>
        </div>
      )}

      {brief ? (
        <div className="mb-4">
          <BriefCard brief={brief} />
        </div>
      ) : configured ? (
        <div className="mb-4 animate-pulse rounded-2xl border border-zinc-800 p-5 text-sm text-zinc-500">
          Generating today&apos;s brief…
        </div>
      ) : null}

      {(calendar.todayUpcoming.length > 0 ||
        calendar.released.length > 0 ||
        calendar.later.length > 0) && (
        <div className="mb-8">
          <CalendarPanel
            released={calendar.released}
            todayUpcoming={calendar.todayUpcoming}
            later={calendar.later}
          />
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <FilterTab active={filter === "all"} onClick={() => setFilter("all")}>
          All ({items.length})
        </FilterTab>
        <FilterTab active={filter === "bullish"} onClick={() => setFilter("bullish")}>
          <span className="text-emerald-400">▲</span> Bullish ({counts.bull})
        </FilterTab>
        <FilterTab active={filter === "bearish"} onClick={() => setFilter("bearish")}>
          <span className="text-rose-400">▼</span> Bearish ({counts.bear})
        </FilterTab>
        <FilterTab
          active={filter === "high-impact"}
          onClick={() => setFilter("high-impact")}
        >
          <span className="text-amber-400">★</span> High impact ({counts.hot})
        </FilterTab>
      </div>

      <section className="space-y-2.5">
        {loading && items.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-600">
            Loading news…
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-600">
            Nothing matches this filter yet.
          </p>
        ) : (
          filtered.map((item) => <NewsRow key={item.id} item={item} />)
        )}
      </section>

      <footer className="mt-10 border-t border-zinc-900 pt-4 text-center text-[11px] text-zinc-700">
        GoldPulse · free RSS sources · AI classification is probabilistic and for
        research only — not financial advice.
      </footer>
    </main>
  );
}

function FilterTab({
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
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-zinc-100 text-zinc-900"
          : "border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}
