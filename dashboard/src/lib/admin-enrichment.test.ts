import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queryMock = vi.fn();
const generateJsonMock = vi.fn();
const embedTextsMock = vi.fn();
const getAtlasSnapshotMock = vi.fn();
const generateAtlasEditorialReportMock = vi.fn();
const writeAtlasArtifactMock = vi.fn();
const readAtlasArtifactMock = vi.fn();
const startAtlasPublishJobMock = vi.fn();
const updateAtlasPublishStageMock = vi.fn();
const upsertAtlasAssetMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

vi.mock("./model-router", () => ({
  generateJson: generateJsonMock,
  embedTexts: embedTextsMock,
}));

vi.mock("./db", () => ({
  getAtlasSnapshot: getAtlasSnapshotMock,
}));

vi.mock("./atlas-report", () => ({
  generateAtlasEditorialReport: generateAtlasEditorialReportMock,
}));

vi.mock("./atlas-artifact", () => ({
  writeAtlasArtifact: writeAtlasArtifactMock,
  readAtlasArtifact: readAtlasArtifactMock,
  startAtlasPublishJob: startAtlasPublishJobMock,
  updateAtlasPublishStage: updateAtlasPublishStageMock,
  upsertAtlasAsset: upsertAtlasAssetMock,
  editionTypeForWindow: (windowHours: number) => windowHours >= 120 ? "sunday_review" : "daily",
}));

const ORIGINAL_ENV = process.env;

