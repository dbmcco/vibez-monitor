import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import type { AtlasSnapshot } from "./atlas";
import type { AtlasEditorialReport } from "./atlas-report";

export interface AtlasArtifactPayload {
  atlas: AtlasSnapshot;
  editorial_report: AtlasEditorialReport;
  editorial_error: null;
  artifact: {
    generated_at: string;
    window_hours: number;
    source: "configured_model_route";
  };
}

export interface AtlasEditionSummary {
  date: string;
  type: "daily" | "sunday_review";
  window_hours: number;
  publication_time: string;
  title: string;
  subtitle: string;
  edition_label: string;
  href: string;
}

export type AtlasPublishEditionType = "daily" | "sunday_review";
export type AtlasPublishStage =
  | "ingest"
  | "enrich"
  | "write_articles"
  | "write_channel_reports"
  | "generate_images"
  | "publish"
  | "verify";
export type AtlasPublishStageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type AtlasPublishJobStatus = "running" | "succeeded" | "failed";
export type AtlasAssetStatus = "pending" | "ready" | "failed" | "skipped";
export type AtlasAssetKind = "article_image";

export interface AtlasPublishJob {
  id: string;
  edition_date: string;
  edition_type: AtlasPublishEditionType;
  window_hours: number;
  status: AtlasPublishJobStatus;
}

export interface AtlasAssetRecord {
  asset_key: string;
  status: AtlasAssetStatus;
  public_path?: string | null;
  content_type?: string | null;
}

let atlasPool: Pool | null = null;
let atlasPublishSchemaReady = false;

function atlasPostgresUrl(): string {
  return (process.env.VIBEZ_DATABASE_URL || process.env.DATABASE_URL || process.env.VIBEZ_PGVECTOR_URL || "").trim();
}

function getAtlasPool(): Pool | null {
  const url = atlasPostgresUrl();
  if (!url) return null;
  if (!atlasPool) {
    atlasPool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }
  return atlasPool;
}

async function ensureAtlasEditionSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atlas_editions (
      edition_date TEXT NOT NULL,
      edition_type TEXT NOT NULL,
      window_hours INTEGER NOT NULL,
      publication_time TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (edition_date, edition_type)
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_atlas_editions_publication_time ON atlas_editions (publication_time DESC)",
  );
}

