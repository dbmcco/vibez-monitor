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
  test("retrieves broad corpus evidence and asks the model for a follow-on research report", async () => {
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
        title: "Research dive: evaluation as proof",
        research_question: "How has the community been thinking about evaluation as durable proof?",
        what_else_was_said: ["The retrieved messages widen the article into a broader records gap."],
        why_it_matters: ["Evaluation is becoming operational infrastructure, not just commentary."],
        patterns: ["Several rooms connect evaluation, agent harnesses, and durable records."],
        tensions: ["The sample still mixes tooling anxiety with evaluation maturity."],
        open_questions: ["Whether the concern is shared across quiet channels remains unresolved."],
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
      lookbackDays: 30,
      limit: 80,
      semanticOnly: true,
    });
    expect(searchLinks).toHaveBeenCalledWith({
      query: expect.stringContaining("Evaluation becomes the work"),
      days: 30,
      limit: 40,
      sort: "value",
      semanticOnly: true,
    });
    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "dashboard.atlas_deeper_dive",
        messages: expect.any(Array),
      }),
    );
    expect(dive).toMatchObject({
      retrieval_mode: "semantic",
      title: "Research dive: evaluation as proof",
      citation_refs: ["vibez:message:m2", "vibez:link:11"],
      citation_details: [
        expect.objectContaining({
          ref: "vibez:message:m2",
          label: "Lee in Tools",
          body: "The tool catalog still needs durable records.",
        }),
        expect.objectContaining({
          ref: "vibez:link:11",
          url: "https://example.com/evals",
        }),
      ],
    });
    expect(dive.tensions[0]).toContain("tooling anxiety");
    const modelMessages = generator.mock.calls[0][0].messages;
    expect(modelMessages[1].content).toContain("follow-on research report");
    expect(modelMessages[1].content).not.toContain("Run a deeper dive on this Atlas article.");
  });

  test("fails hard instead of silently falling back when semantic retrieval is unavailable", async () => {
    await expect(generateAtlasDeeperDive(
      { article, hours: 48 },
      {
        searchMessages: vi.fn().mockResolvedValue([]),
        searchLinks: vi.fn().mockResolvedValue([]),
        generateJson: vi.fn().mockResolvedValue({
          parsed: {
            title: "Deeper dive",
            research_question: "Question",
            what_else_was_said: ["Evidence"],
            why_it_matters: ["Matter"],
            patterns: ["Pattern"],
            tensions: ["Tension"],
            open_questions: ["Question"],
            recommended_actions: ["Action"],
            citation_refs: [],
          },
        }),
        isSemanticEnabled: () => false,
      },
    )).rejects.toThrow(/semantic retrieval/i);
  });
});
