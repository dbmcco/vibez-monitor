import { NextResponse } from "next/server";
import { getApiUsageSummary } from "@/lib/api-usage";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = getApiUsageSummary();
    return NextResponse.json(summary);
  } catch (error) {
    console.error("GET /api/usage failed:", error);
    return NextResponse.json(
      {
        generated_at: new Date().toISOString(),
        error: "Failed to load usage summary.",
      },
      { status: 500 },
    );
  }
}
