import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    query: queryMock,
  })),
}));

const ORIGINAL_ENV = process.env;

describe("listAtlasEditions", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DATABASE_URL: "postgres://atlas-editions",
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("lists durable editions newest first for the requested window", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            edition_date: "2026-05-18",
            edition_type: "daily",
            window_hours: 48,
            publication_time: "2026-05-18T13:00:00Z",
            title: "The Monday Paper",
            subtitle: "The week starts with receipts.",
            edition_label: "Daily Edition",
          },
        ],
      });

    const { listAtlasEditions } = await import("./atlas-artifact");
    const editions = await listAtlasEditions({ windowHours: 48 });

    expect(queryMock).toHaveBeenLastCalledWith(
      expect.stringContaining("ORDER BY publication_time DESC"),
      [48, "daily", 14],
    );
    expect(editions).toEqual([
      {
        date: "2026-05-18",
        type: "daily",
        window_hours: 48,
        publication_time: "2026-05-18T13:00:00Z",
        title: "The Monday Paper",
        subtitle: "The week starts with receipts.",
        edition_label: "Daily Edition",
        href: "/atlas/editions/2026-05-18?hours=48",
      },
    ]);
  });

  test("can list the whole edition archive across daily and Sunday issues", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            edition_date: "2026-05-18",
            edition_type: "daily",
            window_hours: 48,
            publication_time: "2026-05-18T13:00:00Z",
            title: "The Monday Paper",
            subtitle: "The week starts with receipts.",
            edition_label: "Daily Edition",
          },
          {
            edition_date: "2026-05-17",
            edition_type: "sunday_review",
            window_hours: 168,
            publication_time: "2026-05-17T15:00:00Z",
            title: "The Sunday Review",
            subtitle: "Seven days in the record.",
            edition_label: "Sunday Edition",
          },
        ],
      });

    const { listAtlasEditions } = await import("./atlas-artifact");
    const editions = await listAtlasEditions({ includeAllTypes: true, limit: 30 });

    expect(queryMock).toHaveBeenLastCalledWith(
      expect.not.stringContaining("WHERE window_hours"),
      [30],
    );
    expect(editions.map((edition) => edition.href)).toEqual([
      "/atlas/editions/2026-05-18?hours=48",
      "/atlas/editions/2026-05-17?hours=168",
    ]);
  });

  test("creates durable publish job and asset schema before inserting a job", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const { startAtlasPublishJob } = await import("./atlas-artifact");
    const job = await startAtlasPublishJob({
      jobId: "job-2026-05-19",
      editionDate: "2026-05-19",
      editionType: "daily",
      windowHours: 48,
      sourceWindowStart: "2026-05-17T10:00:00Z",
      sourceWindowEnd: "2026-05-19T10:00:00Z",
    });

    expect(job?.id).toBe("job-2026-05-19");
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS atlas_publish_jobs"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS atlas_assets"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO atlas_publish_jobs"))).toBe(true);
  });

  test("records publish stage status and errors as durable job state", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    const { updateAtlasPublishStage } = await import("./atlas-artifact");
    await updateAtlasPublishStage({
      jobId: "job-2026-05-19",
      stage: "write_articles",
      status: "failed",
      error: "Unexpected end of JSON input",
    });

    const updateCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE atlas_publish_jobs"),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall?.[1]).toEqual([
      "job-2026-05-19",
      JSON.stringify({ write_articles: "failed" }),
      JSON.stringify({ write_articles: "Unexpected end of JSON input" }),
      "write_articles",
      "failed",
    ]);
  });

  test("stores and reads durable Atlas image assets by key", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        asset_key: "2026-05-19/daily/skill-bloat.png",
        status: "ready",
        public_path: "/api/atlas/image/2026-05-19/daily/skill-bloat.png",
        content_type: "image/png",
      }] })
      .mockResolvedValueOnce({
        rows: [{
          asset_bytes: Buffer.from("fake-png"),
          content_type: "image/png",
        }],
      });

    const { readAtlasStoredAsset, upsertAtlasAsset } = await import("./atlas-artifact");
    await upsertAtlasAsset({
      assetKey: "2026-05-19/daily/skill-bloat.png",
      editionDate: "2026-05-19",
      editionType: "daily",
      windowHours: 48,
      articleSlug: "skill-bloat",
      assetKind: "article_image",
      status: "ready",
      prompt: "NYTimes-style documentary photo",
      contentType: "image/png",
      assetBytes: Buffer.from("fake-png"),
      publicPath: "/api/atlas/image/2026-05-19/daily/skill-bloat.png",
      provider: "test",
      model: "test-model",
    });
    const asset = await readAtlasStoredAsset("2026-05-19/daily/skill-bloat.png");

    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO atlas_assets"))).toBe(true);
    expect(asset).toEqual({
      data: Buffer.from("fake-png"),
      contentType: "image/png",
    });
  });
});
