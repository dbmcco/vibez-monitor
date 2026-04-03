// ABOUTME: Catchup API route — checks SQLite cache, runs meta-synthesis on miss.
// ABOUTME: GET ?start=YYYY-MM-DD&end=YYYY-MM-DD

import { NextRequest, NextResponse } from "next/server";
import {
  getCatchupCache,
  setCatchupCache,
  runCatchupSynthesis,
} from "@/lib/catchup";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const start = request.nextUrl.searchParams.get("start");
  const end = request.nextUrl.searchParams.get("end");

  if (!start || !end || !DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json(
      { error: "start and end are required in YYYY-MM-DD format" },
      { status: 400 }
    );
  }

  if (start > end) {
    return NextResponse.json(
      { error: "start must be on or before end" },
      { status: 400 }
    );
  }

  try {
    const cached = getCatchupCache(start, end);
    if (cached) {
      return NextResponse.json({ result: cached, cached: true });
    }

    const result = await runCatchupSynthesis(start, end);
    setCatchupCache(start, end, result);
    return NextResponse.json({ result, cached: false });
  } catch (error) {
    console.error("catchup api failed", error);
    return NextResponse.json(
      { error: "synthesis failed" },
      { status: 500 }
    );
  }
}
