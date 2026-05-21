#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";

const baseUrl = (process.env.VIBEZ_LOCAL_APP_URL || process.env.VIBEZ_REMOTE_URL || "http://localhost:3100").replace(/\/$/, "");
const hours = Number.parseInt(process.argv[2] || process.env.VIBEZ_ATLAS_HOURS || "48", 10);
const accessCode = process.env.VIBEZ_ACCESS_CODE || process.env.VIBEZ_ATLAS_UX_ACCESS_CODE || "";
const expectedArticles = Number.parseInt(process.env.VIBEZ_ATLAS_EXPECTED_ARTICLES || "5", 10);
const maxImageBytes = Number.parseInt(process.env.VIBEZ_ATLAS_MAX_IMAGE_BYTES || "350000", 10);
const minImageBytes = Number.parseInt(process.env.VIBEZ_ATLAS_MIN_IMAGE_BYTES || "10000", 10);
const requireToday = process.env.VIBEZ_ATLAS_REQUIRE_TODAY !== "0";
const runUxCheck = process.env.VIBEZ_ATLAS_RUN_UX_CHECK !== "0";

function fail(message, detail = undefined) {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2));
  process.exit(1);
}

function request(url, options = {}, body) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = transport.request(
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
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error(`request timed out: ${url}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestJson(url, options = {}, body) {
  const response = await request(url, options, body);
  let json = null;
  try {
    json = response.body.length ? JSON.parse(response.body.toString("utf8")) : null;
  } catch {
    fail(`non-json response from ${url}`, {
      status: response.status,
      body: response.body.toString("utf8").slice(0, 500),
    });
  }
  return { ...response, json };
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function imageKeyLooksVersioned(key) {
  return /-\d{14}\.webp$/.test(String(key || ""));
}

let cookie = "";
if (accessCode.trim()) {
  const auth = await requestJson(`${baseUrl}/api/access`, { method: "POST" }, { code: accessCode });
  if (auth.status !== 200 || !auth.json?.ok) {
    fail("access authentication failed", { status: auth.status, body: auth.json });
  }
  cookie = auth.headers["set-cookie"]?.map((value) => value.split(";")[0]).join("; ") || "";
}

const headers = cookie ? { cookie } : {};
const atlasResponse = await requestJson(`${baseUrl}/api/atlas?hours=${hours}`, { headers });
if (atlasResponse.status !== 200) {
  fail("Atlas API did not return 200", { status: atlasResponse.status, body: atlasResponse.json });
}

const report = atlasResponse.json?.editorial_report;
const artifact = atlasResponse.json?.artifact;
const articles = Array.isArray(report?.articles) ? report.articles : [];
const issueDate = String(report?.issue?.date || "");
if (!report || articles.length === 0) {
  fail("Atlas editorial report is missing articles");
}
if (articles.length !== expectedArticles) {
  fail("Atlas article count mismatch", { expected: expectedArticles, actual: articles.length });
}
if (requireToday && issueDate !== todayUtc()) {
  fail("Atlas issue date is stale", { expected: todayUtc(), actual: issueDate });
}

const imageResults = [];
for (const article of articles) {
  const image = article.image || {};
  if (image.status !== "ready") {
    fail("Article image is not ready", { slug: article.slug, image });
  }
  if (!image.url || !String(image.url).startsWith("/api/atlas/image/")) {
    fail("Article image URL is missing or invalid", { slug: article.slug, image });
  }
  if (!imageKeyLooksVersioned(image.asset_key)) {
    fail("Article image asset key is not versioned; browser may reuse stale immutable image", {
      slug: article.slug,
      asset_key: image.asset_key,
    });
  }
  const imageResponse = await request(`${baseUrl}${image.url}`, { headers });
  const contentType = String(imageResponse.headers["content-type"] || "");
  if (imageResponse.status !== 200) {
    fail("Article image fetch failed", { slug: article.slug, status: imageResponse.status, url: image.url });
  }
  if (!contentType.includes("image/webp")) {
    fail("Article image is not WebP", { slug: article.slug, contentType });
  }
  if (imageResponse.body.length < minImageBytes || imageResponse.body.length > maxImageBytes) {
    fail("Article image size is outside expected bounds", {
      slug: article.slug,
      bytes: imageResponse.body.length,
      minImageBytes,
      maxImageBytes,
    });
  }
  imageResults.push({
    slug: article.slug,
    bytes: imageResponse.body.length,
    asset_key: image.asset_key,
  });
}

if (runUxCheck) {
  const result = spawnSync(process.execPath, ["scripts/check-atlas-ux.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIBEZ_ATLAS_UX_URL: `${baseUrl}/atlas`,
      VIBEZ_ATLAS_UX_ACCESS_CODE: accessCode,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail("Atlas UX check failed", { status: result.status });
  }
}

console.log(JSON.stringify({
  ok: true,
  url: `${baseUrl}/atlas`,
  issue_date: issueDate,
  generated_at: artifact?.generated_at || null,
  articles: articles.length,
  images: imageResults,
}, null, 2));
