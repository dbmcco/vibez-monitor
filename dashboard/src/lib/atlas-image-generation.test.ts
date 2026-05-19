import { describe, expect, test, vi } from "vitest";

import type { AtlasEditorialReport } from "./atlas-report";

const upsertAtlasAssetMock = vi.fn();

vi.mock("./atlas-artifact", () => ({
  editionTypeForWindow: (windowHours: number) => windowHours >= 120 ? "sunday_review" : "daily",
  upsertAtlasAsset: upsertAtlasAssetMock,
}));

function sampleReport(): AtlasEditorialReport {
  return {
    issue: {
      date: "2026-05-19",
      title: "The Vibez Atlas",
      subtitle: "A test issue.",
      edition_label: "Daily Edition",
    },
    headline: "The agents moved from demos to operations",
    dek: "Evaluation became the work.",
    what_happened: [],
    what_it_means: [],
    why_care: [],
    valuable: [],
    actions: [],
    main_topic: {
      title: "Agent operations",
      paragraphs: [],
      evidence_refs: [],
    },
    articles: [
      {
        role: "lead",
        section: "Agent Architecture",
        title: "Skill Bloat Is Now a Design Problem",
        slug: "skill-bloat",
        dek: "The tool list became part of the work.",
        summary: "The group argued that tool count has become an evaluation problem.",
        body: [
          "A practitioner called out skill bloat as a real source of reasoning overhead.",
          "The thread tied this to evaluations and operational load.",
        ],
        actions: ["Audit tool count before adding more."],
        evidence_refs: ["vibez:message:m1"],
        link_refs: [],
        channels: ["Personal Agents"],
        image: {
          kind: "generated",
          prompt: "NYTimes-style documentary photo of a crowded toolbench for AI agents",
          alt: "A crowded toolbench as a metaphor for agent skills",
        },
        related_article_slugs: [],
      },
    ],
    briefs: [],
    crosscurrents: [],
    themes: [],
    evidence: [],
    generated_at: "2026-05-19T10:00:00Z",
  };
}

describe("Atlas article image generation", () => {
  test("stores generated article image bytes and attaches a durable URL", async () => {
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });
    const runner = vi.fn().mockResolvedValue({
      data: Buffer.from("fake-png"),
      contentType: "image/png",
      provider: "test-runner",
      model: "test-model",
    });

    const { attachGeneratedArticleImages } = await import("./atlas-image-generation");
    const report = await attachGeneratedArticleImages({
      report: sampleReport(),
      windowHours: 48,
      publishJobId: "job-1",
    }, runner);

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("crowded toolbench"),
      articleTitle: "Skill Bloat Is Now a Design Problem",
    }));
    expect(upsertAtlasAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetKey: "2026-05-19/daily/skill-bloat.png",
      status: "ready",
      assetBytes: Buffer.from("fake-png"),
      contentType: "image/png",
    }));
    expect(report.articles[0].image).toMatchObject({
      status: "ready",
      url: "/api/atlas/image/2026-05-19/daily/skill-bloat.png",
    });
  });

  test("records pending image state when no generator command is configured", async () => {
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });

    const { attachGeneratedArticleImages } = await import("./atlas-image-generation");
    const report = await attachGeneratedArticleImages({
      report: sampleReport(),
      windowHours: 48,
      publishJobId: "job-1",
    });

    expect(upsertAtlasAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetKey: "2026-05-19/daily/skill-bloat.png",
      status: "pending",
      assetBytes: null,
    }));
    expect(report.articles[0].image).toMatchObject({
      status: "pending",
    });
    expect(report.articles[0].image.url).toBeUndefined();
  });

  test("records failed image state without throwing when generation fails", async () => {
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });
    const runner = vi.fn().mockRejectedValue(new Error("image provider timed out"));

    const { attachGeneratedArticleImages } = await import("./atlas-image-generation");
    const report = await attachGeneratedArticleImages({
      report: sampleReport(),
      windowHours: 48,
      publishJobId: "job-1",
    }, runner);

    expect(upsertAtlasAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetKey: "2026-05-19/daily/skill-bloat.png",
      status: "failed",
      error: "image provider timed out",
    }));
    expect(report.articles[0].image).toMatchObject({
      status: "failed",
      error: "image provider timed out",
    });
    expect(report.articles[0].image.url).toBeUndefined();
  });
});
