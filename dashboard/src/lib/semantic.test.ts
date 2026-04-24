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

  test("searchHybridLinks embeds the query through the shared model router", async () => {
    embedTextMock.mockResolvedValue(new Array<number>(64).fill(0.4));
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 7,
          url: "https://wiki.thirdgulfwar.com/",
          url_hash: "abc123",
          title: "wiki.thirdgulfwar.com",
          category: "article",
          relevance: "Schuyler's Iran site",
          shared_by: "Nat",
          source_group: "Show and Tell",
          first_seen: "2026-04-23T12:00:00",
          last_seen: "2026-04-23T12:05:00",
          mention_count: 2,
          value_score: 1.7,
          report_date: "2026-04-23",
          authored_by: "Schuyler",
          pinned: 0,
        },
      ],
    });

    const semantic = await import("./semantic");
    const rows = await semantic.searchHybridLinks({
      query: "schuyler's iran site",
      limit: 5,
    });

    expect(embedTextMock).toHaveBeenCalledWith({
      taskId: "embedding.semantic",
      input: "schuyler's iran site",
      dimensions: 64,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(rows?.[0]).toMatchObject({
      url: "https://wiki.thirdgulfwar.com/",
      title: "wiki.thirdgulfwar.com",
    });
  });
});
