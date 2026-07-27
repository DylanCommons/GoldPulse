import { NextResponse } from "next/server";
import { bucketEvents, fetchCalendar } from "@/lib/calendar";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/calendar — gold-relevant economic events for the week, bucketed. */
export async function GET() {
  const events = await fetchCalendar();
  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    ...bucketEvents(events),
  });
}
