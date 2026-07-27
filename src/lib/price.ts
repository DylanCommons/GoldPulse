import { Quote } from "./types";

/** Symbols that frame the gold trade: spot-ish gold future and the dollar index. */
const SYMBOLS: { symbol: string; name: string }[] = [
  { symbol: "GC=F", name: "Gold" },
  { symbol: "DX-Y.NYB", name: "US Dollar (DXY)" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchQuote(symbol: string, name: string): Promise<Quote | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (GoldPulse; price reader)" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = num(meta.regularMarketPrice);
    const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);
    if (price == null || prev == null) return null;
    const change = price - prev;
    return {
      symbol,
      name,
      price,
      change,
      changePct: prev !== 0 ? (change / prev) * 100 : 0,
      dayHigh: num(meta.regularMarketDayHigh),
      dayLow: num(meta.regularMarketDayLow),
      currency: String(meta.currency ?? "USD"),
    };
  } catch {
    return null;
  }
}

export async function fetchQuotes(): Promise<Quote[]> {
  const quotes = await Promise.all(SYMBOLS.map((s) => fetchQuote(s.symbol, s.name)));
  return quotes.filter((q): q is Quote => q !== null);
}
