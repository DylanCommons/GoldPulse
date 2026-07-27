import { NextResponse } from "next/server";
import { fetchAllNews } from "@/lib/rss";
import { generateBrief, hasKey } from "@/lib/claude";
import { fetchCalendar } from "@/lib/calendar";
import { store } from "@/lib/cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Allow up to 60s (Vercel Hobby max) — synthesising the brief is one longer call.
export const maxDuration = 60;

// Regenerate the brief at most this often unless ?refresh=1 is passed.
const BRIEF_TTL_MS = 30 * 60 * 1000;

/**
 * GET /api/brief[?refresh=1]
 * Returns the synthesized pre-session brief. Cached for BRIEF_TTL_MS so
 * opening the dashboard repeatedly doesn't regenerate (and re-bill) it.
 */
export async function GET(req: Request) {
  const configured = hasKey();
  if (!configured) {
    return NextResponse.json({ configured: false, brief: null });
  }

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const cached = store.brief;
  const fresh = cached && Date.now() - cached.at < BRIEF_TTL_MS;

  if (cached && fresh && !refresh) {
    return NextResponse.json({ configured: true, brief: cached.data });
  }

  const [news, events] = await Promise.all([fetchAllNews(60), fetchCalendar()]);
  const brief = await generateBrief(news, events);
  if (brief) {
    store.brief = { data: brief, at: Date.now() };
    return NextResponse.json({ configured: true, brief });
  }

  // Generation failed — fall back to the last good brief if we have one.
  return NextResponse.json({ configured: true, brief: cached?.data ?? null });
}
