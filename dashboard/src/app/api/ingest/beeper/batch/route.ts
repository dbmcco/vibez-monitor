import { NextRequest, NextResponse } from "next/server";

import { applyBeeperBatchPayload, type BeeperBatchPayload } from "@/lib/push-ingest";

export const dynamic = "force-dynamic";

function getCaptureKeyFromRequest(request: NextRequest): string {
  const header = request.headers.get("x-vibez-capture-key");
  if (header) return header.trim();
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function getExpectedCaptureKey(): string {
  return (process.env.VIBEZ_CAPTURE_API_KEY || "").trim();
}

export async function POST(request: NextRequest) {
  const expectedCaptureKey = getExpectedCaptureKey();
  if (!expectedCaptureKey) {
    return NextResponse.json(
      { ok: false, error: "VIBEZ_CAPTURE_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const providedCaptureKey = getCaptureKeyFromRequest(request);
  if (!providedCaptureKey || providedCaptureKey !== expectedCaptureKey) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let payload: BeeperBatchPayload;
  try {
    payload = (await request.json()) as BeeperBatchPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    const result = await applyBeeperBatchPayload({
      source: "beeper",
      ...payload,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/ingest/beeper/batch failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to ingest batch." },
      { status: 500 },
    );
  }
}
