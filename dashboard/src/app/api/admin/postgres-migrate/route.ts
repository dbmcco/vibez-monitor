import { NextRequest, NextResponse } from "next/server";

import { backfillPostgresCoreFromEmbeddings } from "@/lib/push-ingest";

export const dynamic = "force-dynamic";

function getPushKeyFromRequest(request: NextRequest): string {
  const header = request.headers.get("x-vibez-push-key");
  if (header) return header.trim();
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

export async function POST(request: NextRequest) {
  const expectedPushKey = (process.env.VIBEZ_PUSH_API_KEY || "").trim();
  if (!expectedPushKey) {
    return NextResponse.json(
      { ok: false, error: "VIBEZ_PUSH_API_KEY is not configured." },
      { status: 503 },
    );
  }

  if (getPushKeyFromRequest(request) !== expectedPushKey) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await backfillPostgresCoreFromEmbeddings();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("POST /api/admin/postgres-migrate failed", error);
    return NextResponse.json(
      { ok: false, error: "Failed to migrate Postgres core tables." },
      { status: 500 },
    );
  }
}
