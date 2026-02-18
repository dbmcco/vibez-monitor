import { NextRequest, NextResponse } from "next/server";
import { getLatestReport, getReport } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date");
    const report = date ? getReport(date) : getLatestReport();
    return NextResponse.json({ report });
  } catch {
    return NextResponse.json({ report: null });
  }
}
