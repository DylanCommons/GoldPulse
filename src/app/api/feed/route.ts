import { NextResponse } from "next/server";
import { fetchAllNews } from "@/lib/rss";
import { classifyHeadlines, hasKey } from "@/lib/claude";
import { store } from "@/lib/cache";
import { ClassifiedItem } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/feed
 * Fetches the latest gold-relevant news, classifies any headlines we haven't
 * seen before (cached ones are reused so we don't burn tokens on every poll),
 * and returns the merged, newest-first feed.
 */
export async function GET() {
  const news = await fetchAllNews(80);

  const configured = hasKey();
  if (configured) {
    const unseen = news.filter((n) => !store.classifications.has(n.id));
    if (unseen.length > 0) {
      const fresh = await classifyHeadlines(unseen);
      for (const [id, c] of fresh) store.classifications.set(id, c);
    }
  }

  const items: ClassifiedItem[] = news.map((n) => ({
    ...n,
    classification: store.classifications.get(n.id),
  }));

  return NextResponse.json({
    configured,
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  });
}
