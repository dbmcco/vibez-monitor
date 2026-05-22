// ABOUTME: API route for persistent counted link stars.
// ABOUTME: Supports bulk reads and per-client star/unstar writes.

import { NextRequest, NextResponse } from "next/server";
import { getLinkStars, setLinkStar } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const urls = params.getAll("url").map((url) => url.trim()).filter(Boolean);
    const clientId = params.get("client_id")?.trim() || undefined;
    const links = await getLinkStars({ urls, clientId });
    return NextResponse.json({ links });
  } catch (err) {
    console.error("Link stars API error:", err);
    return NextResponse.json({ links: {}, error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      url?: string;
      urls?: string[];
      clientId?: string;
      starred?: boolean;
    };
    const clientId = body.clientId?.trim() || undefined;

    if (Array.isArray(body.urls)) {
      const links = await getLinkStars({ urls: body.urls, clientId });
      return NextResponse.json({ links });
    }

    if (!body.url || !clientId || typeof body.starred !== "boolean") {
      return NextResponse.json({ error: "url, clientId, and starred are required" }, { status: 400 });
    }

    const state = await setLinkStar({ url: body.url, clientId, starred: body.starred });
    return NextResponse.json({ url: body.url, ...state });
  } catch (err) {
    console.error("Link stars API error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
