import { NextResponse } from "next/server";
import { fetchAllNews } from "@/lib/rss";
import { fetchQuotes } from "@/lib/price";
import { generatePulse, hasKey } from "@/lib/claude";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/** GET /api/pulse — one-line, teaching explanation of the dollar move + gold link. */
export async function GET() {
  if (!hasKey()) return NextResponse.json({ configured: false, pulse: null });
  const [news, quotes] = await Promise.all([fetchAllNews(40), fetchQuotes()]);
  const gold = quotes.find((q) => q.symbol === "GC=F");
  const dollar = quotes.find((q) => q.symbol === "DX-Y.NYB");
  if (!gold || !dollar) return NextResponse.json({ configured: true, pulse: null });
  const pulse = await generatePulse(news, gold.changePct, dollar.changePct);
  return NextResponse.json({ configured: true, pulse, updatedAt: new Date().toISOString() });
}
