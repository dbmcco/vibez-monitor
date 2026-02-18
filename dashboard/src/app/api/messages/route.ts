import { NextRequest, NextResponse } from "next/server";
import { getMessages, getRooms } from "@/lib/db";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const limit = parseInt(params.get("limit") || "50");
  const offset = parseInt(params.get("offset") || "0");
  const room = params.get("room") || undefined;
  const minRelevance = params.get("minRelevance")
    ? parseInt(params.get("minRelevance")!)
    : undefined;
  const contributionOnly = params.get("contributionOnly") === "true";

  try {
    const messages = getMessages({ limit, offset, room, minRelevance, contributionOnly });
    const rooms = getRooms();
    return NextResponse.json({ messages, rooms });
  } catch {
    return NextResponse.json({ messages: [], rooms: [] });
  }
}
