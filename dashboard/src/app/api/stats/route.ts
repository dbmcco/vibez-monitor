import { NextRequest, NextResponse } from "next/server";
import { getStatsDashboard } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const days = Number.parseInt(request.nextUrl.searchParams.get("days") || "90", 10);
    const stats = getStatsDashboard(Number.isFinite(days) ? days : 90);
    return NextResponse.json({ stats });
  } catch {
    return NextResponse.json({ stats: null }, { status: 500 });
  }
}
