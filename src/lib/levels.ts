import { GoldLevels, PriceLevel } from "./types";

// Daily candles for gold futures — enough history to read the prior session.
const CHART_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1d&range=3mo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Key supply/demand levels for gold, computed with classic floor-trader pivot
 * points from the prior completed session. These are deterministic maths on
 * real OHLC data — never AI-guessed — so a trader can rely on the numbers.
 *
 *   Pivot P = (High + Low + Close) / 3
 *   R1 = 2P − Low     S1 = 2P − High
 *   R2 = P + (H − L)  S2 = P − (H − L)
 *   R3 = H + 2(P − L) S3 = L − 2(H − P)
 */
export async function fetchGoldLevels(): Promise<GoldLevels | null> {
  try {
    const res = await fetch(CHART_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (GoldPulse; levels)" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const q = result?.indicators?.quote?.[0];
    const ts: number[] = result?.timestamp ?? [];
    if (!meta || !q || ts.length < 2) return null;

    const candles: { t: number; high: number; low: number; close: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const high = num(q.high?.[i]);
      const low = num(q.low?.[i]);
      const close = num(q.close?.[i]);
      if (high == null || low == null || close == null) continue;
      candles.push({ t: ts[i], high, low, close });
    }
    if (candles.length < 2) return null;

    const price = num(meta.regularMarketPrice) ?? candles[candles.length - 1].close;
    const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dayOf = (t: number) =>
      new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    // Daily change vs the most recent completed session's close. (Yahoo's
    // chartPreviousClose over a 3-month range is months old, so we can't use it.)
    let prevClose = candles[candles.length - 2].close;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (dayOf(candles[i].t) < todayET) {
        prevClose = candles[i].close;
        break;
      }
    }
    const change = price - prevClose;

    // Pivots come from the most recent *completed* session with a real range —
    // skip today's in-progress candle and any degenerate ones (holiday/thin
    // days where the feed reports a near-zero range that collapses the levels).
    const minRange = price * 0.002; // ~0.2%; filters out junk candles
    let basis = candles[candles.length - 2];
    for (let i = candles.length - 1; i >= 0; i--) {
      if (dayOf(candles[i].t) >= todayET) continue; // skip today / future stub
      if (candles[i].high - candles[i].low < minRange) continue; // skip degenerate
      basis = candles[i];
      break;
    }

    const H = basis.high;
    const L = basis.low;
    const C = basis.close;
    const P = (H + L + C) / 3;

    const raw: PriceLevel[] = [
      { label: "R3", price: H + 2 * (P - L), kind: "resistance" },
      { label: "R2", price: P + (H - L), kind: "resistance" },
      { label: "R1", price: 2 * P - L, kind: "resistance" },
      { label: "Pivot", price: P, kind: "pivot" },
      { label: "S1", price: 2 * P - H, kind: "support" },
      { label: "S2", price: P - (H - L), kind: "support" },
      { label: "S3", price: L - 2 * (H - P), kind: "support" },
    ];
    const levels: PriceLevel[] = raw.map((l) => ({ ...l, price: round1(l.price) }));

    return {
      price: round1(price),
      change: round1(change),
      changePct: prevClose ? (change / prevClose) * 100 : 0,
      dayHigh: meta.regularMarketDayHigh != null ? round1(Number(meta.regularMarketDayHigh)) : null,
      dayLow: meta.regularMarketDayLow != null ? round1(Number(meta.regularMarketDayLow)) : null,
      yearHigh: num(meta.fiftyTwoWeekHigh),
      yearLow: num(meta.fiftyTwoWeekLow),
      asOf: new Date(basis.t * 1000).toISOString(),
      levels,
    };
  } catch {
    return null;
  }
}
