import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const getAtlasSnapshotMock = vi.fn();
const generateAtlasEditorialReportMock = vi.fn();
const attachGeneratedArticleImagesMock = vi.fn();
const writeAtlasArtifactMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getAtlasSnapshot: getAtlasSnapshotMock,
}));

vi.mock("@/lib/atlas-report", () => ({
  generateAtlasEditorialReport: generateAtlasEditorialReportMock,
}));

vi.mock("@/lib/atlas-image-generation", () => ({
  attachGeneratedArticleImages: attachGeneratedArticleImagesMock,
}));

vi.mock("@/lib/atlas-artifact", () => ({
  writeAtlasArtifact: writeAtlasArtifactMock,
}));

describe("POST /api/admin/atlas-artifact", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VIBEZ_ATLAS_ARTIFACT_WRITE", "1");
    getAtlasSnapshotMock.mockReset();
    generateAtlasEditorialReportMock.mockReset();
    attachGeneratedArticleImagesMock.mockReset();
    writeAtlasArtifactMock.mockReset();
    generateAtlasEditorialReportMock.mockResolvedValue({
      articles: [
        { section: "Agent Harnesses" },
        { section: "Personal Workflows" },
        { section: "Durable Records" },
      ],
    });
    attachGeneratedArticleImagesMock.mockImplementation(async ({ report }) => ({
      ...report,
      articles: report.articles.map((article: { section: string }) => ({
        ...article,
        image: { kind: "generated", status: "ready", url: "/api/atlas/image/test.png" },
      })),
    }));
    writeAtlasArtifactMock.mockReturnValue("/tmp/atlas-48.json");
  });

  test("uses a supplied atlas snapshot instead of requiring the local database", async () => {
    const suppliedAtlas = {
      window: { start: "2026-05-15T00:00:00Z", end: "2026-05-17T00:00:00Z", hours: 48 },
      overview: { messages: 1, people: 1, channels: 1, topics: 1, links: 0 },
      channels: [],
      topics: [],
      matrix: [],
      concerns: [],
      links: [],
      citations: {},
      people: { window_days: 7, generated_at: "2026-05-17T00:00:00Z", new_faces: [], top_contributors: [] },
      narrative: {
        title: "Latest 48h Report",
        summary: "Summary",
        report: {
          headline: "Headline",
          kicker: "Kicker",
          lead: "Lead",
          what_matters: [],
          what_to_watch: [],
          evidence_refs: [],
        },
        paragraphs: [],
        main_topic: { title: "Main", topic: null, paragraphs: [], citation_refs: [] },
        week_in_review: { title: "Week", bullets: [] },
      },
    };

    const { POST } = await import("./route");
    const response = await POST(new NextRequest("http://test.local/api/admin/atlas-artifact", {
      method: "POST",
      body: JSON.stringify({ hours: 48, atlas: suppliedAtlas }),
    }));
    const body = await response.json();

    expect(getAtlasSnapshotMock).not.toHaveBeenCalled();
    expect(generateAtlasEditorialReportMock).toHaveBeenCalledWith(suppliedAtlas);
    expect(attachGeneratedArticleImagesMock).toHaveBeenCalledWith({
      report: expect.objectContaining({ articles: expect.any(Array) }),
      windowHours: 48,
    });
    expect(writeAtlasArtifactMock).toHaveBeenCalledWith({
      windowHours: 48,
      atlas: suppliedAtlas,
      editorialReport: expect.objectContaining({ articles: expect.any(Array) }),
    });
    expect(body).toEqual({
      ok: true,
      artifact_path: "/tmp/atlas-48.json",
      articles: 3,
      sections: ["Agent Harnesses", "Personal Workflows", "Durable Records"],
    });
  });
});
