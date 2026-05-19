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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date().toISOString();
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
  const response = await fetch(`${baseUrl}/api/admin/enrich`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vibez-push-key": pushKey,
    },
    body: JSON.stringify({
      rebuildAtlas: true,
      atlasHours: Number(job.window_hours) || 48,
      publishJobId: job.id,
      prestartedPublishJob: true,
    }),
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
