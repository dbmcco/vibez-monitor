#!/usr/bin/env node
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.VIBEZ_LOCAL_APP_URL || "http://localhost:3102";
const accessCode = process.env.VIBEZ_ACCESS_CODE || "";
const pushKey = process.env.VIBEZ_PUSH_API_KEY || "";
const hours = Number.parseInt(process.argv[2] || process.env.VIBEZ_ATLAS_HOURS || "48", 10);

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

if (!pushKey.trim()) {
  console.error("VIBEZ_PUSH_API_KEY is required for Railway enrichment.");
  process.exit(1);
}

let cookie = "";
if (accessCode.trim()) {
  const auth = await requestJson(`${baseUrl}/api/access`, { method: "POST" }, { code: accessCode });
  cookie = auth.headers["set-cookie"]?.map((value) => value.split(";")[0]).join("; ") || "";
}

const payload = {
  rebuildAtlas: process.env.VIBEZ_DAILY_REFRESH_ATLAS !== "0",
  atlasHours: hours,
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

console.log(JSON.stringify(result.json, null, 2));
