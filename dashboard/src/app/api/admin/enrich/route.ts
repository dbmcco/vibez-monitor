import { NextRequest, NextResponse } from "next/server";

import { refreshRailwayEnrichment } from "@/lib/admin-enrichment";

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

function getExpectedPushKey(): string {
  return (process.env.VIBEZ_PUSH_API_KEY || "").trim();
}

function readInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function POST(request: NextRequest) {
  const expectedPushKey = getExpectedPushKey();
  if (!expectedPushKey) {
    return NextResponse.json(
      { ok: false, error: "VIBEZ_PUSH_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const providedPushKey = getPushKeyFromRequest(request);
  if (!providedPushKey || providedPushKey !== expectedPushKey) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const result = await refreshRailwayEnrichment({
      classifyLimit: readInt(body.classifyLimit),
      messageEmbeddingLimit: readInt(body.messageEmbeddingLimit),
      linkEmbeddingLimit: readInt(body.linkEmbeddingLimit),
      rebuildAtlas: body.rebuildAtlas === undefined ? undefined : body.rebuildAtlas !== false,
      atlasHours: readInt(body.atlasHours),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/admin/enrich failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to run enrichment." },
      { status: 500 },
    );
  }
}
