import { NextRequest, NextResponse } from "next/server";

import { listAtlasEditions } from "@/lib/atlas-artifact";
import { parseAtlasWindowHours } from "@/lib/atlas-ui";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const hours = parseAtlasWindowHours(request.nextUrl.searchParams.get("hours"));
    const rawLimit = Number.parseInt(request.nextUrl.searchParams.get("limit") || "14", 10);
    const editions = await listAtlasEditions({
      windowHours: hours,
      limit: Number.isFinite(rawLimit) ? rawLimit : 14,
    });
    return NextResponse.json({ editions });
  } catch (error) {
    console.error("GET /api/atlas/editions failed:", error);
    return NextResponse.json({ editions: [] }, { status: 500 });
  }
}
