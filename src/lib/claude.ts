import Anthropic from "@anthropic-ai/sdk";
import { Brief, CalendarEvent, Classification, NewsItem, Stance } from "./types";

const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001";
const BRIEF_MODEL = process.env.BRIEF_MODEL ?? "claude-sonnet-5";

export function hasKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function client(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

const STANCES: Stance[] = ["bullish", "bearish", "neutral"];

function coerceStance(v: unknown): Stance {
  const s = String(v).toLowerCase();
  return (STANCES as string[]).includes(s) ? (s as Stance) : "neutral";
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const x = Number(n);
  if (Number.isNaN(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

/** Pull the first JSON value (object or array) out of a model response. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error("no json found");
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close) {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced json");
}

const CLASSIFY_SYSTEM = `You are a sharp gold (XAU/USD) trading desk analyst. You judge news for its
effect on the SPOT GOLD PRICE over the next few hours to days — the horizon of a day trader.

Reason through the standard transmission channels:
- US dollar (DXY): stronger USD = bearish gold, weaker USD = bullish gold.
- US real yields / rate expectations: higher yields or hawkish Fed = bearish; cuts/dovish = bullish.
- Inflation surprises: hotter CPI/PCE is mixed — hawkish-Fed reaction usually wins short-term (bearish),
  though persistent inflation can be bullish. Weigh the likely Fed reaction.
- Risk sentiment & geopolitics: war, crisis, banking stress = safe-haven bid = bullish.
- Physical/flow: central-bank buying, ETF flows, strong physical demand = bullish.

For EACH numbered headline return an object with:
  i: the item number
  stance: "bullish" | "bearish" | "neutral"  (effect on the gold price)
  confidence: 0.0-1.0
  impact: 0-5  (how market-moving for gold specifically; 0 = irrelevant/off-topic, 5 = major mover like an FOMC decision or CPI print)
  rationale: ONE concise sentence naming the channel (e.g. "Dovish Fed tilt pressures USD and real yields — supportive for gold").

Off-topic or non-financial headlines get stance "neutral", impact 0.
Respond with ONLY a JSON array, no prose.`;

/** Classify a batch of headlines. Returns a map of item.id -> Classification. */
export async function classifyHeadlines(
  items: NewsItem[]
): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();
  const anthropic = client();
  if (!anthropic || items.length === 0) return out;

  const BATCH = 40;
  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH);
    const list = batch
      .map((it, i) => {
        const ctx = it.summary ? ` — ${it.summary.slice(0, 180)}` : "";
        return `${i + 1}. [${it.source}] ${it.title}${ctx}`;
      })
      .join("\n");

    try {
      const msg = await anthropic.messages.create({
        model: CLASSIFY_MODEL,
        max_tokens: 4096,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: "user", content: `Headlines:\n${list}` }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parsed = extractJson(text) as Array<Record<string, unknown>>;
      for (const row of parsed) {
        const idx = Number(row.i) - 1;
        const item = batch[idx];
        if (!item) continue;
        out.set(item.id, {
          stance: coerceStance(row.stance),
          confidence: clamp(row.confidence, 0, 1, 0.5),
          impact: clamp(row.impact, 0, 5, 0),
          rationale: String(row.rationale ?? "").slice(0, 300),
        });
      }
    } catch {
      // Leave this batch unclassified rather than failing the whole request.
    }
  }
  return out;
}

const BRIEF_SYSTEM = `You are the morning strategist for Dylan, a gold (XAU/USD) day trader based in
Ireland who trades the ICC method (Indication → Correction → Continuation): he only enters WITH the
higher-timeframe trend, on a confirmed continuation, and he avoids counter-trend trades in choppy
conditions and around high-impact data releases. Write a tight pre-session brief on what is driving
gold and the near-term directional bias. Be concrete and honest about uncertainty — this is decision
support for a disciplined with-trend trader, not a signal to trade blindly.

Frame it for his workflow: (1) note whether today looks like a CLEAN trading day or an EVENT day to
sit out around the release; (2) state the higher-timeframe lean so he can judge with-trend vs counter-
trend; (3) respect the current "good-news-is-bad-for-gold" regime (strong US data/oil/inflation →
hawkish-Fed fears → gold down). Express any times in Irish time (IST).

Return ONLY a JSON object:
{
  "headline": "one-line verdict, e.g. 'Gold leaning bullish as USD softens into US session'",
  "bias": "bullish" | "bearish" | "neutral",
  "summary": "2-3 short markdown paragraphs on the macro backdrop, the dominant channel (USD, yields, risk, flows), and how it's tilting gold",
  "drivers": [
    { "title": "short driver name", "detail": "one sentence on why it matters for gold", "stance": "bullish|bearish|neutral" }
  ],
  "watchlist": ["specific things to watch today — scheduled data, Fed speakers, geopolitical flashpoints, key levels if mentioned"]
}
Give 3-5 drivers and 3-6 watchlist items. No text outside the JSON.`;

function formatEventLine(e: CalendarEvent): string {
  const t = new Date(e.date).toLocaleString("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Dublin",
  });
  const nums = [
    e.actual != null ? `actual ${e.actual}` : null,
    e.forecast != null ? `forecast ${e.forecast}` : null,
    e.previous != null ? `prev ${e.previous}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `${t} IST · ${e.country} · ${e.title} [${e.impact}]${nums ? ` (${nums})` : ""}`;
}

export async function generateBrief(
  items: NewsItem[],
  events: CalendarEvent[] = []
): Promise<Brief | null> {
  const anthropic = client();
  if (!anthropic) return null;

  const recent = items.slice(0, 35);
  const list = recent
    .map((it, i) => `${i + 1}. [${it.source}] ${it.title}${it.summary ? ` — ${it.summary.slice(0, 160)}` : ""}`)
    .join("\n");

  const calendarBlock =
    events.length > 0
      ? `\n\nScheduled economic events this week (times IST, Irish). Use these for the "watch today" list and to flag catalysts BEFORE they hit:\n${events
          .map(formatEventLine)
          .join("\n")}`
      : "";

  try {
    const msg = await anthropic.messages.create({
      model: BRIEF_MODEL,
      max_tokens: 2048,
      system: BRIEF_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Today's recent gold-relevant headlines:\n${list}${calendarBlock}\n\nWrite the brief.`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const j = extractJson(text) as Record<string, unknown>;
    return {
      generatedAt: new Date().toISOString(),
      headline: String(j.headline ?? "Gold brief"),
      bias: coerceStance(j.bias),
      summary: String(j.summary ?? ""),
      drivers: Array.isArray(j.drivers)
        ? (j.drivers as Array<Record<string, unknown>>).slice(0, 6).map((d) => ({
            title: String(d.title ?? ""),
            detail: String(d.detail ?? ""),
            stance: coerceStance(d.stance),
          }))
        : [],
      watchlist: Array.isArray(j.watchlist)
        ? (j.watchlist as unknown[]).slice(0, 8).map((w) => String(w))
        : [],
    };
  } catch {
    return null;
  }
}

const PULSE_SYSTEM = `You explain the gold/dollar relationship to a trader who is still learning the
macro. In ONE or TWO short, plain-English sentences, explain WHY the US dollar is moving the way it is
right now and how that connects to gold's move. Name the real driver from the headlines (Fed / rate
expectations, US data, Treasury yields, risk-off/geopolitics). Teach the mechanism simply — e.g. "a
weaker dollar makes dollar-priced gold cheaper for other currencies, so demand rises". No jargon dumps,
no preamble, no bullet points, no "today". Just the explanation, like a mentor in one breath.`;

function pctPhrase(pct: number): string {
  if (Math.abs(pct) < 0.03) return "roughly flat";
  return `${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(2)}%`;
}

/** One-line, teaching explanation of the current dollar move and its gold link. */
export async function generatePulse(
  items: NewsItem[],
  goldPct: number,
  dollarPct: number
): Promise<string | null> {
  const anthropic = client();
  if (!anthropic) return null;
  const list = items.slice(0, 20).map((it, i) => `${i + 1}. ${it.title}`).join("\n");
  try {
    const msg = await anthropic.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 220,
      system: PULSE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Right now gold is ${pctPhrase(goldPct)} and the US Dollar index (DXY) is ${pctPhrase(
            dollarPct
          )}.\nRecent headlines:\n${list}\n\nExplain the dollar move and the gold link in 1–2 sentences.`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}
