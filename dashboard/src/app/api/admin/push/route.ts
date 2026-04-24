import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

import {
  applyPgvectorPayload,
  applyPushPayload,
  getRecordCount,
  hasPushPayloadContent,
  type PushPayload,
} from "@/lib/push-ingest";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");
const MAX_RECORDS_PER_REQUEST = 1000;

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

  let payload: PushPayload;
  try {
    payload = (await request.json()) as PushPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!hasPushPayloadContent(payload)) {
    return NextResponse.json(
      { ok: false, error: "Payload must include at least one non-empty section." },
      { status: 400 },
    );
  }

  const recordCount = getRecordCount(payload);
  if (recordCount > MAX_RECORDS_PER_REQUEST) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many records (${recordCount}). Max is ${MAX_RECORDS_PER_REQUEST}.`,
      },
      { status: 413 },
    );
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    const sqliteResult = applyPushPayload(db, payload);
    const pgvectorResult = await applyPgvectorPayload(payload);
    return NextResponse.json({ ok: true, ...sqliteResult, ...pgvectorResult });
  } catch (error) {
    console.error("POST /api/admin/push failed", error);
    return NextResponse.json({ ok: false, error: "Failed to write payload." }, { status: 500 });
  } finally {
    db.close();
  }
}
