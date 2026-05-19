import { NextRequest, NextResponse } from "next/server";

import { refreshRailwayEnrichment } from "@/lib/admin-enrichment";
import {
  editionTypeForWindow,
  getAtlasPublishJob,
  startAtlasPublishJob,
} from "@/lib/atlas-artifact";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

function clampAtlasHours(value: number | undefined): number {
  if (value === undefined) return 48;
  return Math.min(Math.max(Math.trunc(value), 6), 168);
}

function runAsyncEnrichment(options: Parameters<typeof refreshRailwayEnrichment>[0]): void {
  setTimeout(() => {
    void refreshRailwayEnrichment(options).catch((error) => {
      console.error("async /api/admin/enrich failed", error);
    });
  }, 0);
}

function workerOwnsAsyncJobs(): boolean {
  return process.env.VIBEZ_ENRICH_WORKER_ENABLED === "1";
}

export async function GET(request: NextRequest) {
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

  const jobId = request.nextUrl.searchParams.get("jobId")?.trim() || "";
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "jobId is required." }, { status: 400 });
  }

  const job = await getAtlasPublishJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job });
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

  const atlasHours = clampAtlasHours(readInt(body.atlasHours));
  const rebuildAtlas = body.rebuildAtlas === undefined ? undefined : body.rebuildAtlas !== false;
  const options = {
    classifyLimit: readInt(body.classifyLimit),
    messageEmbeddingLimit: readInt(body.messageEmbeddingLimit),
    linkEmbeddingLimit: readInt(body.linkEmbeddingLimit),
    rebuildAtlas,
    atlasHours,
    publishJobId: typeof body.publishJobId === "string" ? body.publishJobId : undefined,
    prestartedPublishJob: body.prestartedPublishJob === true,
  };

  try {
    if (body.async === true) {
      if (rebuildAtlas === false) {
        return NextResponse.json(
          { ok: false, error: "Async enrichment requires rebuildAtlas." },
          { status: 400 },
        );
      }
      const job = await startAtlasPublishJob({
        editionDate: new Date().toISOString().slice(0, 10),
        editionType: editionTypeForWindow(atlasHours),
        windowHours: atlasHours,
      });
      if (!job) {
        return NextResponse.json(
          { ok: false, error: "Postgres is not configured." },
          { status: 503 },
        );
      }
      if (!workerOwnsAsyncJobs()) {
        runAsyncEnrichment({
          ...options,
          publishJobId: job.id,
          prestartedPublishJob: true,
        });
      }
      return NextResponse.json({ ok: true, mode: "async", job });
    }

    const result = await refreshRailwayEnrichment(options);
    return NextResponse.json(result);
  } catch (error) {
    console.error("POST /api/admin/enrich failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to run enrichment." },
      { status: 500 },
    );
  }
}
