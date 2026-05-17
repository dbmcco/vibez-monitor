import { NextRequest, NextResponse } from "next/server";

import { generateAtlasEditorialReport } from "@/lib/atlas-report";
import { writeAtlasArtifact } from "@/lib/atlas-artifact";
import { getAtlasSnapshot } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (process.env.VIBEZ_ATLAS_ARTIFACT_WRITE !== "1") {
    return NextResponse.json(
      { ok: false, error: "atlas artifact writing is disabled" },
      { status: 403 },
    );
  }

  let hours = 48;
  try {
    const body = (await request.json()) as { hours?: number };
    hours = parseWindowHours(body.hours);
  } catch {
    hours = 48;
  }

  const atlas = await getAtlasSnapshot({ windowHours: hours });
  const editorialReport = await generateAtlasEditorialReport(atlas);
  const artifactPath = writeAtlasArtifact({
    windowHours: hours,
    atlas,
    editorialReport,
  });

  return NextResponse.json({
    ok: true,
    artifact_path: artifactPath,
    articles: editorialReport.articles.length,
    sections: editorialReport.articles.map((article) => article.section),
  });
}

function parseWindowHours(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw || "48"), 10);
  if (!Number.isFinite(parsed)) return 48;
  return Math.min(Math.max(parsed, 6), 168);
}
