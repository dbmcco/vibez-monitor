import { NextRequest, NextResponse } from "next/server";
import {
  getLatestReport,
  getPreviousReport,
  getRecentUpdateSnapshot,
  getReport,
  getVibezRadarSnapshot,
} from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date");
    const report = date ? getReport(date) : getLatestReport();
    const previous_report = report ? getPreviousReport(report.report_date) : null;
    const recent_update = getRecentUpdateSnapshot();
    const radar = await getVibezRadarSnapshot(report, 48);
    return NextResponse.json({ report, previous_report, recent_update, radar });
  } catch {
    return NextResponse.json({
      report: null,
      previous_report: null,
      recent_update: null,
      radar: null,
    });
  }
}
