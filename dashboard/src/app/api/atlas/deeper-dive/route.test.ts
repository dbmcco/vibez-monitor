import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

const generateAtlasDeeperDiveMock = vi.fn();

vi.mock("@/lib/atlas-deeper-dive", () => ({
  generateAtlasDeeperDive: generateAtlasDeeperDiveMock,
}));

const article = {
  role: "lead",
  title: "Evaluation becomes the work",
  slug: "evaluation-becomes-the-work",
  dek: "The room is moving from demos to proof.",
  summary: "The main article explains why evaluation is now the bottleneck.",
  body: ["One", "Two", "Three"],
  actions: ["Assign an owner."],
  evidence_refs: ["vibez:message:m1"],
  link_refs: ["vibez:link:11"],
  channels: ["Agents"],
  image: { kind: "generated" },
  related_article_slugs: [],
};

describe("POST /api/atlas/deeper-dive", () => {
  beforeEach(() => {
    generateAtlasDeeperDiveMock.mockReset();
  });

  test("runs a deeper dive for a supplied article", async () => {
    generateAtlasDeeperDiveMock.mockResolvedValue({
      title: "Deeper dive",
      retrieval_mode: "semantic",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://test.local/api/atlas/deeper-dive", {
        method: "POST",
        body: JSON.stringify({ article, hours: 48 }),
      }),
    );
    const body = await response.json();

    expect(generateAtlasDeeperDiveMock).toHaveBeenCalledWith({ article, hours: 48 });
    expect(body).toEqual({
      deeper_dive: { title: "Deeper dive", retrieval_mode: "semantic" },
      error: null,
    });
  });

  test("rejects malformed article payloads", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://test.local/api/atlas/deeper-dive", {
        method: "POST",
        body: JSON.stringify({ article: { title: "" } }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      deeper_dive: null,
      error: "article title and slug are required",
    });
  });
});
