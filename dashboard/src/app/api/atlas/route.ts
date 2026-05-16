import { NextRequest, NextResponse } from "next/server";

import { generateAtlasEditorialReport } from "@/lib/atlas-report";
import { getAtlasSnapshot } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const hours = parseWindowHours(request.nextUrl.searchParams.get("hours"));
    const atlas = await getAtlasSnapshot({ windowHours: hours });
    try {
      const editorialReport = await generateAtlasEditorialReport(atlas);
      return NextResponse.json({
        atlas,
        editorial_report: editorialReport,
        editorial_error: null,
      });
    } catch (reportError) {
      const message = reportError instanceof Error
        ? reportError.message
        : "atlas editorial report unavailable";
      console.error("GET /api/atlas report failed:", reportError);
      return NextResponse.json({
        atlas,
        editorial_report: null,
        editorial_error: message,
      });
    }
  } catch (error) {
    console.error("GET /api/atlas failed:", error);
    return NextResponse.json(
      { atlas: null, editorial_report: null, editorial_error: "atlas data unavailable" },
      { status: 500 },
    );
  }
}

function parseWindowHours(raw: string | null): number {
  const parsed = Number.parseInt(raw || "48", 10);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(Math.max(parsed, 6), 168);
}
