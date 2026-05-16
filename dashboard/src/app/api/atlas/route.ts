import { NextRequest, NextResponse } from "next/server";

import { getAtlasSnapshot } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const hours = parseWindowHours(request.nextUrl.searchParams.get("hours"));
    const atlas = await getAtlasSnapshot({ windowHours: hours });
    return NextResponse.json({ atlas });
  } catch (error) {
    console.error("GET /api/atlas failed:", error);
    return NextResponse.json({ atlas: null }, { status: 500 });
  }
}

function parseWindowHours(raw: string | null): number {
  const parsed = Number.parseInt(raw || "48", 10);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(Math.max(parsed, 6), 168);
}
