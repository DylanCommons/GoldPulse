import { NextResponse } from "next/server";
import { fetchGoldLevels } from "@/lib/levels";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/levels — current gold price + computed pivot support/resistance. */
export async function GET() {
  const levels = await fetchGoldLevels();
  return NextResponse.json({ updatedAt: new Date().toISOString(), levels });
}
