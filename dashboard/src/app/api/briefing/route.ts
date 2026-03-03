import { NextRequest, NextResponse } from "next/server";
import {
  getCurrentRoomScope,
  getLatestReport,
  getPreviousReport,
  getRecentUpdateSnapshot,
  getReport,
  getVibezRadarSnapshot,
} from "@/lib/db";
import { isPublicMode } from "@/lib/runtime";
import { computeSemanticAnalytics } from "@/lib/semantic";

function sanitizeReportContributions<T extends { contributions: string | null } | null>(
  report: T,
): T {
  if (!report) return report;
  return {
    ...report,
    contributions: null,
  } as T;
}

export async function GET(request: NextRequest) {
  try {
    const publicMode = isPublicMode();
    const date = request.nextUrl.searchParams.get("date");
    const report = date ? getReport(date) : getLatestReport();
    const previous_report = report ? getPreviousReport(report.report_date) : null;
    const recent_update = getRecentUpdateSnapshot();
    const radar = await getVibezRadarSnapshot(report, 48);
    const semantic_briefing =
      !date || date.length === 0
        ? await computeSemanticAnalytics({
            roomScope: getCurrentRoomScope(),
            cutoffTs: Date.now() - 14 * 24 * 60 * 60 * 1000,
            lookbackDays: 14,
            maxClusters: 8,
          })
        : null;
    return NextResponse.json({
      report: publicMode ? sanitizeReportContributions(report) : report,
      previous_report: publicMode
        ? sanitizeReportContributions(previous_report)
        : previous_report,
      recent_update,
      radar,
      semantic_briefing,
    });
  } catch {
    return NextResponse.json({
      report: null,
      previous_report: null,
      recent_update: null,
      radar: null,
      semantic_briefing: null,
    });
  }
}
