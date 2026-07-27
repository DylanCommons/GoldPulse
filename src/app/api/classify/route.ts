import { NextResponse } from "next/server";
import { classifyHeadlines, hasKey } from "@/lib/claude";
import { NewsItem } from "@/lib/types";

export const dynamic = "force-dynamic";
// Allow up to 60s (Vercel Hobby max) so a batch of headlines can finish.
export const maxDuration = 60;

/**
 * POST /api/classify  { items: [{ id, title, source, summary }] }
 * Returns bullish/bearish/neutral verdicts for the supplied headlines.
 * Stateless by design — the browser caches results, so this only ever runs on
 * headlines the client hasn't seen before.
 */
export async function POST(req: Request) {
  if (!hasKey()) return NextResponse.json({ classifications: [] });

  let items: NewsItem[] = [];
  try {
    const body = await req.json();
    items = Array.isArray(body?.items) ? body.items : [];
  } catch {
    return NextResponse.json({ classifications: [] });
  }
  if (items.length === 0) return NextResponse.json({ classifications: [] });

  const map = await classifyHeadlines(items.slice(0, 30));
  const classifications = Array.from(map.entries()).map(([id, c]) => ({ id, ...c }));
  return NextResponse.json({ classifications });
}
