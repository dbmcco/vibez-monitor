import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AtlasEditorialReport } from "./atlas-report";

const upsertAtlasAssetMock = vi.fn();
const writeAtlasGeneratedAssetMock = vi.fn();
const generateImageMock = vi.fn();
const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR42mP8z8DwnwEJMDIwMDAwAgA0xgQEVS4tWQAAAABJRU5ErkJggg==",
  "base64",
);

vi.mock("./atlas-artifact", () => ({
  editionTypeForWindow: (windowHours: number) => windowHours >= 120 ? "sunday_review" : "daily",
  upsertAtlasAsset: upsertAtlasAssetMock,
  writeAtlasGeneratedAsset: writeAtlasGeneratedAssetMock,
}));

vi.mock("./model-router", () => ({
  generateImage: generateImageMock,
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
          prompt: "NYTimes-style documentary photo of a crowded toolbench with a GitHub octocat sticker for AI agents",
          alt: "A crowded toolbench as a metaphor for agent skills",
        },
        related_article_slugs: [],
      },
    ],
    briefs: [],
    crosscurrents: [],
    channel_reports: [],
    themes: [],
    evidence: [],
    generated_at: "2026-05-19T10:00:00Z",
  };
}

describe("Atlas article image generation", () => {
  beforeEach(() => {
    upsertAtlasAssetMock.mockReset();
    writeAtlasGeneratedAssetMock.mockReset();
    generateImageMock.mockReset();
  });

  test("stores generated article image bytes and attaches a durable URL", async () => {
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });
    writeAtlasGeneratedAssetMock.mockReturnValue("/tmp/skill-bloat.png");
    const runner = vi.fn().mockResolvedValue({
      data: TEST_PNG,
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
    const prompt = runner.mock.calls[0][0].prompt;
    const atlasCloudVisiblePrompt = prompt.slice(0, 800);
    expect(atlasCloudVisiblePrompt).toContain("Title: Skill Bloat Is Now a Design Problem");
    expect(atlasCloudVisiblePrompt).toContain("Dek: The tool list became part of the work.");
    expect(atlasCloudVisiblePrompt).toContain("Hard bans: no readable text, logos, brand marks, stickers");
    expect(atlasCloudVisiblePrompt).toContain("crowded toolbench");
    expect(atlasCloudVisiblePrompt).toContain("unlabeled code-hosting service");
    expect(atlasCloudVisiblePrompt).toContain("plain peeled patch");
    expect(atlasCloudVisiblePrompt).not.toContain("GitHub");
    expect(atlasCloudVisiblePrompt).not.toContain("octocat");
    expect(atlasCloudVisiblePrompt).toContain("reasoning overhead");
    expect(prompt).toContain("Use ONLY this article");
    expect(prompt).not.toContain("Additional article context");
    expect(prompt).toContain("New York Times-style");
    expect(prompt).toContain("single photorealistic documentary editorial photograph");
    expect(prompt).toContain("snarky nerd humor");
    expect(prompt).toContain("Do not make a generic tech or business stock photo");
    expect(prompt).toContain("No readable text");
    expect(prompt).toContain("No stickers, icons, emoji, doodles, mascots, or symbols");
    expect(upsertAtlasAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetKey: expect.stringMatching(/^2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
      status: "ready",
      assetBytes: expect.any(Buffer),
      contentType: "image/webp",
    }));
    const readyAsset = upsertAtlasAssetMock.mock.calls.find((call) => call[0].status === "ready")?.[0];
    expect(readyAsset.assetBytes.length).toBeLessThan(350_000);
    expect(writeAtlasGeneratedAssetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
      expect.any(Buffer),
    );
    expect(report.articles[0].image).toMatchObject({
      status: "ready",
      url: expect.stringMatching(/^\/api\/atlas\/image\/2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
    });
  });

  test("uses the routed model image generator when no command is configured", async () => {
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });
    writeAtlasGeneratedAssetMock.mockReturnValue("/tmp/skill-bloat.png");
    generateImageMock.mockResolvedValue({
      data: TEST_PNG,
      contentType: "image/png",
      provider: "openai",
      model: "gpt-image-1",
    });

    const { attachGeneratedArticleImages } = await import("./atlas-image-generation");
    const report = await attachGeneratedArticleImages({
      report: sampleReport(),
      windowHours: 48,
      publishJobId: "job-1",
    });

    expect(generateImageMock).toHaveBeenCalledWith({
      taskId: "image.article",
      prompt: expect.stringContaining("crowded toolbench"),
    });
    expect(upsertAtlasAssetMock).toHaveBeenCalledWith(expect.objectContaining({
      assetKey: expect.stringMatching(/^2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
      status: "ready",
      assetBytes: expect.any(Buffer),
      contentType: "image/webp",
      provider: "openai",
      model: "gpt-image-1",
    }));
    expect(report.articles[0].image).toMatchObject({
      status: "ready",
      url: expect.stringMatching(/^\/api\/atlas\/image\/2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
    });
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
      assetKey: expect.stringMatching(/^2026-05-19\/daily\/skill-bloat-\d{14}\.webp$/),
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
