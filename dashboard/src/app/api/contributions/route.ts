import { NextRequest, NextResponse } from "next/server";
import { getContributionDashboard } from "@/lib/db";

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const days = parsePositiveInt(request.nextUrl.searchParams.get("days"), 45);
    const limit = parsePositiveInt(request.nextUrl.searchParams.get("limit"), 600);
    const dashboard = getContributionDashboard({ lookbackDays: days, limit });
    return NextResponse.json({
      ...dashboard,
      contributions: dashboard.opportunities,
    });
  } catch {
    return NextResponse.json({
      generated_at: new Date().toISOString(),
      lookback_days: 45,
      totals: { messages: 0, opportunities: 0, act_now: 0, high_leverage: 0, aging_risk: 0, blocked: 0 },
      axis_summary: [],
      need_summary: [],
      recurring_themes: [],
      opportunities: [],
      sections: [],
      contributions: [],
    });
  }
}
