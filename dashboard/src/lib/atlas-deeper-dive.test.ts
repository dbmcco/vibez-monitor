import { describe, expect, test, vi } from "vitest";

import type { AtlasEditorialArticle } from "./atlas-report";
import { generateAtlasDeeperDive } from "./atlas-deeper-dive";

vi.mock("./db", () => ({
  searchMessages: vi.fn(),
  searchLinks: vi.fn(),
}));

vi.mock("./model-router", () => ({
  generateJson: vi.fn(),
}));

vi.mock("./semantic", () => ({
  isPgvectorEnabled: vi.fn(() => true),
}));

const article: AtlasEditorialArticle = {
  role: "lead",
  title: "Evaluation becomes the work",
  slug: "evaluation-becomes-the-work",
  dek: "The room is moving from demos to proof.",
  summary: "The main article explains why evaluation is now the bottleneck.",
  body: [
    "Evaluation moved from background concern to front-page story.",
    "The cited messages show a group asking for proof, not applause.",
    "That matters because repeatable agent work needs durable records.",
  ],
  actions: ["Assign an owner for the evaluation loop."],
  evidence_refs: ["vibez:message:m1"],
  link_refs: ["vibez:link:11"],
  channels: ["Agents"],
  image: { kind: "generated", prompt: "newspaper illustration" },
  related_article_slugs: [],
};

describe("atlas deeper dive", () => {
  test("retrieves evidence and asks the model for adversarial analysis", async () => {
    const searchMessages = vi.fn().mockResolvedValue([
      {
        id: "m2",
        room_name: "Tools",
        sender_name: "Lee",
        body: "The tool catalog still needs durable records.",
        timestamp: 1778932790000,
        relevance_score: 8,
      },
    ]);
    const searchLinks = vi.fn().mockResolvedValue([
      {
        id: 11,
        url: "https://example.com/evals",
        title: "Agent eval notes",
        relevance: "Background on evaluation loops",
      },
    ]);
    const generator = vi.fn().mockResolvedValue({
      parsed: {
        title: "Deeper dive: evaluation as proof",
        claim_under_review: "Evaluation is now the bottleneck.",
        supporting_evidence: ["The retrieved messages reinforce the records gap."],
        counterevidence: ["The sample is still small."],
        weak_spots: ["The article may overstate consensus."],
        alternative_interpretations: ["This may be tooling anxiety rather than evaluation maturity."],
        recommended_actions: ["Interview the people in both rooms before changing roadmap."],
        citation_refs: ["vibez:message:m2", "vibez:link:11", "vibez:message:nope"],
      },
    });

    const dive = await generateAtlasDeeperDive(
      { article, hours: 48 },
      {
        searchMessages,
        searchLinks,
        generateJson: generator,
        isSemanticEnabled: () => true,
      },
    );

    expect(searchMessages).toHaveBeenCalledWith({
      query: expect.stringContaining("Evaluation becomes the work"),
      lookbackDays: 2,
      limit: 20,
    });
    expect(searchLinks).toHaveBeenCalledWith({
      query: expect.stringContaining("Evaluation becomes the work"),
      days: 7,
      limit: 12,
      sort: "value",
    });
    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "dashboard.atlas_deeper_dive",
        messages: expect.any(Array),
      }),
    );
    expect(dive).toMatchObject({
      retrieval_mode: "semantic",
      title: "Deeper dive: evaluation as proof",
      citation_refs: ["vibez:message:m2", "vibez:link:11"],
    });
    expect(dive.counterevidence[0]).toContain("small");
  });

  test("discloses keyword fallback when semantic retrieval is unavailable", async () => {
    const dive = await generateAtlasDeeperDive(
      { article, hours: 48 },
      {
        searchMessages: vi.fn().mockResolvedValue([]),
        searchLinks: vi.fn().mockResolvedValue([]),
        generateJson: vi.fn().mockResolvedValue({
          parsed: {
            title: "Deeper dive",
            claim_under_review: "Claim",
            supporting_evidence: ["Support"],
            counterevidence: ["Counter"],
            weak_spots: ["Weak spot"],
            alternative_interpretations: ["Alternative"],
            recommended_actions: ["Action"],
            citation_refs: [],
          },
        }),
        isSemanticEnabled: () => false,
      },
    );

    expect(dive.retrieval_mode).toBe("keyword_fallback");
  });
});
