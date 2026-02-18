import { NextRequest, NextResponse } from "next/server";
import { getValueConfig } from "@/lib/db";
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

export async function GET() {
  try {
    const config = getValueConfig();
    return NextResponse.json({ config });
  } catch {
    return NextResponse.json({ config: {} });
  }
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const db = new Database(DB_PATH);
  for (const [key, value] of Object.entries(body)) {
    db.prepare("INSERT OR REPLACE INTO value_config (key, value) VALUES (?, ?)").run(
      key, JSON.stringify(value)
    );
  }
  db.close();
  return NextResponse.json({ ok: true });
}
