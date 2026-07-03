#!/usr/bin/env node
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.VIBEZ_LOCAL_APP_URL || "http://localhost:3102";
const hours = Number.parseInt(process.argv[2] || process.env.VIBEZ_ATLAS_HOURS || "48", 10);
const accessCode = process.env.VIBEZ_ACCESS_CODE || "";

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

const auth = await requestJson(`${baseUrl}/api/access`, { method: "POST" }, { code: accessCode });
const cookie = auth.headers["set-cookie"]?.map((value) => value.split(";")[0]).join("; ") || "";
const result = await requestJson(
  `${baseUrl}/api/admin/atlas-artifact`,
  { method: "POST", headers: cookie ? { cookie } : {} },
  { hours },
);

if (result.status !== 200 || !result.json?.ok) {
  console.error(JSON.stringify(result.json, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result.json, null, 2));