async function ensureAtlasPublishSchema(pool: Pool): Promise<void> {
  if (atlasPublishSchemaReady) return;
  await ensureAtlasEditionSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atlas_publish_jobs (
      id TEXT PRIMARY KEY,
      edition_date TEXT NOT NULL,
      edition_type TEXT NOT NULL,
      window_hours INTEGER NOT NULL,
      source_window_start TEXT,
      source_window_end TEXT,
      status TEXT NOT NULL,
      stage_status JSONB NOT NULL DEFAULT '{}'::jsonb,
      stage_errors JSONB NOT NULL DEFAULT '{}'::jsonb,
      retry_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_atlas_publish_jobs_edition ON atlas_publish_jobs (edition_date DESC, edition_type, window_hours)",
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atlas_assets (
      asset_key TEXT PRIMARY KEY,
      edition_date TEXT NOT NULL,
      edition_type TEXT NOT NULL,
      window_hours INTEGER NOT NULL,
      article_slug TEXT,
      asset_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT,
      content_type TEXT,
      asset_bytes BYTEA,
      storage_url TEXT,
      public_path TEXT,
      provider TEXT,
      model TEXT,
      error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_atlas_assets_edition ON atlas_assets (edition_date DESC, edition_type, window_hours)",
  );
  atlasPublishSchemaReady = true;
}

export function editionTypeForWindow(windowHours: number): AtlasPublishEditionType {
  return windowHours >= 120 ? "sunday_review" : "daily";
}

function editionLabelFor(type: "daily" | "sunday_review", label?: string | null): string {
  if (type === "sunday_review") return "Sunday Edition";
  return String(label || "Daily Edition");
}

function atlasEditionHref(date: string, windowHours: number): string {
  return `/atlas/editions/${encodeURIComponent(date)}?hours=${windowHours}`;
}

export function atlasArtifactPath(windowHours: number): string {
  const configured = process.env.VIBEZ_ATLAS_ARTIFACT_PATH;
  if (configured) return configured;
  return atlasArtifactCandidates(windowHours)[0];
}

function defaultArtifactRoot(): string {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  if (path.basename(cwd) === "dashboard") {
    return path.join(cwd, ".generated");
  }
  const dashboardDir = path.join(cwd, "dashboard");
  if (fs.existsSync(path.join(dashboardDir, "package.json"))) {
    return path.join(dashboardDir, ".generated");
  }
  return path.join(cwd, ".generated");
}

function atlasArtifactCandidates(windowHours: number): string[] {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const filename = path.join("atlas", `atlas-${windowHours}.json`);
  const roots = [
    defaultArtifactRoot(),
    path.join(cwd, "generated"),
    path.join(cwd, "dashboard", ".generated"),
    path.join(cwd, "dashboard", "generated"),
  ];
  return Array.from(new Set(roots.map((root) => path.join(root, filename))));
}

function atlasEditionArtifactPath(
  windowHours: number,
  editionDate: string,
  editionType: AtlasPublishEditionType,
): string {
  const safeDate = editionDate.replace(/[^0-9-]/g, "") || "unknown-date";
  const filename = `${safeDate}-${editionType}-${windowHours}.json`;
  const configured = process.env.VIBEZ_ATLAS_ARTIFACT_PATH;
  if (configured) return path.join(path.dirname(configured), "editions", filename);
  return path.join(defaultArtifactRoot(), "atlas", "editions", filename);
}

function atlasEditionArtifactDirs(): string[] {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const configured = process.env.VIBEZ_ATLAS_ARTIFACT_PATH;
  if (configured) return [path.join(path.dirname(configured), "editions")];
  const roots = [
    defaultArtifactRoot(),
    path.join(cwd, "generated"),
    path.join(cwd, "dashboard", ".generated"),
    path.join(cwd, "dashboard", "generated"),
  ];
  return Array.from(new Set(roots.map((root) => path.join(root, "atlas", "editions"))));
}

export function atlasGeneratedAssetCandidates(relativePath: string): string[] {
  const safePath = relativePath
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
  if (!safePath) return [];
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const roots = [
    defaultArtifactRoot(),
    path.join(cwd, "generated"),
    path.join(cwd, "dashboard", ".generated"),
    path.join(cwd, "dashboard", "generated"),
  ];
  return Array.from(new Set(roots.map((root) => path.join(root, safePath))));
}

export function readAtlasGeneratedAsset(relativePath: string): { data: Buffer; contentType: string } | null {
  const assetPath = atlasGeneratedAssetCandidates(relativePath).find((candidate) => fs.existsSync(candidate));
  if (!assetPath) return null;
  const ext = path.extname(assetPath).toLowerCase();
  const contentType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".svg"
          ? "image/svg+xml"
          : "image/png";
  return {
    data: fs.readFileSync(assetPath),
    contentType,
  };
}

export function writeAtlasGeneratedAsset(relativePath: string, data: Buffer): string {
  const safePath = relativePath
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
  if (!safePath) {
    throw new Error("Atlas generated asset path is required.");
  }
  const assetPath = path.join(defaultArtifactRoot(), safePath);
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, data);
  return assetPath;
}

