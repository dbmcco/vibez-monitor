// ABOUTME: API route for links search and retrieval.
// ABOUTME: Supports FTS search via ?q= param, category/days/limit filtering.

import { NextRequest, NextResponse } from "next/server";
import { getLinks, searchLinksFts } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const q = params.get("q")?.trim() || "";
    const category = params.get("category") || undefined;
    const days = params.has("days") ? parseInt(params.get("days")!, 10) : 14;
    const limit = params.has("limit") ? parseInt(params.get("limit")!, 10) : 50;

    const opts = { category, days, limit };
    const links = q ? searchLinksFts(q, opts) : getLinks(opts);

    return NextResponse.json({ links, total: links.length });
  } catch (err) {
    console.error("Links API error:", err);
    return NextResponse.json({ links: [], total: 0, error: "Internal error" }, { status: 500 });
  }
}
