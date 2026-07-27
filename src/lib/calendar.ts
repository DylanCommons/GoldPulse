import { CalendarEvent, EventImpact } from "./types";

/**
 * Free ForexFactory economic calendar, republished as JSON by FairEconomy.
 * No API key required. `thisweek` covers Sun-Sat of the current week and
 * includes `actual` values once an event is released.
 */
const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

interface RawEvent {
  title: string;
  country: string; // e.g. "USD", "EUR"
  date: string; // ISO with offset
  impact: string; // "High" | "Medium" | "Low" | "Holiday"
  forecast: string;
  previous: string;
  actual?: string;
}

function normImpact(s: string): EventImpact {
  const v = s.toLowerCase();
  if (v === "high") return "high";
  if (v === "medium") return "medium";
  if (v === "low") return "low";
  return "none";
}

/**
 * Which events actually matter for gold. The gold price is driven first by
 * the US dollar and Fed path, so we keep:
 *   - every High-impact event globally (ECB, China GDP, etc. still ripple), and
 *   - USD Medium-impact events (secondary US data traders watch).
 * Low-impact and holidays are dropped.
 */
function isGoldRelevant(country: string, impact: EventImpact): boolean {
  if (impact === "high") return true;
  if (impact === "medium" && country === "USD") return true;
  return false;
}

export async function fetchCalendar(): Promise<CalendarEvent[]> {
  try {
    const res = await fetch(CALENDAR_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (GoldPulse; calendar reader)" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as RawEvent[];
    return raw
      .map((e) => {
        const impact = normImpact(e.impact);
        return {
          title: e.title,
          country: e.country,
          date: new Date(e.date).toISOString(),
          impact,
          forecast: e.forecast || null,
          previous: e.previous || null,
          actual: e.actual || null,
        } satisfies CalendarEvent;
      })
      .filter((e) => isGoldRelevant(e.country, e.impact))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  } catch {
    return [];
  }
}

/** Split the week's events relative to now: released (has actual), today-upcoming, later. */
export function bucketEvents(events: CalendarEvent[]) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const todayEnd = endOfToday.getTime();

  const released: CalendarEvent[] = [];
  const todayUpcoming: CalendarEvent[] = [];
  const later: CalendarEvent[] = [];

  for (const e of events) {
    const t = Date.parse(e.date);
    if (e.actual) released.push(e);
    else if (t <= todayEnd && t >= now - dayMs) todayUpcoming.push(e);
    else if (t > todayEnd) later.push(e);
  }
  // Most recent releases first; keep a short tail.
  released.reverse();
  return { released: released.slice(0, 8), todayUpcoming, later: later.slice(0, 12) };
}
