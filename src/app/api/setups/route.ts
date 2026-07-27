import { NextResponse } from "next/server";
import { fetchIccSetups } from "@/lib/icc";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/** GET /api/setups — ICC continuation trade plans from 15m swing structure. */
export async function GET() {
  const setups = await fetchIccSetups();
  return NextResponse.json({ updatedAt: new Date().toISOString(), setups });
}
