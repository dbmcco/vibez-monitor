import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const refreshRailwayEnrichmentMock = vi.fn();

vi.mock("@/lib/admin-enrichment", () => ({
  refreshRailwayEnrichment: refreshRailwayEnrichmentMock,
}));

describe("POST /api/admin/enrich", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VIBEZ_PUSH_API_KEY", "push-secret");
    refreshRailwayEnrichmentMock.mockReset();
    refreshRailwayEnrichmentMock.mockResolvedValue({
      ok: true,
      classifications_written: 2,
      message_embeddings_written: 3,
      link_embeddings_written: 1,
      atlas: { rebuilt: true, articles: 3 },
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
});
