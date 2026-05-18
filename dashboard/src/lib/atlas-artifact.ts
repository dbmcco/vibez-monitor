import fs from "node:fs";
import path from "node:path";
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

let atlasPool: Pool | null = null;

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

function editionTypeForWindow(windowHours: number): "daily" | "sunday_review" {
  return windowHours >= 120 ? "sunday_review" : "daily";
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

function readAtlasArtifactFromFile(windowHours: number): AtlasArtifactPayload | null {
  const artifactPath = process.env.VIBEZ_ATLAS_ARTIFACT_PATH
    ? atlasArtifactPath(windowHours)
    : atlasArtifactCandidates(windowHours).find((candidate) => fs.existsSync(candidate));
  if (!artifactPath) return null;
  const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as AtlasArtifactPayload;
  if (payload.artifact?.window_hours !== windowHours) return null;
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
  return readAtlasArtifactFromFile(windowHours);
}

export async function listAtlasEditions({
  windowHours = 48,
  limit = 14,
}: {
  windowHours?: number;
  limit?: number;
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
         WHERE window_hours = $1 AND edition_type = $2
         ORDER BY publication_time DESC
         LIMIT $3`,
        [windowHours, editionType, safeLimit],
      );
      return rows.map((row) => ({
        date: String(row.edition_date),
        type: row.edition_type === "sunday_review" ? "sunday_review" : "daily",
        window_hours: Number(row.window_hours) || windowHours,
        publication_time: String(row.publication_time),
        title: String(row.title || "The Vibez Atlas"),
        subtitle: String(row.subtitle || ""),
        edition_label: String(row.edition_label || (editionType === "sunday_review" ? "Sunday Edition" : "Daily Edition")),
        href: atlasEditionHref(String(row.edition_date), Number(row.window_hours) || windowHours),
      }));
    } catch (error) {
      console.error("listAtlasEditions postgres lookup failed:", error);
    }
  }

  const artifact = readAtlasArtifactFromFile(windowHours);
  if (!artifact) return [];
  const date = artifact.editorial_report.issue.date || artifact.atlas.window.end.slice(0, 10);
  return [{
    date,
    type: editionType,
    window_hours: windowHours,
    publication_time: artifact.artifact.generated_at,
    title: artifact.editorial_report.issue.title || "The Vibez Atlas",
    subtitle: artifact.editorial_report.issue.subtitle || "",
    edition_label: artifact.editorial_report.issue.edition_label || (editionType === "sunday_review" ? "Sunday Edition" : "Daily Edition"),
    href: atlasEditionHref(date, windowHours),
  }];
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
  const pool = getAtlasPool();
  if (pool) {
    try {
      await ensureAtlasEditionSchema(pool);
      const editionType = editionTypeForWindow(windowHours);
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
