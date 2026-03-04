import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");
const MAX_RECORDS_PER_REQUEST = 1000;

interface MessagePayload {
  id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number;
  raw_event?: string;
}

interface ClassificationPayload {
  relevance_score?: number;
  topics?: unknown;
  entities?: unknown;
  contribution_flag?: boolean;
  contribution_themes?: unknown;
  contribution_hint?: string;
  alert_level?: string;
}

interface RecordPayload {
  message: MessagePayload;
  classification?: ClassificationPayload | null;
}

interface PushPayload {
  records?: unknown;
  sync_state?: unknown;
}

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

function parseJsonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

function normalizeAlertLevel(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "hot" || value === "digest" || value === "none") return value;
  return "none";
}

function toIntScore(raw: unknown): number {
  const value = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 10) return 10;
  return value;
}

function isValidMessage(message: MessagePayload): boolean {
  return Boolean(
    message.id &&
      message.room_id &&
      message.room_name &&
      message.sender_id &&
      message.sender_name &&
      typeof message.body === "string" &&
      Number.isFinite(message.timestamp),
  );
}

function sanitizeSyncState(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== "object") return [];
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    let normalizedValue: string;
    if (typeof value === "string") {
      normalizedValue = value;
    } else {
      normalizedValue = JSON.stringify(value ?? null);
    }
    entries.push([normalizedKey, normalizedValue]);
  }
  return entries;
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

  const records = Array.isArray(payload.records) ? (payload.records as RecordPayload[]) : [];
  if (records.length === 0) {
    return NextResponse.json({ ok: false, error: "records is required." }, { status: 400 });
  }
  if (records.length > MAX_RECORDS_PER_REQUEST) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many records (${records.length}). Max is ${MAX_RECORDS_PER_REQUEST}.`,
      },
      { status: 413 },
    );
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO messages
     (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClassification = db.prepare(
    `INSERT OR REPLACE INTO classifications
     (message_id, relevance_score, topics, entities, contribution_flag, contribution_themes, contribution_hint, alert_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertSyncState = db.prepare(
    "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
  );

  let messagesWritten = 0;
  let classificationsWritten = 0;
  let syncStateWritten = 0;

  const transaction = db.transaction(() => {
    for (const record of records) {
      const message = record?.message as MessagePayload;
      if (!message || !isValidMessage(message)) {
        throw new Error("Invalid message record in payload.");
      }

      insertMessage.run(
        message.id.trim(),
        message.room_id.trim(),
        message.room_name.trim(),
        message.sender_id.trim(),
        message.sender_name.trim(),
        message.body,
        Math.trunc(Number(message.timestamp)),
        typeof message.raw_event === "string" ? message.raw_event : "{}",
      );
      messagesWritten += 1;

      const classification = record?.classification;
      if (classification && typeof classification === "object") {
        insertClassification.run(
          message.id.trim(),
          toIntScore(classification.relevance_score),
          JSON.stringify(parseJsonList(classification.topics)),
          JSON.stringify(parseJsonList(classification.entities)),
          classification.contribution_flag ? 1 : 0,
          JSON.stringify(parseJsonList(classification.contribution_themes)),
          String(classification.contribution_hint || ""),
          normalizeAlertLevel(classification.alert_level),
        );
        classificationsWritten += 1;
      }
    }

    const syncStateEntries = sanitizeSyncState(payload.sync_state);
    for (const [key, value] of syncStateEntries) {
      upsertSyncState.run(key, value);
      syncStateWritten += 1;
    }
  });

  try {
    transaction();
  } catch (error) {
    db.close();
    console.error("POST /api/admin/push failed", error);
    return NextResponse.json({ ok: false, error: "Failed to write payload." }, { status: 500 });
  }

  db.close();
  return NextResponse.json({
    ok: true,
    messages_written: messagesWritten,
    classifications_written: classificationsWritten,
    sync_state_written: syncStateWritten,
  });
}
