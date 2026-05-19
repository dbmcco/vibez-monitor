import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const refreshRailwayEnrichmentMock = vi.fn();
const startAtlasPublishJobMock = vi.fn();
const getAtlasPublishJobMock = vi.fn();

vi.mock("@/lib/admin-enrichment", () => ({
  refreshRailwayEnrichment: refreshRailwayEnrichmentMock,
}));

vi.mock("@/lib/atlas-artifact", () => ({
  editionTypeForWindow: (hours: number) => (hours >= 168 ? "sunday_review" : "daily"),
  getAtlasPublishJob: getAtlasPublishJobMock,
  startAtlasPublishJob: startAtlasPublishJobMock,
}));

describe("POST /api/admin/enrich", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VIBEZ_PUSH_API_KEY", "push-secret");
    refreshRailwayEnrichmentMock.mockReset();
    startAtlasPublishJobMock.mockReset();
    getAtlasPublishJobMock.mockReset();
    refreshRailwayEnrichmentMock.mockResolvedValue({
      ok: true,
      classifications_written: 2,
      message_embeddings_written: 3,
      link_embeddings_written: 1,
      atlas: { rebuilt: true, articles: 3 },
    });
    startAtlasPublishJobMock.mockResolvedValue({
      id: "atlas-job-1",
      edition_date: "2026-05-19",
      edition_type: "daily",
      window_hours: 48,
      status: "running",
    });
  });

  test("rejects requests without the push key", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/admin/enrich", {
      method: "POST",
      body: JSON.stringify({ classifyLimit: 2 }),
    }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: "Unauthorized." });
    expect(refreshRailwayEnrichmentMock).not.toHaveBeenCalled();
  });

  test("runs Railway enrichment with explicit limits and atlas rebuild", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/admin/enrich", {
      method: "POST",
      headers: { "x-vibez-push-key": "push-secret" },
      body: JSON.stringify({
        classifyLimit: 2,
        messageEmbeddingLimit: 3,
        linkEmbeddingLimit: 1,
        rebuildAtlas: true,
        atlasHours: 72,
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(refreshRailwayEnrichmentMock).toHaveBeenCalledWith({
      classifyLimit: 2,
      messageEmbeddingLimit: 3,
      linkEmbeddingLimit: 1,
      rebuildAtlas: true,
      atlasHours: 72,
    });
    expect(body).toEqual({
      ok: true,
      classifications_written: 2,
      message_embeddings_written: 3,
      link_embeddings_written: 1,
      atlas: { rebuilt: true, articles: 3 },
    });
  });

  test("starts async Atlas enrichment and returns a durable job id", async () => {
    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/admin/enrich", {
      method: "POST",
      headers: { "x-vibez-push-key": "push-secret" },
      body: JSON.stringify({
        async: true,
        classifyLimit: 0,
        messageEmbeddingLimit: 0,
        linkEmbeddingLimit: 0,
        atlasHours: 48,
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(startAtlasPublishJobMock).toHaveBeenCalledWith({
      editionDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      editionType: "daily",
      windowHours: 48,
    });
    expect(body).toEqual({
      ok: true,
      mode: "async",
      job: {
        id: "atlas-job-1",
        edition_date: "2026-05-19",
        edition_type: "daily",
        window_hours: 48,
        status: "running",
      },
    });
    await vi.waitFor(() => {
      expect(refreshRailwayEnrichmentMock).toHaveBeenCalledWith({
        classifyLimit: 0,
        messageEmbeddingLimit: 0,
        linkEmbeddingLimit: 0,
        rebuildAtlas: undefined,
        atlasHours: 48,
        publishJobId: "atlas-job-1",
        prestartedPublishJob: true,
      });
    });
  });

  test("returns async job status", async () => {
    getAtlasPublishJobMock.mockResolvedValue({
      id: "atlas-job-1",
      edition_date: "2026-05-19",
      edition_type: "daily",
      window_hours: 48,
      status: "succeeded",
      stage_status: { publish: "succeeded" },
      stage_errors: {},
    });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://test.local/api/admin/enrich?jobId=atlas-job-1", {
      method: "GET",
      headers: { "x-vibez-push-key": "push-secret" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      job: {
        id: "atlas-job-1",
        edition_date: "2026-05-19",
        edition_type: "daily",
        window_hours: 48,
        status: "succeeded",
        stage_status: { publish: "succeeded" },
        stage_errors: {},
      },
    });
  });
});
