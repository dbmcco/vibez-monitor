import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Pool } from "pg";

const queryMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

const ORIGINAL_ENV = process.env;

describe("Postgres push ingestion", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    vi.mocked(Pool).mockClear();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DATABASE_URL: "postgres://core-host/railway",
      DATABASE_URL: "",
      VIBEZ_PGVECTOR_URL: "postgres://pgvector-host/railway",
      VIBEZ_PGVECTOR_TABLE: "vibez_message_embeddings",
      VIBEZ_PGVECTOR_LINK_TABLE: "vibez_link_embeddings",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("writes core messages, classifications, and links to Postgres when configured", async () => {
    const { applyPostgresPayload } = await import("./push-ingest");

    const result = await applyPostgresPayload({
      records: [
        {
          message: {
            id: "m1",
            room_id: "room-1",
            room_name: "Agents",
            sender_id: "sender-1",
            sender_name: "Dana",
            body: "Postgres should be the source of truth.",
            timestamp: 1776120000000,
            raw_event: "{}",
          },
          classification: {
            relevance_score: 9,
            topics: ["postgres"],
            entities: ["Dana"],
            contribution_flag: true,
            contribution_themes: ["architecture"],
            contribution_hint: "ship it",
            alert_level: "digest",
          },
        },
      ],
      links: [
        {
          url: "https://example.com/postgres",
          url_hash: "hash-postgres",
          title: "Postgres note",
          category: "article",
          relevance: "Migration context",
          shared_by: "Dana",
          source_group: "Agents",
          first_seen: "2026-05-18T10:00:00.000Z",
          last_seen: "2026-05-18T11:00:00.000Z",
          mention_count: 2,
          value_score: 8,
          report_date: "2026-05-18",
          authored_by: "Dana",
          pinned: 1,
        },
      ],
    });

    expect(result).toMatchObject({
      messages_written: 1,
      classifications_written: 1,
      links_written: 1,
    });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS messages"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO messages"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO classifications"))).toBe(true);
    const classificationInsert = queryMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO classifications"));
    expect(classificationInsert?.[1]).toEqual(expect.arrayContaining([1]));
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO links"))).toBe(true);
  });

  test("can replace the Postgres link archive before rebuilding it", async () => {
    const { applyPostgresPayload } = await import("./push-ingest");

    await applyPostgresPayload({
      replace_links: true,
      links: [
        {
          url: "https://example.com/rebuilt",
          url_hash: "hash-rebuilt",
        },
      ],
    });

    const deleteIndex = queryMock.mock.calls.findIndex(([sql]) => String(sql).includes("DELETE FROM links"));
    const insertIndex = queryMock.mock.calls.findIndex(([sql]) => String(sql).includes("INSERT INTO links"));
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
  });

  test("backfills core Postgres tables from existing pgvector embedding metadata", async () => {
    const { backfillPostgresCoreFromEmbeddings } = await import("./push-ingest");

    const result = await backfillPostgresCoreFromEmbeddings();

    expect(result).toEqual({ messages_backfilled: 1, links_backfilled: 1 });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("FROM vibez_message_embeddings"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("FROM vibez_link_embeddings"))).toBe(true);
  });

  test("upserts link embeddings by url hash so rebuilt link ids do not fail", async () => {
    const { applyPgvectorPayload } = await import("./push-ingest");

    await applyPgvectorPayload({
      link_embeddings: [
        {
          link_id: 42,
          url: "https://example.com/vector",
          url_hash: "same-url-hash",
          title: "Vector",
          embedding: `[${new Array(256).fill(0.1).join(",")}]`,
        },
      ],
    });

    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes("ON CONFLICT (url_hash) DO UPDATE SET"),
    )).toBe(true);
  });

  test("normalizes blank link embedding dates before writing to pgvector", async () => {
    const { applyPgvectorPayload } = await import("./push-ingest");

    await applyPgvectorPayload({
      link_embeddings: [
        {
          link_id: 43,
          url: "https://example.com/blank-dates",
          url_hash: "blank-date-hash",
          title: "Blank Dates",
          first_seen: "",
          last_seen: "   ",
          report_date: "",
          embedding: `[${new Array(256).fill(0.1).join(",")}]`,
        },
      ],
    });

    const linkInsert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO vibez_link_embeddings"),
    );
    expect(linkInsert?.[1]).toEqual(expect.arrayContaining([null]));
    expect(linkInsert?.[1]).not.toEqual(expect.arrayContaining([""]));
  });

  test("uses the dedicated pgvector URL for embedding writes when core Postgres is separate", async () => {
    process.env.VIBEZ_DATABASE_URL = "postgres://core-host/railway";
    process.env.DATABASE_URL = "";
    process.env.VIBEZ_PGVECTOR_URL = "postgres://pgvector-host/railway";

    const { applyPgvectorPayload } = await import("./push-ingest");

    await applyPgvectorPayload({
      message_embeddings: [
        {
          message_id: "m-vector",
          room_id: "room-1",
          room_name: "Agents",
          sender_id: "sender-1",
          sender_name: "Dana",
          body: "Vector writes should use pgvector.",
          timestamp: 1776120000000,
          embedding: `[${new Array(256).fill(0.1).join(",")}]`,
        },
      ],
    });

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: "postgres://pgvector-host/railway",
    }));
  });

  test("persists canonical Beeper raw events idempotently with watermarks", async () => {
    queryMock.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text.includes("INSERT INTO raw_events")) {
        const callCount = queryMock.mock.calls.filter(([previousSql]) =>
          String(previousSql).includes("INSERT INTO raw_events"),
        ).length;
        return Promise.resolve(callCount === 1
          ? { rows: [{ id: "raw-1" }], rowCount: 1 }
          : { rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const { applyBeeperBatchPayload } = await import("./push-ingest");

    const result = await applyBeeperBatchPayload({
      source: "beeper",
      batch_key: "batch-2026-05-19T04:30:00-04:00",
      events: [
        {
          source_event_key: "room-1:event-1",
          source_room_id: "room-1",
          room_name: "Agent Harnesses",
          sender_key: "member-1",
          sender_display_name: "Dana",
          source_timestamp: "2026-05-19T08:30:00.000Z",
          body: "Worth saving: https://example.com/harness",
          raw_payload_json: { event_id: "event-1" },
        },
        {
          source_event_key: "room-1:event-1",
          source_room_id: "room-1",
          room_name: "Agent Harnesses",
          sender_key: "member-1",
          sender_display_name: "Dana",
          source_timestamp: "2026-05-19T08:30:00.000Z",
          body: "Worth saving: https://example.com/harness",
          raw_payload_json: { event_id: "event-1" },
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      source: "beeper",
      batch_key: "batch-2026-05-19T04:30:00-04:00",
      record_count: 2,
      inserted_count: 1,
      deduped_count: 1,
    });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS ingest_batches"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS source_watermarks"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS raw_events"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS raw_event_links"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO messages"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO links"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO raw_event_links"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO source_watermarks"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("UPDATE ingest_batches"))).toBe(true);
  });
});
