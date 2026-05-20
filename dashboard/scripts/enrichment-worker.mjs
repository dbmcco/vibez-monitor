#!/usr/bin/env node
import pg from "pg";

const { Pool } = pg;

const enabled = process.env.VIBEZ_ENRICH_WORKER_ENABLED === "1";
const port = process.env.PORT || "3000";
const baseUrl = process.env.VIBEZ_ENRICH_WORKER_BASE_URL || `http://127.0.0.1:${port}`;
const pushKey = process.env.VIBEZ_PUSH_API_KEY || "";
const pollIntervalMs = Number.parseInt(process.env.VIBEZ_ENRICH_WORKER_POLL_INTERVAL_MS || "10000", 10);
const startupDelayMs = Number.parseInt(process.env.VIBEZ_ENRICH_WORKER_STARTUP_DELAY_MS || "5000", 10);
const connectionString = process.env.VIBEZ_DATABASE_URL || process.env.DATABASE_URL || process.env.VIBEZ_PGVECTOR_URL || "";

function readIntEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
}

async function ensureAtlasPublishSchema(pool) {
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
}

async function nextQueuedJob(pool) {
  const result = await pool.query(
    `SELECT id, window_hours
     FROM atlas_publish_jobs
     WHERE status = 'running'
       AND stage_status = '{}'::jsonb
     ORDER BY started_at ASC
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function runJob(job) {
  const body = {
    rebuildAtlas: true,
    atlasHours: Number(job.window_hours) || 48,
    publishJobId: job.id,
    prestartedPublishJob: true,
  };
  const classifyLimit = readIntEnv("VIBEZ_DAILY_CLASSIFY_LIMIT");
  const messageEmbeddingLimit = readIntEnv("VIBEZ_DAILY_MESSAGE_EMBEDDING_LIMIT");
  const linkEmbeddingLimit = readIntEnv("VIBEZ_DAILY_LINK_EMBEDDING_LIMIT");
  if (classifyLimit !== undefined) body.classifyLimit = classifyLimit;
  if (messageEmbeddingLimit !== undefined) body.messageEmbeddingLimit = messageEmbeddingLimit;
  if (linkEmbeddingLimit !== undefined) body.linkEmbeddingLimit = linkEmbeddingLimit;

  const response = await fetch(`${baseUrl}/api/admin/enrich`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vibez-push-key": pushKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`enrichment job ${job.id} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

async function main() {
  if (!enabled) {
    console.log(`${now()} enrichment worker disabled`);
    return;
  }
  if (!connectionString) {
    console.error(`${now()} enrichment worker missing Postgres connection string`);
    process.exit(1);
  }
  if (!pushKey) {
    console.error(`${now()} enrichment worker missing VIBEZ_PUSH_API_KEY`);
    process.exit(1);
  }

  await sleep(Math.max(startupDelayMs, 0));
  const pool = new Pool({ connectionString, max: 2, idleTimeoutMillis: 10_000 });
  await ensureAtlasPublishSchema(pool);
  console.log(`${now()} enrichment worker started`);

  for (;;) {
    try {
      const job = await nextQueuedJob(pool);
      if (!job) {
        await sleep(Math.max(pollIntervalMs, 1000));
        continue;
      }
      console.log(`${now()} enrichment worker claiming ${job.id}`);
      await runJob(job);
      console.log(`${now()} enrichment worker completed ${job.id}`);
    } catch (error) {
      console.error(`${now()} enrichment worker error`, error);
      await sleep(Math.max(pollIntervalMs, 1000));
    }
  }
}

main().catch((error) => {
  console.error(`${now()} enrichment worker crashed`, error);
  process.exit(1);
});
