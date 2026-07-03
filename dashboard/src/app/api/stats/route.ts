import { NextRequest, NextResponse } from "next/server";
import { getStatsDashboard } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get("days");
    let days: number | null = null;
    if (daysParam && daysParam.toLowerCase() === "all") {
      days = null;
    } else {
      const parsed = Number.parseInt(daysParam || "", 10);
      days = Number.isFinite(parsed) ? parsed : null;
    }
    const stats = await getStatsDashboard(days);
    return NextResponse.json({ stats });
  } catch (error) {
    console.error("GET /api/stats failed:", error);
    return NextResponse.json({ stats: null }, { status: 500 });
  }
}
