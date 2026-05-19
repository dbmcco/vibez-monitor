#!/usr/bin/env node
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.VIBEZ_LOCAL_APP_URL || "http://localhost:3102";
const accessCode = process.env.VIBEZ_ACCESS_CODE || "";
const pushKey = process.env.VIBEZ_PUSH_API_KEY || "";
const hours = Number.parseInt(process.argv[2] || process.env.VIBEZ_ATLAS_HOURS || "48", 10);
const pollIntervalMs = Number.parseInt(process.env.VIBEZ_ENRICH_POLL_INTERVAL_MS || "5000", 10);
const pollTimeoutMs = Number.parseInt(process.env.VIBEZ_ENRICH_POLL_TIMEOUT_MS || "2700000", 10);

function readIntEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requestJson(url, options = {}, body) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: options.method || "GET",
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...(options.headers || {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`non-json response ${response.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          resolve({ status: response.statusCode, headers: response.headers, json });
        });
      },
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (!pushKey.trim()) {
  console.error("VIBEZ_PUSH_API_KEY is required for Railway enrichment.");
  process.exit(1);
}

let cookie = "";
if (accessCode.trim()) {
  const auth = await requestJson(`${baseUrl}/api/access`, { method: "POST" }, { code: accessCode });
  cookie = auth.headers["set-cookie"]?.map((value) => value.split(";")[0]).join("; ") || "";
}

const rebuildAtlas = process.env.VIBEZ_DAILY_REFRESH_ATLAS !== "0";
const useAsync = rebuildAtlas && process.env.VIBEZ_ENRICH_ASYNC !== "0";
const payload = {
  rebuildAtlas,
  atlasHours: hours,
  ...(useAsync ? { async: true } : {}),
};
const classifyLimit = readIntEnv("VIBEZ_DAILY_CLASSIFY_LIMIT");
const messageEmbeddingLimit = readIntEnv("VIBEZ_DAILY_MESSAGE_EMBEDDING_LIMIT");
const linkEmbeddingLimit = readIntEnv("VIBEZ_DAILY_LINK_EMBEDDING_LIMIT");
if (classifyLimit !== undefined) payload.classifyLimit = classifyLimit;
if (messageEmbeddingLimit !== undefined) payload.messageEmbeddingLimit = messageEmbeddingLimit;
if (linkEmbeddingLimit !== undefined) payload.linkEmbeddingLimit = linkEmbeddingLimit;

const headers = {
  "x-vibez-push-key": pushKey,
  ...(cookie ? { cookie } : {}),
};
const result = await requestJson(
  `${baseUrl}/api/admin/enrich`,
  { method: "POST", headers },
  payload,
);

if (result.status !== 200 || !result.json?.ok) {
  console.error(JSON.stringify(result.json, null, 2));
  process.exit(1);
}

if (result.json?.mode === "async") {
  const jobId = result.json.job?.id;
  if (!jobId) {
    console.error(JSON.stringify(result.json, null, 2));
    process.exit(1);
  }

  const startedAt = Date.now();
  let latest = result.json.job;
  while (Date.now() - startedAt < pollTimeoutMs) {
    await sleep(Math.max(pollIntervalMs, 1000));
    const status = await requestJson(
      `${baseUrl}/api/admin/enrich?jobId=${encodeURIComponent(jobId)}`,
      { method: "GET", headers },
    );
    if (status.status !== 200 || !status.json?.ok) {
      console.error(JSON.stringify(status.json, null, 2));
      process.exit(1);
    }
    latest = status.json.job;
    const stageSummary = latest.stage_status || {};
    console.log(JSON.stringify({
      ok: true,
      mode: "async",
      job_id: jobId,
      status: latest.status,
      stage_summary: stageSummary,
      updated_at: latest.updated_at || null,
    }, null, 2));
    if (latest.status === "succeeded") {
      process.exit(0);
    }
    if (latest.status === "failed") {
      console.error(JSON.stringify({
        ok: false,
        job_id: jobId,
        status: latest.status,
        stage_summary: latest.stage_status || {},
        stage_errors: latest.stage_errors || {},
      }, null, 2));
      process.exit(1);
    }
  }
  console.error(JSON.stringify({
    ok: false,
    error: "Timed out waiting for enrichment job.",
    job_id: jobId,
    status: latest?.status || "unknown",
    stage_summary: latest?.stage_status || {},
  }, null, 2));
  process.exit(1);
}

const atlas = result.json.atlas || {};
const summary = {
  ok: true,
  classifications_written: result.json.classifications_written,
  message_embeddings_written: result.json.message_embeddings_written,
  link_embeddings_written: result.json.link_embeddings_written,
  atlas: {
    rebuilt: Boolean(atlas.rebuilt),
    publish_job_id: atlas.publish_job_id || null,
    edition_date: atlas.edition_date || null,
    edition_type: atlas.edition_type || null,
    window_hours: atlas.window_hours || hours,
    published_at: atlas.published_at || null,
    artifact_path: atlas.artifact_path || null,
    articles: atlas.articles || 0,
    stage_summary: atlas.stage_summary || {},
    skipped_reason: atlas.skipped_reason || null,
  },
};

console.log(JSON.stringify(summary, null, 2));
