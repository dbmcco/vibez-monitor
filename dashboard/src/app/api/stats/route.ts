import { NextRequest, NextResponse } from "next/server";
import { getStatsDashboard } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get("days");
    let days: number | null = 90;
    if (daysParam && daysParam.toLowerCase() === "all") {
      days = null;
    } else {
      const parsed = Number.parseInt(daysParam || "90", 10);
      days = Number.isFinite(parsed) ? parsed : 90;
    }
    const stats = getStatsDashboard(days);
    return NextResponse.json({ stats });
  } catch {
    return NextResponse.json({ stats: null }, { status: 500 });
  }
}
