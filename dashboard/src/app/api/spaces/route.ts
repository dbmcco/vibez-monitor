import { NextRequest, NextResponse } from "next/server";
import { getSpacesDashboard } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const daysParam = request.nextUrl.searchParams.get("days");
    const selectedSpace = request.nextUrl.searchParams.get("space");
    const modeParam = request.nextUrl.searchParams.get("mode");
    const query = request.nextUrl.searchParams.get("q") || "";
    const minRelevanceParam = request.nextUrl.searchParams.get("min_relevance");
    const maxMessagesParam = request.nextUrl.searchParams.get("max_messages");
    const mode =
      modeParam === "focus" || modeParam === "balanced" || modeParam === "explore"
        ? modeParam
        : "focus";
    let days: number | null = 30;
    if (daysParam && daysParam.toLowerCase() === "all") {
      days = null;
    } else {
      const parsed = Number.parseInt(daysParam || "30", 10);
      days = Number.isFinite(parsed) ? parsed : 30;
    }
    const minRelevance = Number.parseInt(minRelevanceParam || "", 10);
    const maxMessages = Number.parseInt(maxMessagesParam || "", 10);
    const spaces = getSpacesDashboard(days, selectedSpace, {
      mode,
      query,
      minRelevance: Number.isFinite(minRelevance) ? minRelevance : undefined,
      maxMessages: Number.isFinite(maxMessages) ? maxMessages : undefined,
    });
    return NextResponse.json({ spaces });
  } catch {
    return NextResponse.json({ spaces: null }, { status: 500 });
  }
}
