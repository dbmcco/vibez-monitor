import { NextResponse } from "next/server";
import { getMessages } from "@/lib/db";

export async function GET() {
  try {
    const messages = getMessages({ contributionOnly: true, limit: 100 });
    return NextResponse.json({ contributions: messages });
  } catch {
    return NextResponse.json({ contributions: [] });
  }
}
