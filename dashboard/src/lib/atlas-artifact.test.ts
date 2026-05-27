import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      requestOptions: { classifyLimit: 0, messageEmbeddingLimit: 0 },
    });

    expect(job?.id).toBe("job-2026-05-19");
    expect(job?.request_options).toEqual({ classifyLimit: 0, messageEmbeddingLimit: 0 });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS atlas_publish_jobs"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("ADD COLUMN IF NOT EXISTS request_options"))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes("CREATE TABLE IF NOT EXISTS atlas_assets"))).toBe(true);
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO atlas_publish_jobs"));
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[1]).toContain(JSON.stringify({ classifyLimit: 0, messageEmbeddingLimit: 0 }));
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

  test("publishes Atlas editions to Postgres without writing local artifact files in production", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-first-"));
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      VIBEZ_DATABASE_URL: "postgres://atlas-editions",
      VIBEZ_ATLAS_ARTIFACT_PATH: path.join(tempDir, "atlas-48.json"),
    };

    try {
      const { writeAtlasArtifact } = await import("./atlas-artifact");
      await writeAtlasArtifact({
        windowHours: 48,
        atlas: sampleAtlas("2026-05-27"),
        editorialReport: sampleEditorialReport("2026-05-27", "The May 27 Paper"),
      });

      const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO atlas_editions"));
      expect(insertCall?.[1]?.slice(0, 4)).toEqual([
        "2026-05-27",
        "daily",
        48,
        expect.stringMatching(/^2026-/),
      ]);
      expect(fs.existsSync(path.join(tempDir, "atlas-48.json"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "editions", "2026-05-27-daily-48.json"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fails publish and skips local artifact files when Postgres archive fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-db-fail-"));
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"));
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "production",
      VIBEZ_DATABASE_URL: "postgres://atlas-editions",
      VIBEZ_ATLAS_ARTIFACT_PATH: path.join(tempDir, "atlas-48.json"),
    };

    try {
      const { writeAtlasArtifact } = await import("./atlas-artifact");
      await expect(writeAtlasArtifact({
        windowHours: 48,
        atlas: sampleAtlas("2026-05-27"),
        editorialReport: sampleEditorialReport("2026-05-27", "The May 27 Paper"),
      })).rejects.toThrow("database unavailable");

      expect(fs.existsSync(path.join(tempDir, "atlas-48.json"))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "editions", "2026-05-27-daily-48.json"))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("file-backed Atlas edition archive", () => {
  let tempDir = "";

  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-editions-"));
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_DATABASE_URL: "",
      DATABASE_URL: "",
      VIBEZ_PGVECTOR_URL: "",
      VIBEZ_ATLAS_ARTIFACT_PATH: path.join(tempDir, "atlas-48.json"),
    };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("keeps previous day editions when the latest artifact pointer is overwritten", async () => {
    const { listAtlasEditions, readAtlasArtifact, writeAtlasArtifact } = await import("./atlas-artifact");

    await writeAtlasArtifact({
      windowHours: 48,
      atlas: sampleAtlas("2026-05-17"),
      editorialReport: sampleEditorialReport("2026-05-17", "The May 17 Paper"),
    });
    await writeAtlasArtifact({
      windowHours: 48,
      atlas: sampleAtlas("2026-05-19"),
      editorialReport: sampleEditorialReport("2026-05-19", "The May 19 Paper"),
    });

    const editions = await listAtlasEditions({ windowHours: 48, limit: 10 });
    expect(editions.map((edition) => edition.date)).toEqual(["2026-05-19", "2026-05-17"]);

    const may17 = await readAtlasArtifact(48, "2026-05-17");
    expect(may17?.editorial_report.issue.title).toBe("The May 17 Paper");

    const latest = await readAtlasArtifact(48);
    expect(latest?.editorial_report.issue.title).toBe("The May 19 Paper");
    expect(fs.existsSync(path.join(tempDir, "editions", "2026-05-17-daily-48.json"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "editions", "2026-05-19-daily-48.json"))).toBe(true);
  });

  test("opens the latest issue by date even before an edition archive file exists", async () => {
    const { readAtlasArtifact, writeAtlasArtifact } = await import("./atlas-artifact");

    await writeAtlasArtifact({
      windowHours: 48,
      atlas: sampleAtlas("2026-05-19"),
      editorialReport: sampleEditorialReport("2026-05-19", "The May 19 Paper"),
    });
    fs.rmSync(path.join(tempDir, "editions"), { recursive: true, force: true });

    const may19 = await readAtlasArtifact(48, "2026-05-19");
    expect(may19?.editorial_report.issue.title).toBe("The May 19 Paper");

    const may17 = await readAtlasArtifact(48, "2026-05-17");
    expect(may17).toBeNull();
  });
});

function sampleAtlas(date: string) {
  return {
    generated_at: `${date}T12:00:00Z`,
    window: { start: `${date}T00:00:00Z`, end: `${date}T12:00:00Z`, hours: 48 },
    overview: { messages: 0, people: 0, channels: 0, topics: 0, links: 0 },
    channels: [],
    topics: [],
    matrix: [],
    concerns: [],
    links: [],
    citations: {},
    people: {
      window_days: 7,
      generated_at: `${date}T12:00:00Z`,
      new_faces: [],
      identity_signals: [],
      top_contributors: [],
    },
    narrative: {
      title: "Atlas",
      summary: "",
      report: {
        headline: "",
        kicker: "",
        lead: "",
        what_matters: [],
        what_to_watch: [],
        evidence_refs: [],
      },
      paragraphs: [],
      main_topic: { title: "", topic: null, paragraphs: [], citation_refs: [] },
      week_in_review: { title: "", bullets: [] },
    },
  } as never;
}

function sampleEditorialReport(date: string, title: string) {
  return {
    issue: {
      date,
      title,
      subtitle: "Archived issue",
      edition_label: "Daily Edition",
    },
    headline: title,
    dek: "",
    what_happened: [],
    what_it_means: [],
    why_care: [],
    valuable: [],
    actions: [],
    main_topic: { title: "", paragraphs: [], evidence_refs: [] },
    articles: [],
    briefs: [],
    crosscurrents: [],
    channel_reports: [],
    themes: [],
    evidence: [],
    generated_at: `${date}T12:00:00Z`,
  } as never;
}
