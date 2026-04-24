import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queryMock = vi.fn();
const embedTextMock = vi.fn();
const embedTextsMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

vi.mock("./model-router", () => ({
  embedText: embedTextMock,
  embedTexts: embedTextsMock,
}));

describe("semantic pgvector search", () => {
  beforeEach(() => {
    queryMock.mockReset();
    embedTextMock.mockReset();
    embedTextsMock.mockReset();
    vi.resetModules();
    process.env.VIBEZ_PGVECTOR_URL = "postgresql://semantic-test";
    process.env.VIBEZ_PGVECTOR_DIM = "64";
    process.env.VIBEZ_PGVECTOR_TABLE = "vibez_message_embeddings";
  });

  afterEach(() => {
    delete process.env.VIBEZ_PGVECTOR_URL;
    delete process.env.VIBEZ_PGVECTOR_DIM;
    delete process.env.VIBEZ_PGVECTOR_TABLE;
  });

  test("searchHybridMessages embeds the query through the shared model router", async () => {
    embedTextMock.mockResolvedValue(new Array<number>(64).fill(0.25));
    queryMock.mockResolvedValue({
      rows: [
        {
          id: "m1",
          room_id: "r1",
          room_name: "AGI",
          sender_id: "u1",
          sender_name: "Sam",
          body: "vector retrieval result",
          timestamp: 1708300000000,
          relevance_score: 8,
          topics: ["retrieval"],
          entities: ["pgvector"],
          contribution_flag: 1,
          contribution_themes: ["chat"],
          contribution_hint: "priority",
          alert_level: "hot",
        },
      ],
    });

    const semantic = await import("./semantic");
    const rows = await semantic.searchHybridMessages({
      query: "vector retrieval",
      lookbackDays: 14,
      limit: 5,
      roomScope: {
        mode: "all",
        activeGroupIds: [],
        activeGroupNames: [],
        excludedGroups: [],
      },
    });

    expect(embedTextMock).toHaveBeenCalledWith({
      taskId: "embedding.semantic",
      input: "vector retrieval",
      dimensions: 64,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(rows?.[0]).toMatchObject({
      id: "m1",
      room_name: "AGI",
      sender_name: "Sam",
    });
  });
});