function cleanAtlasAssetKey(relativePath: string): string {
  return relativePath
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

export async function upsertAtlasAsset({
  assetKey,
  editionDate,
  editionType,
  windowHours,
  articleSlug = null,
  assetKind,
  status,
  prompt = null,
  contentType = null,
  assetBytes = null,
  storageUrl = null,
  publicPath = null,
  provider = null,
  model = null,
  error = null,
  metadata = {},
}: {
  assetKey: string;
  editionDate: string;
  editionType: AtlasPublishEditionType;
  windowHours: number;
  articleSlug?: string | null;
  assetKind: AtlasAssetKind;
  status: AtlasAssetStatus;
  prompt?: string | null;
  contentType?: string | null;
  assetBytes?: Buffer | null;
  storageUrl?: string | null;
  publicPath?: string | null;
  provider?: string | null;
  model?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AtlasAssetRecord | null> {
  const pool = getAtlasPool();
  if (!pool) return null;
  await ensureAtlasPublishSchema(pool);
  const safeAssetKey = cleanAtlasAssetKey(assetKey);
  if (!safeAssetKey) {
    throw new Error("Atlas asset key is required.");
  }
  const { rows } = await pool.query(
    `INSERT INTO atlas_assets
       (asset_key, edition_date, edition_type, window_hours, article_slug, asset_kind,
        status, prompt, content_type, asset_bytes, storage_url, public_path, provider,
        model, error, metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, now())
     ON CONFLICT (asset_key) DO UPDATE SET
       edition_date = EXCLUDED.edition_date,
       edition_type = EXCLUDED.edition_type,
       window_hours = EXCLUDED.window_hours,
       article_slug = EXCLUDED.article_slug,
       asset_kind = EXCLUDED.asset_kind,
       status = EXCLUDED.status,
       prompt = EXCLUDED.prompt,
       content_type = EXCLUDED.content_type,
       asset_bytes = EXCLUDED.asset_bytes,
       storage_url = EXCLUDED.storage_url,
       public_path = EXCLUDED.public_path,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       error = EXCLUDED.error,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING asset_key, status, public_path, content_type`,
    [
      safeAssetKey,
      editionDate,
      editionType,
      windowHours,
      articleSlug,
      assetKind,
      status,
      prompt,
      contentType,
      assetBytes,
      storageUrl,
      publicPath,
      provider,
      model,
      error,
      JSON.stringify(metadata),
    ],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    asset_key: String(row.asset_key),
    status: row.status === "ready" || row.status === "failed" || row.status === "skipped" ? row.status : "pending",
    public_path: row.public_path ? String(row.public_path) : null,
    content_type: row.content_type ? String(row.content_type) : null,
  };
}

export async function readAtlasStoredAsset(relativePath: string): Promise<{ data: Buffer; contentType: string } | null> {
  const pool = getAtlasPool();
  if (!pool) return null;
  await ensureAtlasPublishSchema(pool);
  const assetKey = cleanAtlasAssetKey(relativePath);
  if (!assetKey) return null;
  const { rows } = await pool.query(
    `SELECT asset_bytes, content_type
     FROM atlas_assets
     WHERE asset_key = $1
       AND status = 'ready'
       AND asset_bytes IS NOT NULL
     LIMIT 1`,
    [assetKey],
  );
  const row = rows[0];
  if (!row?.asset_bytes) return null;
  return {
    data: Buffer.isBuffer(row.asset_bytes) ? row.asset_bytes : Buffer.from(row.asset_bytes),
    contentType: String(row.content_type || "image/png"),
  };
}

function readAtlasArtifactFromFile(
  windowHours: number,
  editionDate?: string,
  editionType = editionTypeForWindow(windowHours),
): AtlasArtifactPayload | null {
  const artifactPath = editionDate
    ? atlasEditionArtifactDirs()
      .map((dir) => path.join(dir, `${editionDate}-${editionType}-${windowHours}.json`))
      .find((candidate) => fs.existsSync(candidate))
    : process.env.VIBEZ_ATLAS_ARTIFACT_PATH
      ? atlasArtifactPath(windowHours)
      : atlasArtifactCandidates(windowHours).find((candidate) => fs.existsSync(candidate));
  if (!artifactPath) {
    if (!editionDate) return null;
    const latest = readAtlasArtifactFromFile(windowHours, undefined, editionType);
    return latest?.editorial_report.issue.date === editionDate ? latest : null;
  }
  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as AtlasArtifactPayload;
  if (payload.artifact?.window_hours !== windowHours) return null;
  if (editionDate && payload.editorial_report?.issue.date !== editionDate) return null;
  if (!payload.atlas || !payload.editorial_report) return null;
  return payload;
}

export async function readAtlasArtifact(
  windowHours: number,
  editionDate?: string,
  editionType = editionTypeForWindow(windowHours),
): Promise<AtlasArtifactPayload | null> {
  const pool = getAtlasPool();
  if (pool) {
    try {
      await ensureAtlasEditionSchema(pool);
      const { rows } = editionDate
        ? await pool.query(
          `SELECT payload
           FROM atlas_editions
           WHERE edition_date = $1 AND edition_type = $2
           LIMIT 1`,
          [editionDate, editionType],
        )
        : await pool.query(
          `SELECT payload
           FROM atlas_editions
           WHERE window_hours = $1 AND edition_type = $2
           ORDER BY publication_time DESC
           LIMIT 1`,
          [windowHours, editionType],
        );
      const payload = rows[0]?.payload as AtlasArtifactPayload | undefined;
      if (payload?.atlas && payload.editorial_report) return payload;
    } catch (error) {
      console.error("readAtlasArtifact postgres lookup failed:", error);
    }
  }
  return readAtlasArtifactFromFile(windowHours, editionDate, editionType);
}

export async function startAtlasPublishJob({
  jobId,
  editionDate,
  editionType,
  windowHours,
  sourceWindowStart = null,
  sourceWindowEnd = null,
}: {
  jobId?: string;
  editionDate: string;
  editionType: AtlasPublishEditionType;
  windowHours: number;
  sourceWindowStart?: string | null;
  sourceWindowEnd?: string | null;
}): Promise<AtlasPublishJob | null> {
  const pool = getAtlasPool();
  if (!pool) return null;
  await ensureAtlasPublishSchema(pool);
  const id = jobId || `atlas-${editionType}-${editionDate}-${windowHours}-${randomUUID()}`;
  await pool.query(
    `INSERT INTO atlas_publish_jobs
       (id, edition_date, edition_type, window_hours, source_window_start, source_window_end,
        status, stage_status, stage_errors, retry_count, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', '{}'::jsonb, '{}'::jsonb, 0, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       edition_date = EXCLUDED.edition_date,
       edition_type = EXCLUDED.edition_type,
       window_hours = EXCLUDED.window_hours,
       source_window_start = EXCLUDED.source_window_start,
       source_window_end = EXCLUDED.source_window_end,
       status = 'running',
       retry_count = atlas_publish_jobs.retry_count + 1,
       updated_at = now()`,
    [id, editionDate, editionType, windowHours, sourceWindowStart, sourceWindowEnd],
  );
  return {
    id,
    edition_date: editionDate,
    edition_type: editionType,
    window_hours: windowHours,
    status: "running",
  };
}

export async function updateAtlasPublishStage({
  jobId,
  stage,
  status,
  error,
}: {
  jobId: string | null | undefined;
  stage: AtlasPublishStage;
  status: AtlasPublishStageStatus;
  error?: string | null;
}): Promise<void> {
  if (!jobId) return;
  const pool = getAtlasPool();
  if (!pool) return;
  await ensureAtlasPublishSchema(pool);
  const overallStatus: AtlasPublishJobStatus = status === "failed"
    ? "failed"
    : status === "succeeded" && stage === "publish"
      ? "succeeded"
      : "running";
  await pool.query(
    `UPDATE atlas_publish_jobs
     SET stage_status = stage_status || $2::jsonb,
         stage_errors = CASE
           WHEN $3::jsonb = '{}'::jsonb THEN stage_errors - $4
           ELSE stage_errors || $3::jsonb
         END,
         status = $5,
         completed_at = CASE WHEN $5 IN ('succeeded', 'failed') THEN now() ELSE completed_at END,
         updated_at = now()
     WHERE id = $1`,
    [
      jobId,
      JSON.stringify({ [stage]: status }),
      error ? JSON.stringify({ [stage]: error }) : JSON.stringify({}),
      stage,
      overallStatus,
    ],
  );
}

export async function listAtlasEditions({
  windowHours = 48,
  limit = 14,
  includeAllTypes = false,
}: {
  windowHours?: number;
  limit?: number;
  includeAllTypes?: boolean;
} = {}): Promise<AtlasEditionSummary[]> {
  const editionType = editionTypeForWindow(windowHours);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 60);
  const pool = getAtlasPool();
  if (pool) {
    try {
      await ensureAtlasEditionSchema(pool);
      const { rows } = await pool.query(
        `SELECT
           edition_date,
           edition_type,
           window_hours,
           publication_time,
           payload #>> '{editorial_report,issue,title}' AS title,
           payload #>> '{editorial_report,issue,subtitle}' AS subtitle,
           payload #>> '{editorial_report,issue,edition_label}' AS edition_label
         FROM atlas_editions
         ${includeAllTypes ? "" : "WHERE window_hours = $1 AND edition_type = $2"}
         ORDER BY publication_time DESC
         LIMIT $${includeAllTypes ? "1" : "3"}`,
        includeAllTypes ? [safeLimit] : [windowHours, editionType, safeLimit],
      );
      return rows.map((row) => ({
        date: String(row.edition_date),
        type: row.edition_type === "sunday_review" ? "sunday_review" : "daily",
        window_hours: Number(row.window_hours) || windowHours,
        publication_time: String(row.publication_time),
        title: String(row.title || "The Vibez Atlas"),
        subtitle: String(row.subtitle || ""),
        edition_label: editionLabelFor(row.edition_type === "sunday_review" ? "sunday_review" : "daily", row.edition_label),
        href: atlasEditionHref(String(row.edition_date), Number(row.window_hours) || windowHours),
      }));
    } catch (error) {
      console.error("listAtlasEditions postgres lookup failed:", error);
    }
  }

  if (includeAllTypes) {
    const editions = listAtlasEditionArtifacts()
      .sort(compareAtlasEditionsNewestFirst);
    return editions.slice(0, safeLimit);
  }

  const editions = listAtlasEditionArtifacts()
    .filter((edition) => edition.window_hours === windowHours && edition.type === editionType)
    .sort(compareAtlasEditionsNewestFirst);
  if (editions.length) return editions.slice(0, safeLimit);

  const artifact = readAtlasArtifactFromFile(windowHours);
  if (!artifact) return [];
  return [editionSummaryFromArtifact(artifact, windowHours, editionType)];
}

function listAtlasEditionArtifacts(): AtlasEditionSummary[] {
  const summaries = new Map<string, AtlasEditionSummary>();
  for (const dir of atlasEditionArtifactDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const artifactPath = path.join(dir, entry);
      try {
        const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as AtlasArtifactPayload;
        if (!payload.atlas || !payload.editorial_report) continue;
        const hours = Number(payload.artifact?.window_hours) || payload.atlas.window.hours || 48;
        const type = editionTypeForWindow(hours);
        const summary = editionSummaryFromArtifact(payload, hours, type);
        summaries.set(`${summary.date}:${summary.type}:${summary.window_hours}`, summary);
      } catch {
        continue;
      }
    }
  }
  return Array.from(summaries.values());
}

function editionSummaryFromArtifact(
  artifact: AtlasArtifactPayload,
  windowHours: number,
  editionType: AtlasPublishEditionType,
): AtlasEditionSummary {
  const date = artifact.editorial_report.issue.date || artifact.atlas.window.end.slice(0, 10);
  return {
    date,
    type: editionType,
    window_hours: windowHours,
    publication_time: artifact.artifact.generated_at,
    title: artifact.editorial_report.issue.title || "The Vibez Atlas",
    subtitle: artifact.editorial_report.issue.subtitle || "",
    edition_label: editionLabelFor(editionType, artifact.editorial_report.issue.edition_label),
    href: atlasEditionHref(date, windowHours),
  };
}

function compareAtlasEditionsNewestFirst(a: AtlasEditionSummary, b: AtlasEditionSummary): number {
  return (
    b.publication_time.localeCompare(a.publication_time) ||
    b.date.localeCompare(a.date) ||
    b.window_hours - a.window_hours
  );
}

export async function writeAtlasArtifact({
  windowHours,
  atlas,
  editorialReport,
}: {
  windowHours: number;
  atlas: AtlasSnapshot;
  editorialReport: AtlasEditorialReport;
}): Promise<string> {
  const artifactPath = atlasArtifactPath(windowHours);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const payload: AtlasArtifactPayload = {
    atlas,
    editorial_report: editorialReport,
    editorial_error: null,
    artifact: {
      generated_at: new Date().toISOString(),
      window_hours: windowHours,
      source: "configured_model_route",
    },
  };
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`);
  const editionType = editionTypeForWindow(windowHours);
  const editionPath = atlasEditionArtifactPath(
    windowHours,
    editorialReport.issue.date || atlas.window.end.slice(0, 10),
    editionType,
  );
  fs.mkdirSync(path.dirname(editionPath), { recursive: true });
  fs.writeFileSync(editionPath, `${JSON.stringify(payload, null, 2)}\n`);
  const pool = getAtlasPool();
  if (pool) {
    try {
      await ensureAtlasEditionSchema(pool);
      await pool.query(
        `INSERT INTO atlas_editions
         (edition_date, edition_type, window_hours, publication_time, payload, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now())
         ON CONFLICT (edition_date, edition_type) DO UPDATE SET
           window_hours = EXCLUDED.window_hours,
           publication_time = EXCLUDED.publication_time,
           payload = EXCLUDED.payload,
           updated_at = now()`,
        [
          editorialReport.issue.date,
          editionType,
          windowHours,
          payload.artifact.generated_at,
          JSON.stringify(payload),
        ],
      );
    } catch (error) {
      console.error("writeAtlasArtifact postgres archive failed:", error);
    }
  }
  return artifactPath;
}
