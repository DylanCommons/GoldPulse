import { NextResponse } from "next/server";
import { fetchIccSetups } from "@/lib/icc";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/** GET /api/setups — ICC state + continuation trade plans from 15m structure. */
export async function GET() {
  const { setups, state } = await fetchIccSetups();
  return NextResponse.json({ updatedAt: new Date().toISOString(), setups, state });
}
