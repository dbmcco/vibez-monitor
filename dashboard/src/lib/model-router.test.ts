import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { getRoute, loadRoutes, resolveProviderApiKey } from "./model-router";

const ORIGINAL_ENV = process.env;

describe("model-router", () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test("loads the shared routing manifest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "embedding.semantic": {
            provider: "openai",
            model: "text-embedding-3-small",
            mode: "embedding",
            max_tokens: 0,
            temperature: 0,
            timeout_ms: 30000,
            dimensions: 256,
          },
          "chat.interactive": {
            provider: "openai",
            model: "gpt-5.1",
            mode: "text",
            max_tokens: 1024,
            temperature: 0.2,
            timeout_ms: 60000,
          },
        },
      }),
    );

    const routes = loadRoutes(manifestPath);

    expect(routes["chat.interactive"]).toMatchObject({
      provider: "openai",
      model: "gpt-5.1",
      mode: "text",
    });
    expect(routes["embedding.semantic"]).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      mode: "embedding",
      dimensions: 256,
    });
  });

  test("throws on unknown task ids", () => {
    expect(() => getRoute("dashboard.catchup", {})).toThrow(
      "unknown model route: dashboard.catchup",
    );
  });

  test("resolves Vibez provider keys before legacy provider keys", () => {
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_OPENAI_API_KEY: "vibez-openai-test-key",
      OPENAI_API_KEY: "legacy-openai-test-key",
    };

    expect(resolveProviderApiKey("openai")).toBe("vibez-openai-test-key");
  });

  test("falls back to legacy provider keys", () => {
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_OPENROUTER_API_KEY: "",
      OPENROUTER_API_KEY: "legacy-openrouter-test-key",
    };

    expect(resolveProviderApiKey("openrouter")).toBe("legacy-openrouter-test-key");
  });
});
