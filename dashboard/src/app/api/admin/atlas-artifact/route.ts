import { NextRequest, NextResponse } from "next/server";

import { generateAtlasEditorialReport } from "@/lib/atlas-report";
import { attachGeneratedArticleImages } from "@/lib/atlas-image-generation";
import { writeAtlasArtifact } from "@/lib/atlas-artifact";
import type { AtlasSnapshot } from "@/lib/atlas";
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
  let suppliedAtlas: AtlasSnapshot | null = null;
  try {
    const body = (await request.json()) as { hours?: number; atlas?: unknown };
    hours = parseWindowHours(body.hours);
    suppliedAtlas = readSuppliedAtlas(body.atlas);
  } catch {
    hours = 48;
  }

  const atlas = suppliedAtlas || await getAtlasSnapshot({ windowHours: hours });
  const editorialReport = await attachGeneratedArticleImages({
    report: await generateAtlasEditorialReport(atlas),
    windowHours: hours,
  });
  const artifactPath = await writeAtlasArtifact({
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

function readSuppliedAtlas(value: unknown): AtlasSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<AtlasSnapshot>;
  if (
    !payload.window ||
    !payload.overview ||
    !Array.isArray(payload.channels) ||
    !Array.isArray(payload.topics) ||
    !Array.isArray(payload.matrix) ||
    !Array.isArray(payload.links) ||
    !payload.citations ||
    typeof payload.citations !== "object" ||
    !payload.narrative
  ) {
    return null;
  }
  return payload as AtlasSnapshot;
}
