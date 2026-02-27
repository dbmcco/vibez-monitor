import { NextRequest, NextResponse } from "next/server";
import { getSpacesDashboard } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get("days");
    const selectedSpace = request.nextUrl.searchParams.get("space");
    let days: number | null = 30;
    if (daysParam && daysParam.toLowerCase() === "all") {
      days = null;
    } else {
      const parsed = Number.parseInt(daysParam || "30", 10);
      days = Number.isFinite(parsed) ? parsed : 30;
    }
    const spaces = getSpacesDashboard(days, selectedSpace);
    return NextResponse.json({ spaces });
  } catch {
    return NextResponse.json({ spaces: null }, { status: 500 });
  }
}
