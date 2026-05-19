import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { embedTexts, getRoute, loadRoutes, resolveProviderApiKey } from "./model-router";

const ORIGINAL_ENV = process.env;

describe("model-router", () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
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

  test("resolves a Vibez model route from the central cognition registry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    const registryPath = path.join(dir, "cognition-presets.toml");
    fs.writeFileSync(
      registryPath,
      [
        "[credentials.vibez_openrouter]",
        'provider = "openrouter"',
        'source = "env"',
        'env_var = "VIBEZ_OPENROUTER_API_KEY"',
        "",
        "[provider_surfaces.openrouter_embedding]",
        'provider = "openrouter"',
        'base_url = "https://openrouter.ai/api/v1"',
        'api_key_env = "OPENROUTER_API_KEY"',
        "complete_timeout_seconds = 60",
        "",
        '[service_credential_assignments."vibez-monitor"]',
        'openrouter = "vibez_openrouter"',
        "",
        '[model_routes."vibez.embedding_fast"]',
        'surface = "openrouter_embedding"',
        'provider = "openrouter"',
        'model = "perplexity/pplx-embed-v1-0.6b"',
        'mode = "embedding"',
        'quality_tier = "embedding_fast"',
        "request_timeout_seconds = 45",
      ].join("\n"),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "embedding.semantic": {
            registry_route: "vibez.embedding_fast",
            dimensions: 256,
          },
        },
      }),
    );
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_COGNITION_PRESETS_PATH: registryPath,
    };

    const routes = loadRoutes(manifestPath);

    expect(routes["embedding.semantic"]).toMatchObject({
      provider: "openrouter",
      model: "perplexity/pplx-embed-v1-0.6b",
      mode: "embedding",
      base_url: "https://openrouter.ai/api/v1",
      api_key_env: "VIBEZ_OPENROUTER_API_KEY",
      timeout_ms: 45000,
      dimensions: 256,
    });
  });

  test("embeds with OpenRouter and validates dimensions locally", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "embedding.semantic": {
            provider: "openrouter",
            model: "perplexity/pplx-embed-v1-0.6b",
            mode: "embedding",
            base_url: "https://openrouter.ai/api/v1",
            api_key_env: "VIBEZ_OPENROUTER_API_KEY",
            max_tokens: 0,
            temperature: 0,
            timeout_ms: 30000,
            dimensions: 2,
          },
        },
      }),
    );
    process.env = {
      ...ORIGINAL_ENV,
      VIBEZ_OPENROUTER_API_KEY: "test-openrouter-key",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: [3, 4, 12], index: 0, object: "embedding" }],
          model: "perplexity/pplx-embed-v1-0.6b",
          object: "list",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedTexts({
      taskId: "embedding.semantic",
      inputs: ["Channel: intros\nMessage: hello"],
      manifestPath,
    });

    expect(result).toMatchObject({
      provider: "openrouter",
      model: "perplexity/pplx-embed-v1-0.6b",
    });
    expect(result.vectors).toEqual([[0.6, 0.8]]);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/embeddings");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      model: "perplexity/pplx-embed-v1-0.6b",
      input: ["Channel: intros\nMessage: hello"],
      encoding_format: "float",
    });
    expect(body).not.toHaveProperty("dimensions");
  });

  test("asks Ollama to truncate oversized embedding inputs at the model boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-"));
    const manifestPath = path.join(dir, "model-routing.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        routes: {
          "embedding.semantic": {
            provider: "ollama",
            model: "mxbai-embed-large:latest",
            mode: "embedding",
            max_tokens: 0,
            temperature: 0,
            timeout_ms: 30000,
            dimensions: 64,
          },
        },
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [new Array<number>(64).fill(0.25)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await embedTexts({
      taskId: "embedding.semantic",
      inputs: ["x".repeat(20_000)],
      dimensions: 64,
      manifestPath,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toMatchObject({
      model: "mxbai-embed-large:latest",
      truncate: true,
    });
    expect(body.input[0].length).toBeLessThanOrEqual(1600);
  });
});
