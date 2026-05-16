import { NextRequest, NextResponse } from "next/server";

import { generateAtlasDeeperDive } from "@/lib/atlas-deeper-dive";
import type { AtlasEditorialArticle } from "@/lib/atlas-report";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      article?: Partial<AtlasEditorialArticle>;
      hours?: number;
    };
    const article = body.article;
    if (!article || !article.title || !article.slug) {
      return NextResponse.json(
        { deeper_dive: null, error: "article title and slug are required" },
        { status: 400 },
      );
    }
    const deeperDive = await generateAtlasDeeperDive({
      article: article as AtlasEditorialArticle,
      hours: parseHours(body.hours),
    });
    return NextResponse.json({ deeper_dive: deeperDive, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "deeper dive unavailable";
    console.error("POST /api/atlas/deeper-dive failed:", error);
    return NextResponse.json(
      { deeper_dive: null, error: message },
      { status: 500 },
    );
  }
}

function parseHours(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw || "48"), 10);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(Math.max(parsed, 6), 168);
}
