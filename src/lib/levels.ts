import { GoldLevels, LevelTimeframe, PriceLevel, Trend } from "./types";

interface Candle {
  t: number; // ms
  high: number;
  low: number;
  close: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Comparable "which session/hour" key in US Eastern (the futures trading day).
function periodKey(ms: number, intraday: boolean): string {
  const d = new Date(ms);
  if (intraday) {
    return d.toLocaleString("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchCandles(
  interval: string,
  range: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ candles: Candle[]; meta: any } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;
  try {
    const res = await fetch(url, {
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
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const high = num(q.high?.[i]);
      const low = num(q.low?.[i]);
      const close = num(q.close?.[i]);
      if (high == null || low == null || close == null) continue;
      candles.push({ t: ts[i] * 1000, high, low, close });
    }
    if (candles.length < 2) return null;
    return { candles, meta };
  } catch {
    return null;
  }
}

function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevC = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevC), Math.abs(low - prevC)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / period;
}

/**
 * Key supply/demand levels for gold via classic floor-trader pivot points,
 * plus 50/200 EMA trend bias and ATR(14) — all deterministic maths on real
 * OHLC data (never AI-guessed).
 *
 * "daily" pivots come from the prior completed session; "intraday" from the
 * prior completed hour (tight scalping levels). EMA/ATR are always computed
 * from the daily series (a higher-timeframe read).
 */
export async function fetchGoldLevels(
  timeframe: LevelTimeframe = "daily"
): Promise<GoldLevels | null> {
  const intraday = timeframe === "intraday";

  // Daily set (1y) always — needed for EMA200 + ATR + daily context.
  const daily = await fetchCandles("1d", "1y");
  if (!daily) return null;
  const meta = daily.meta;

  // Pivot/chart source depends on the timeframe.
  const src = intraday ? await fetchCandles("60m", "5d") : daily;
  if (!src) return null;
  const candles = src.candles;

  const price = num(meta.regularMarketPrice) ?? candles[candles.length - 1].close;
  const nowKey = periodKey(Date.now(), intraday);

  // Daily change vs the most recent completed session's close.
  let prevClose = candles[candles.length - 2].close;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (periodKey(candles[i].t, intraday) < nowKey) {
      prevClose = candles[i].close;
      break;
    }
  }
  const change = price - prevClose;

  // Pivot basis: most recent completed period with a real range.
  const minRange = price * (intraday ? 0.0004 : 0.002);
  let basis = candles[candles.length - 2];
  for (let i = candles.length - 1; i >= 0; i--) {
    if (periodKey(candles[i].t, intraday) >= nowKey) continue;
    if (candles[i].high - candles[i].low < minRange) continue;
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

  const N = intraday ? 48 : 30;
  const series = candles.slice(-N).map((c) => round1(c.close));
  if (series.length > 0) series[series.length - 1] = round1(price);

  // Higher-timeframe bias from the daily EMAs.
  const dailyCloses = daily.candles.map((c) => c.close);
  const ema50 = ema(dailyCloses, 50);
  const ema200 = ema(dailyCloses, 200);
  const atr14 = atr(daily.candles, 14);
  let trend: Trend = "mixed";
  if (ema50 != null && ema200 != null) {
    if (price > ema50 && ema50 > ema200) trend = "bullish";
    else if (price < ema50 && ema50 < ema200) trend = "bearish";
  }

  return {
    timeframe,
    price: round1(price),
    change: round1(change),
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    dayHigh: meta.regularMarketDayHigh != null ? round1(Number(meta.regularMarketDayHigh)) : null,
    dayLow: meta.regularMarketDayLow != null ? round1(Number(meta.regularMarketDayLow)) : null,
    yearHigh: num(meta.fiftyTwoWeekHigh),
    yearLow: num(meta.fiftyTwoWeekLow),
    asOf: new Date(basis.t).toISOString(),
    levels,
    series,
    ema50: ema50 != null ? round1(ema50) : null,
    ema200: ema200 != null ? round1(ema200) : null,
    atr14: atr14 != null ? round1(atr14) : null,
    trend,
  };
}
