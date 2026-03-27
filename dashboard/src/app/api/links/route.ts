// ABOUTME: API route for links search, browse, and retrieval.
// ABOUTME: Supports FTS search, source/sharer/category filtering, sort, and stats.

import { NextRequest, NextResponse } from "next/server";
import { getLinks, searchLinksFts, getLinkStats } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    // Stats-only request
    if (params.get("stats") === "1") {
      const days = params.has("days") ? parseInt(params.get("days")!, 10) : undefined;
      const stats = getLinkStats({ days });
      return NextResponse.json(stats);
    }

    const q = params.get("q")?.trim() || "";
    const category = params.get("category") || undefined;
    const days = params.has("days") ? parseInt(params.get("days")!, 10) : undefined;
    const limit = params.has("limit") ? parseInt(params.get("limit")!, 10) : 50;
    const sort = params.get("sort") || "value";
    const source = params.get("source") || undefined;
    const sharedBy = params.get("shared_by") || undefined;
    const authoredBy = params.get("authored_by") || undefined;
    const pinned = params.get("pinned") === "1" ? true : undefined;

    const opts = { category, days, limit, sort, source, sharedBy, authoredBy, pinned };
    const links = q ? searchLinksFts(q, opts) : getLinks(opts);

    return NextResponse.json({ links, total: links.length });
  } catch (err) {
    console.error("Links API error:", err);
    return NextResponse.json({ links: [], total: 0, error: "Internal error" }, { status: 500 });
  }
}