describe("Railway admin enrichment", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    generateJsonMock.mockReset();
    embedTextsMock.mockReset();
    getAtlasSnapshotMock.mockReset();
    generateAtlasEditorialReportMock.mockReset();
    writeAtlasArtifactMock.mockReset();
    readAtlasArtifactMock.mockReset();
    startAtlasPublishJobMock.mockReset();
    updateAtlasPublishStageMock.mockReset();
    upsertAtlasAssetMock.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DATABASE_URL: "postgres://railway-db",
      VIBEZ_PGVECTOR_DIM: "64",
      VIBEZ_PGVECTOR_TABLE: "vibez_message_embeddings",
      VIBEZ_PGVECTOR_LINK_TABLE: "vibez_link_embeddings",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("classifies and embeds only rows missing Railway enrichment", async () => {
    const message = {
      id: "m1",
      room_id: "room-1",
      room_name: "Agent Harnesses",
      sender_id: "member-1",
      sender_name: "Dana",
      body: "We should use pgvector for adversarial deep dives.",
      timestamp: 1776120000000,
      relevance_score: 9,
      topics: '["retrieval"]',
      entities: '["pgvector"]',
      contribution_flag: true,
      contribution_themes: '["architecture"]',
      contribution_hint: "Useful direction for deep dives.",
      alert_level: "digest",
    };
    const link = {
      id: 11,
      url: "https://example.com/vector",
      url_hash: "hash-vector",
      title: "Vector notes",
      category: "article",
      relevance: "Deep dive retrieval background",
      shared_by: "Dana",
      source_group: "Agent Harnesses",
      first_seen: "2026-05-18T10:00:00.000Z",
      last_seen: "2026-05-18T11:00:00.000Z",
      mention_count: 2,
      value_score: 7,
      report_date: "2026-05-18",
      authored_by: "Dana",
      pinned: 0,
    };

    queryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT to_regclass")) {
        return { rows: [{ table_name: null }], rowCount: 1 };
      }
      if (text.includes("FROM messages m") && text.includes("c.message_id IS NULL")) {
        return { rows: [message], rowCount: 1 };
      }
      if (text.includes("FROM messages m") && text.includes("c.relevance_score")) {
        return { rows: [message], rowCount: 1 };
      }
      if (text.includes("FROM links l")) {
        return { rows: [link], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    generateJsonMock.mockResolvedValue({
      parsed: {
        relevance_score: 9,
        topics: ["retrieval"],
        entities: ["pgvector"],
        contribution_flag: true,
        contribution_themes: ["architecture"],
        contribution_hint: "Useful direction for deep dives.",
        alert_level: "digest",
      },
    });
    embedTextsMock.mockResolvedValue({ vectors: [new Array<number>(64).fill(0.2)] });

    const { refreshRailwayEnrichment } = await import("./admin-enrichment");
    const result = await refreshRailwayEnrichment({
      classifyLimit: 1,
      messageEmbeddingLimit: 1,
      linkEmbeddingLimit: 1,
      rebuildAtlas: false,
    });

    expect(result).toMatchObject({
      ok: true,
      classifications_written: 1,
      message_embeddings_written: 1,
      link_embeddings_written: 1,
      atlas: { rebuilt: false },
    });
    expect(generateJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "classification.inline",
    }));
    expect(embedTextsMock).toHaveBeenCalledTimes(2);
    expect(embedTextsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      taskId: "embedding.semantic",
      dimensions: 64,
    }));
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO classifications"))).toBe(true);
    const classificationInsert = queryMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO classifications"));
    expect(classificationInsert?.[1]).toEqual(expect.arrayContaining([1]));
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO vibez_message_embeddings"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO vibez_link_embeddings"))).toBe(true);
    const linkSelection = queryMock.mock.calls.find(([sql]) => String(sql).includes("FROM links l"));
    expect(String(linkSelection?.[0])).toContain("DESC NULLS LAST");
    expect(String(linkSelection?.[0])).not.toContain("report_date, ''");
  });

  test("filters missing embeddings against the dedicated pgvector database", async () => {
    const embeddedMessage = {
      id: "m-embedded",
      room_id: "room-1",
      room_name: "Agent Harnesses",
      sender_id: "member-1",
      sender_name: "Dana",
      body: "Already embedded message.",
      timestamp: 1776120000000,
    };
    const missingMessage = {
      ...embeddedMessage,
      id: "m-missing",
      body: "Missing embedding message.",
    };
    const embeddedLink = {
      id: 21,
      url: "https://example.com/embedded",
      url_hash: "hash-embedded",
      title: "Embedded",
      category: "article",
      relevance: "",
      shared_by: "Dana",
      source_group: "Agent Harnesses",
      first_seen: "2026-05-18T10:00:00.000Z",
      last_seen: "2026-05-18T11:00:00.000Z",
      mention_count: 1,
      value_score: 1,
      report_date: "2026-05-18",
      authored_by: "Dana",
      pinned: 0,
    };
    const missingLink = {
      ...embeddedLink,
      id: 22,
      url: "https://example.com/missing",
      url_hash: "hash-missing",
      title: "Missing",
    };

    queryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT to_regclass")) {
        return { rows: [{ table_name: "present" }], rowCount: 1 };
      }
      if (text.includes("SELECT message_id FROM vibez_message_embeddings")) {
        return { rows: [{ message_id: "m-embedded" }], rowCount: 1 };
      }
      if (text.includes("SELECT url_hash FROM vibez_link_embeddings")) {
        return { rows: [{ url_hash: "hash-embedded" }], rowCount: 1 };
      }
      if (text.includes("FROM messages m") && text.includes("c.relevance_score")) {
        return { rows: [embeddedMessage, missingMessage], rowCount: 2 };
      }
      if (text.includes("FROM links l")) {
        return { rows: [embeddedLink, missingLink], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });
    embedTextsMock.mockResolvedValue({ vectors: [new Array<number>(64).fill(0.2)] });

    const { refreshRailwayEnrichment } = await import("./admin-enrichment");
    const result = await refreshRailwayEnrichment({
      classifyLimit: 0,
      messageEmbeddingLimit: 5,
      linkEmbeddingLimit: 5,
      rebuildAtlas: false,
    });

    expect(result.message_embeddings_written).toBe(1);
    expect(result.link_embeddings_written).toBe(1);
    const messageInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO vibez_message_embeddings"),
    );
    const linkInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO vibez_link_embeddings"),
    );
    expect(messageInsert?.[1]).toEqual(expect.arrayContaining(["m-missing"]));
    expect(messageInsert?.[1]).not.toEqual(expect.arrayContaining(["m-embedded"]));
    expect(linkInsert?.[1]).toEqual(expect.arrayContaining(["hash-missing"]));
    expect(linkInsert?.[1]).not.toEqual(expect.arrayContaining(["hash-embedded"]));
  });

  test("uses bounded candidate scans when filtering dedicated pgvector embeddings", async () => {
    const messages = [
      {
        id: "m-embedded",
        room_id: "room-1",
        room_name: "Agent Harnesses",
        sender_id: "member-1",
        sender_name: "Dana",
        body: "Already embedded message.",
        timestamp: 1776120000000,
      },
      {
        id: "m-missing",
        room_id: "room-1",
        room_name: "Agent Harnesses",
        sender_id: "member-1",
        sender_name: "Dana",
        body: "Missing embedding message.",
        timestamp: 1776120000001,
      },
    ];
    const links = [
      {
        id: 21,
        url: "https://example.com/embedded",
        url_hash: "hash-embedded",
        title: "Embedded",
        category: "article",
        relevance: "",
        shared_by: "Dana",
        source_group: "Agent Harnesses",
        first_seen: "2026-05-18T10:00:00.000Z",
        last_seen: "2026-05-18T11:00:00.000Z",
        mention_count: 1,
        value_score: 1,
        report_date: "2026-05-18",
        authored_by: "Dana",
        pinned: 0,
      },
      {
        id: 22,
        url: "https://example.com/missing",
        url_hash: "hash-missing",
        title: "Missing",
        category: "article",
        relevance: "",
        shared_by: "Dana",
        source_group: "Agent Harnesses",
        first_seen: "2026-05-18T10:00:00.000Z",
        last_seen: "2026-05-18T11:00:00.000Z",
        mention_count: 1,
        value_score: 1,
        report_date: "2026-05-18",
        authored_by: "Dana",
        pinned: 0,
      },
    ];

    queryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT to_regclass")) {
        return { rows: [{ table_name: "present" }], rowCount: 1 };
      }
      if (text.includes("SELECT message_id FROM vibez_message_embeddings")) {
        return { rows: [{ message_id: "m-embedded" }], rowCount: 1 };
      }
      if (text.includes("SELECT url_hash FROM vibez_link_embeddings")) {
        return { rows: [{ url_hash: "hash-embedded" }], rowCount: 1 };
      }
      if (text.includes("FROM messages m") && text.includes("c.relevance_score")) {
        return { rows: messages, rowCount: messages.length };
      }
      if (text.includes("FROM links l")) {
        return { rows: links, rowCount: links.length };
      }
      return { rows: [], rowCount: 1 };
    });
    embedTextsMock.mockResolvedValue({ vectors: [new Array<number>(64).fill(0.2)] });

    const { refreshRailwayEnrichment } = await import("./admin-enrichment");
    await refreshRailwayEnrichment({
      classifyLimit: 0,
      messageEmbeddingLimit: 1,
      linkEmbeddingLimit: 1,
      rebuildAtlas: false,
    });

    const messageSelection = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("FROM messages m") && String(sql).includes("c.relevance_score"),
    );
    const linkSelection = queryMock.mock.calls.find(([sql]) => String(sql).includes("FROM links l"));
    const messageEmbeddingSelection = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT message_id FROM vibez_message_embeddings"),
    );
    const linkEmbeddingSelection = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT url_hash FROM vibez_link_embeddings"),
    );

    expect(String(messageSelection?.[0])).toContain("LIMIT $1 OFFSET $2");
    expect(String(linkSelection?.[0])).toContain("LIMIT $1 OFFSET $2");
    expect(String(messageEmbeddingSelection?.[0])).toMatch(/message_id = ANY\(\$1(?:::text\[\])?\)/);
    expect(String(linkEmbeddingSelection?.[0])).toMatch(/url_hash = ANY\(\$1(?:::text\[\])?\)/);
    expect(messageEmbeddingSelection?.[1]).toEqual([["m-embedded", "m-missing"]]);
    expect(linkEmbeddingSelection?.[1]).toEqual([["hash-embedded", "hash-missing"]]);
  });

  test("stops scanning after bounded pages when recent candidates already have embeddings", async () => {
    queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("SELECT to_regclass")) {
        return { rows: [{ table_name: "present" }], rowCount: 1 };
      }
      if (text.includes("FROM messages m") && text.includes("c.relevance_score")) {
        const page = queryMock.mock.calls
          .filter(([query]) => String(query).includes("FROM messages m") && String(query).includes("c.relevance_score"))
          .length;
        const rows = Array.from({ length: 256 }, (_, index) => ({
          id: `m-${page}-${index}`,
          room_id: "room-1",
          room_name: "Agent Harnesses",
          sender_id: "member-1",
          sender_name: "Dana",
          body: "Already embedded message.",
          timestamp: 1776120000000 - index,
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("SELECT message_id FROM vibez_message_embeddings")) {
        const ids = Array.isArray(params?.[0]) ? params[0] as string[] : [];
        return { rows: ids.map((message_id: string) => ({ message_id })), rowCount: ids.length };
      }
      if (text.includes("FROM links l")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    const { refreshRailwayEnrichment } = await import("./admin-enrichment");
    const result = await refreshRailwayEnrichment({
      classifyLimit: 0,
      messageEmbeddingLimit: 1,
      linkEmbeddingLimit: 0,
      rebuildAtlas: false,
    });

    const messageSelections = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM messages m") && String(sql).includes("c.relevance_score"),
    );
    expect(messageSelections).toHaveLength(8);
    expect(result.message_embeddings_written).toBe(0);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  test("records publish job stages around an Atlas rebuild", async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("SELECT to_regclass")) {
        return { rows: [{ table_name: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    embedTextsMock.mockResolvedValue({ vectors: [] });
    startAtlasPublishJobMock.mockResolvedValue({ id: "atlas-job-1" });
    upsertAtlasAssetMock.mockResolvedValue({ asset_key: "unused" });
    getAtlasSnapshotMock.mockResolvedValue({
      generated_at: "2026-05-19T10:00:00Z",
      window: {
        start: "2026-05-17T10:00:00Z",
        end: "2026-05-19T10:00:00Z",
        hours: 48,
      },
    });
    generateAtlasEditorialReportMock.mockResolvedValue({
      issue: { date: "2026-05-19" },
      articles: [
        { section: "Agent Architecture" },
        { section: "AI Writing" },
      ],
      channel_reports: [
        {
          channel: "Agents",
          headline: "Agents made evaluation operational",
        },
      ],
    });
    writeAtlasArtifactMock.mockResolvedValue("/tmp/atlas-48.json");
    process.env.VIBEZ_ATLAS_ARTIFACT_WRITE = "1";

    const { refreshRailwayEnrichment } = await import("./admin-enrichment");
    const result = await refreshRailwayEnrichment({
      classifyLimit: 0,
      messageEmbeddingLimit: 0,
      linkEmbeddingLimit: 0,
      rebuildAtlas: true,
      atlasHours: 48,
    });

    expect(startAtlasPublishJobMock).toHaveBeenCalledWith(expect.objectContaining({
      editionType: "daily",
      windowHours: 48,
    }));
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "enrich",
      status: "running",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "enrich",
      status: "succeeded",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "write_articles",
      status: "running",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "write_channel_reports",
      status: "succeeded",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "generate_images",
      status: "running",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: "atlas-job-1",
      stage: "publish",
      status: "succeeded",
    });
    expect(result.atlas).toMatchObject({
      rebuilt: true,
      publish_job_id: "atlas-job-1",
      edition_date: "2026-05-19",
      edition_type: "daily",
      window_hours: 48,
      stage_summary: {
        enrich: "succeeded",
        write_articles: "succeeded",
        write_channel_reports: "succeeded",
        generate_images: "skipped",
        publish: "succeeded",
      },
      articles: 2,
    });
  });

  test("refreshes images on the latest Atlas artifact without enrichment work", async () => {
    const artifact = {
      atlas: {
        generated_at: "2026-05-19T10:00:00Z",
        window: {
          start: "2026-05-17T10:00:00Z",
          end: "2026-05-19T10:00:00Z",
          hours: 48,
        },
      },
      editorial_report: {
        issue: { date: "2026-05-19" },
        articles: [
          {
            title: "Attack Surface",
            section: "Agent Architecture",
            image: { kind: "source", url: "https://example.com/source.jpg" },
          },
        ],
        channel_reports: [],
      },
    };
    readAtlasArtifactMock.mockResolvedValue(artifact);
    writeAtlasArtifactMock.mockResolvedValue("/tmp/atlas-48.json");

    const { refreshAtlasArticleImages } = await import("./admin-enrichment");
    const result = await refreshAtlasArticleImages({ atlasHours: 48 });

    expect(readAtlasArtifactMock).toHaveBeenCalledWith(48);
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: undefined,
      stage: "generate_images",
      status: "running",
    });
    expect(updateAtlasPublishStageMock).toHaveBeenCalledWith({
      jobId: undefined,
      stage: "publish",
      status: "succeeded",
    });
    expect(writeAtlasArtifactMock).toHaveBeenCalledWith({
      windowHours: 48,
      atlas: artifact.atlas,
      editorialReport: expect.objectContaining({
        issue: { date: "2026-05-19" },
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      classifications_written: 0,
      message_embeddings_written: 0,
      link_embeddings_written: 0,
      atlas: {
        rebuilt: true,
        edition_date: "2026-05-19",
        edition_type: "daily",
        window_hours: 48,
        articles: 1,
      },
    });
  });
});
