import { NextResponse } from "next/server";
import { fetchAllNews } from "@/lib/rss";
import { hasKey } from "@/lib/claude";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/**
 * GET /api/feed
 * Returns the latest gold-relevant news, newest-first. Classification is done
 * separately (POST /api/classify) so headlines appear instantly and the AI work
 * streams in — critical on serverless, where a slow all-in-one request would
 * time out and show nothing.
 */
export async function GET() {
  const news = await fetchAllNews(80);
  return NextResponse.json({
    configured: hasKey(),
    updatedAt: new Date().toISOString(),
    count: news.length,
    items: news,
  });
}
