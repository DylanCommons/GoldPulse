import { NextResponse } from "next/server";
import { fetchQuotes } from "@/lib/price";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/price — live gold + dollar-index quotes. */
export async function GET() {
  const quotes = await fetchQuotes();
  return NextResponse.json({ updatedAt: new Date().toISOString(), quotes });
}
