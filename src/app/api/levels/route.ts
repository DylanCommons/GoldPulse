import { NextResponse } from "next/server";
import { fetchGoldLevels } from "@/lib/levels";
import { LevelTimeframe } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/levels[?tf=daily|intraday] — gold price, pivot levels, price series. */
export async function GET(req: Request) {
  const tf = new URL(req.url).searchParams.get("tf");
  const timeframe: LevelTimeframe = tf === "intraday" ? "intraday" : "daily";
  const levels = await fetchGoldLevels(timeframe);
  return NextResponse.json({ updatedAt: new Date().toISOString(), levels });
}
