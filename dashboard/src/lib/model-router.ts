import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface ModelRoute {
  provider: "openai" | "anthropic" | "openrouter" | "ollama" | "xai" | "atlascloud";
  model: string;
  mode: "text" | "json" | "embedding" | "image";
  max_tokens: number;
  temperature: number;
  timeout_ms: number;
  base_url?: string;
  api_key_env?: string;
  dimensions?: number;
  context_window?: number;
}

type ModelRouteManifestEntry =
  Partial<ModelRoute> & {
    registry_route?: string;
  };

interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelTextResult {
  text: string;
  model: string;
  provider: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ModelEmbeddingResult {
  vectors: number[][];
  model: string;
  provider: string;
}

export interface ModelImageResult {
  data: Buffer;
  contentType: string;
  model: string;
  provider: string;
}

const ROUTE_CACHE = new Map<string, Record<string, ModelRoute>>();
const REGISTRY_CACHE = new Map<string, Record<string, Record<string, string | number | boolean>>>();
const DEFAULT_OLLAMA_EMBEDDING_INPUT_MAX_CHARS = 1600;
const PROVIDER_CREDENTIAL_ENVS = {
  openai: ["VIBEZ_OPENAI_API_KEY", "OPENAI_API_KEY"],
  anthropic: ["VIBEZ_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  openrouter: ["VIBEZ_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
  xai: ["VIBEZ_XAI_API_KEY", "XAI_API_KEY"],
  atlascloud: ["VIBEZ_ATLASCLOUD_API_KEY", "ATLASCLOUD_API_KEY"],
} as const;
const ATLASCLOUD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function defaultManifestPath(): string {
  return process.env.VIBEZ_MODEL_ROUTING_PATH ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "..", "config", "model-routing.json");
}

function defaultCognitionRegistryPath(): string {
  if (process.env.VIBEZ_COGNITION_PRESETS_PATH) return process.env.VIBEZ_COGNITION_PRESETS_PATH;
  if (process.env.PAIA_COGNITION_PRESETS_PATH) return process.env.PAIA_COGNITION_PRESETS_PATH;
  const appConfigCandidate = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "..",
    "config",
    "cognition-presets.toml",
  );
  if (fs.existsSync(/* turbopackIgnore: true */ appConfigCandidate)) {
    return appConfigCandidate;
  }
  return "/Users/braydon/projects/experiments/paia-agent-runtime/config/cognition-presets.toml";
}

function resolveManifestPath(manifestPath = defaultManifestPath()): string {
  if (path.isAbsolute(manifestPath)) return manifestPath;
  const cwdCandidate = path.join(/* turbopackIgnore: true */ process.cwd(), manifestPath);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  return path.join(/* turbopackIgnore: true */ process.cwd(), "..", manifestPath);
}

function normalizeTomlTableName(rawName: string): string {
  return rawName.replace(/"([^"]+)"/g, "$1");
}

function parseTomlValue(rawValue: string): string | number | boolean {
  const withoutComment = rawValue.replace(/\s+#.*$/, "").trim();
  if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
    return withoutComment.slice(1, -1);
  }
  if (withoutComment === "true") return true;
  if (withoutComment === "false") return false;
  const numeric = Number(withoutComment);
  if (Number.isFinite(numeric)) return numeric;
  return withoutComment;
}

function loadCognitionRegistry(
  registryPath = defaultCognitionRegistryPath(),
): Record<string, Record<string, string | number | boolean>> {
  const cached = REGISTRY_CACHE.get(registryPath);
  if (cached) return cached;
  if (!fs.existsSync(/* turbopackIgnore: true */ registryPath)) {
    throw new Error(`cognition registry not found: ${registryPath}`);
  }
  const tables: Record<string, Record<string, string | number | boolean>> = {};
  let currentTable = "";
  for (const line of fs.readFileSync(/* turbopackIgnore: true */ registryPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      currentTable = normalizeTomlTableName(tableMatch[1]);
      tables[currentTable] = tables[currentTable] || {};
      continue;
    }
    if (!currentTable) continue;
    const assignment = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    tables[currentTable][assignment[1]] = parseTomlValue(assignment[2]);
  }
  REGISTRY_CACHE.set(registryPath, tables);
  return tables;
}

function numberFromRegistry(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringFromRegistry(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function routeModeFromRegistry(
  value: string | number | boolean | undefined,
): ModelRoute["mode"] | undefined {
  return value === "text" || value === "json" || value === "embedding" || value === "image" ? value : undefined;
}

function resolveRegistryCredentialEnv({
  provider,
  surface,
  registry,
}: {
  provider: ModelRoute["provider"];
  surface?: Record<string, string | number | boolean>;
  registry: Record<string, Record<string, string | number | boolean>>;
}): string | undefined {
  const assignment = registry['service_credential_assignments.vibez-monitor']?.[provider];
  const credentialAlias = stringFromRegistry(assignment);
  const credentialEnv = credentialAlias
    ? stringFromRegistry(registry[`credentials.${credentialAlias}`]?.env_var)
    : undefined;
  return credentialEnv || stringFromRegistry(surface?.api_key_env);
}

function resolveRegistryRoute(registryRouteId: string): Partial<ModelRoute> {
  const registry = loadCognitionRegistry();
  const route = registry[`model_routes.${registryRouteId}`];
  if (!route) {
    throw new Error(`unknown cognition registry route: ${registryRouteId}`);
  }
  const provider = stringFromRegistry(route.provider) as ModelRoute["provider"] | undefined;
  const surfaceName = stringFromRegistry(route.surface);
  const surface = surfaceName ? registry[`provider_surfaces.${surfaceName}`] : undefined;
  const timeoutSeconds =
    numberFromRegistry(route.request_timeout_seconds) ??
    numberFromRegistry(surface?.complete_timeout_seconds) ??
    numberFromRegistry(surface?.continue_timeout_seconds);

  return {
    provider,
    model: stringFromRegistry(route.model),
    mode: routeModeFromRegistry(route.mode),
    max_tokens: numberFromRegistry(route.max_tokens_default),
    temperature: numberFromRegistry(route.temperature_default),
    timeout_ms: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
    base_url: stringFromRegistry(surface?.base_url),
    api_key_env: provider ? resolveRegistryCredentialEnv({ provider, surface, registry }) : undefined,
    context_window: numberFromRegistry(route.context_window),
  };
}

function finalizeRoute(routeId: string, entry: ModelRouteManifestEntry): ModelRoute {
  const registryRoute = entry.registry_route ? resolveRegistryRoute(entry.registry_route) : {};
  const merged = {
    ...registryRoute,
    ...entry,
  };
  delete merged.registry_route;
  if (!merged.provider || !merged.model || !merged.mode) {
    throw new Error(`incomplete model route: ${routeId}`);
  }
  return {
    provider: merged.provider,
    model: merged.model,
    mode: merged.mode,
    max_tokens: merged.max_tokens ?? 0,
    temperature: merged.temperature ?? 0,
    timeout_ms: merged.timeout_ms ?? 60_000,
    base_url: merged.base_url,
    api_key_env: merged.api_key_env,
    dimensions: merged.dimensions,
    context_window: merged.context_window,
  };
}

export function loadRoutes(manifestPath = defaultManifestPath()): Record<string, ModelRoute> {
  const resolvedPath = resolveManifestPath(manifestPath);
  const cached = ROUTE_CACHE.get(resolvedPath);
  if (cached) return cached;
  const payload = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ resolvedPath, "utf8")) as {
    version: number;
    routes: Record<string, ModelRouteManifestEntry>;
  };
  if (payload.version !== 1 || !payload.routes || typeof payload.routes !== "object") {
    throw new Error("invalid model routing manifest");
  }
  const routes = Object.fromEntries(
    Object.entries(payload.routes).map(([routeId, entry]) => [routeId, finalizeRoute(routeId, entry)]),
  );
  ROUTE_CACHE.set(resolvedPath, routes);
  return routes;
}

export function getRoute(
  taskId: string,
  routes: Record<string, ModelRoute> = loadRoutes(),
): ModelRoute {
  const route = routes[taskId];
  if (!route) {
    throw new Error(`unknown model route: ${taskId}`);
  }
  return route;
}

export function resolveProviderApiKey(
  provider: keyof typeof PROVIDER_CREDENTIAL_ENVS,
): string {
  for (const envName of PROVIDER_CREDENTIAL_ENVS[provider]) {
    const value = process.env[envName];
    if (value) return value;
  }
  return "";
}

function resolveRouteApiKey(route: ModelRoute): string {
  if (route.api_key_env) {
    return process.env[route.api_key_env] || "";
  }
  if (route.provider in PROVIDER_CREDENTIAL_ENVS) {
    return resolveProviderApiKey(route.provider as keyof typeof PROVIDER_CREDENTIAL_ENVS);
  }
  return "";
}

function validateRouteRequirements(route: ModelRoute): void {
  if (route.provider in PROVIDER_CREDENTIAL_ENVS) {
    const provider = route.provider as keyof typeof PROVIDER_CREDENTIAL_ENVS;
    if (!resolveRouteApiKey(route)) {
      throw new Error(`${route.api_key_env || PROVIDER_CREDENTIAL_ENVS[provider][0]} not configured`);
    }
  }
  if (route.provider === "ollama") {
    return;
  }
}

function normalizeEmbeddingDimensions(
  vector: number[],
  dimensions?: number,
): number[] {
  if (!dimensions || dimensions <= 0 || vector.length === dimensions) {
    return vector.map((value) => Number(value));
  }
  if (vector.length < dimensions) {
    throw new Error(
      `embedding dimension mismatch: requested ${dimensions}, got ${vector.length}`,
    );
  }
  const shortened = vector.slice(0, dimensions).map((value) => Number(value));
  const norm = Math.sqrt(
    shortened.reduce((sum, value) => sum + value * value, 0),
  );
  if (norm <= 0) return shortened;
  return shortened.map((value) => value / norm);
}

function ollamaEmbeddingInputMaxChars(): number {
  const value = Number.parseInt(process.env.VIBEZ_OLLAMA_EMBEDDING_INPUT_MAX_CHARS || "", 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_OLLAMA_EMBEDDING_INPUT_MAX_CHARS;
  return Math.max(256, Math.min(value, 8000));
}

function normalizeOllamaEmbeddingInputs(inputs: string[]): string[] {
  const maxChars = ollamaEmbeddingInputMaxChars();
  return inputs.map((input) => String(input || "").slice(0, maxChars));
}

function buildMessages({
  prompt,
  system,
  messages,
}: {
  prompt?: string;
  system?: string;
  messages?: ModelMessage[];
}): ModelMessage[] {
  if (messages && messages.length > 0) {
    return messages;
  }
  if (!prompt) {
    throw new Error("prompt is required when messages are not supplied");
  }
  const payload: ModelMessage[] = [];
  if (system) payload.push({ role: "system", content: system });
  payload.push({ role: "user", content: prompt });
  return payload;
}

function usageFromAnthropic(usage: Anthropic.Messages.Usage | undefined) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
  };
}

function usageFromOpenAI(response: { usage?: { input_tokens?: number; output_tokens?: number } }) {
  return {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
}

function usageFromOpenAIChat(response: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}) {
  return {
    input_tokens: response.usage?.prompt_tokens ?? response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? response.usage?.output_tokens ?? 0,
  };
}

function parseJsonText(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return JSON.parse(fenced || trimmed);
}

async function runAnthropicRoute(
  route: ModelRoute,
  payload: ModelMessage[],
): Promise<ModelTextResult> {
  const system = payload
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages: Array<{ role: "user" | "assistant"; content: string }> = payload
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  const client = new Anthropic({ apiKey: resolveRouteApiKey(route) });
  const response = await client.messages.create({
    model: route.model,
    max_tokens: route.max_tokens,
    system: system || undefined,
    messages,
  });
  return {
    text: response.content
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim(),
    model: route.model,
    provider: route.provider,
    usage: usageFromAnthropic(response.usage),
  };
}

async function runOpenAIRoute(
  route: ModelRoute,
  payload: ModelMessage[],
): Promise<ModelTextResult> {
  const client = new OpenAI({
    apiKey: resolveRouteApiKey(route),
    timeout: route.timeout_ms,
  });
  const response = await client.responses.create({
    model: route.model,
    input: payload,
    max_output_tokens: route.max_tokens,
    temperature: route.temperature,
  });
  return {
    text: response.output_text || "",
    model: route.model,
    provider: route.provider,
    usage: usageFromOpenAI(response),
  };
}

async function runOpenRouterRoute(
  route: ModelRoute,
  payload: ModelMessage[],
): Promise<ModelTextResult> {
  if (!route.base_url) {
    throw new Error("openrouter base_url not configured");
  }
  const client = new OpenAI({
    apiKey: resolveRouteApiKey(route),
    baseURL: route.base_url,
    timeout: route.timeout_ms,
  });
  const response = await client.chat.completions.create({
    model: route.model,
    messages: payload,
    max_tokens: route.max_tokens,
    temperature: route.temperature,
    response_format: route.mode === "json" ? { type: "json_object" } : undefined,
  });
  return {
    text: response.choices[0]?.message?.content || "",
    model: route.model,
    provider: route.provider,
    usage: usageFromOpenAIChat(response),
  };
}

async function runOpenAIEmbeddingRoute(
  route: ModelRoute,
  inputs: string[],
  dimensions?: number,
): Promise<ModelEmbeddingResult> {
  const client = new OpenAI({
    apiKey: resolveRouteApiKey(route),
    timeout: route.timeout_ms,
  });
  const response = await client.embeddings.create({
    model: route.model,
    input: inputs,
    encoding_format: "float",
    dimensions: dimensions ?? route.dimensions,
  });
  return {
    vectors: response.data.map((item) =>
      normalizeEmbeddingDimensions(item.embedding as number[], dimensions ?? route.dimensions),
    ),
    model: route.model,
    provider: route.provider,
  };
}

async function runOpenRouterEmbeddingRoute(
  route: ModelRoute,
  inputs: string[],
  dimensions?: number,
): Promise<ModelEmbeddingResult> {
  if (!route.base_url) {
    throw new Error("openrouter base_url not configured");
  }
  const client = new OpenAI({
    apiKey: resolveRouteApiKey(route),
    baseURL: route.base_url,
    timeout: route.timeout_ms,
  });
  const response = await client.embeddings.create({
    model: route.model,
    input: inputs,
    encoding_format: "float",
  });
  return {
    vectors: response.data.map((item) =>
      normalizeEmbeddingDimensions(item.embedding as number[], dimensions ?? route.dimensions),
    ),
    model: route.model,
    provider: route.provider,
  };
}

async function runOpenAIImageRoute(
  route: ModelRoute,
  prompt: string,
): Promise<ModelImageResult> {
  const client = new OpenAI({
    apiKey: resolveRouteApiKey(route),
    baseURL: route.base_url,
    timeout: route.timeout_ms,
  });
  const response = await client.images.generate(
    route.provider === "xai"
      ? {
        model: route.model,
        prompt,
        n: 1,
      }
      : {
        model: route.model,
        prompt,
        n: 1,
        size: "1536x1024",
        quality: "medium",
        output_format: "png",
        moderation: "low",
      },
  );
  const image = response.data?.[0];
  if (image?.b64_json) {
    return {
      data: Buffer.from(image.b64_json, "base64"),
      contentType: "image/png",
      model: route.model,
      provider: route.provider,
    };
  }
  if (image?.url) {
    const fetched = await fetch(image.url, {
      signal: AbortSignal.timeout(route.timeout_ms),
    });
    if (!fetched.ok) {
      throw new Error(`image download failed: ${fetched.status}`);
    }
    return {
      data: Buffer.from(await fetched.arrayBuffer()),
      contentType: fetched.headers.get("content-type") || "image/png",
      model: route.model,
      provider: route.provider,
    };
  }
  throw new Error("image route returned no image data");
}

function atlasCloudBaseUrl(route: ModelRoute): string {
  return (route.base_url || "https://api.atlascloud.ai/api/v1").replace(/\/$/, "");
}

function atlasCloudImagePrompt(prompt: string): string {
  return prompt.slice(0, 800);
}

function atlasCloudPollIntervalMs(): number {
  const parsed = Number.parseInt(process.env.VIBEZ_ATLASCLOUD_POLL_INTERVAL_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 3000;
  return Math.min(parsed, 30_000);
}

async function readAtlasCloudJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`atlascloud returned non-json response: ${text.slice(0, 300)}`);
  }
}

function atlasCloudPredictionId(payload: Record<string, unknown>): string {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const id = data.id || payload.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`atlascloud submit returned no prediction id: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return id;
}

function atlasCloudPredictionData(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : payload;
}

async function runAtlasCloudImageRoute(
  route: ModelRoute,
  prompt: string,
): Promise<ModelImageResult> {
  const apiKey = resolveRouteApiKey(route);
  const baseUrl = atlasCloudBaseUrl(route);
  const submit = await fetch(`${baseUrl}/model/generateImage`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "user-agent": ATLASCLOUD_USER_AGENT,
    },
    signal: AbortSignal.timeout(route.timeout_ms),
    body: JSON.stringify({
      model: route.model,
      prompt: atlasCloudImagePrompt(prompt),
      seed: -1,
    }),
  });
  const submitPayload = await readAtlasCloudJson(submit);
  if (!submit.ok) {
    throw new Error(`atlascloud submit failed ${submit.status}: ${JSON.stringify(submitPayload).slice(0, 300)}`);
  }
  const predictionId = atlasCloudPredictionId(submitPayload);
  const deadline = Date.now() + Math.max(route.timeout_ms, 60_000);
  let outputUrl = "";
  let lastPayload: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, atlasCloudPollIntervalMs()));
    const poll = await fetch(`${baseUrl}/model/prediction/${encodeURIComponent(predictionId)}`, {
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "user-agent": ATLASCLOUD_USER_AGENT,
      },
      signal: AbortSignal.timeout(Math.min(route.timeout_ms, 60_000)),
    });
    const pollPayload = await readAtlasCloudJson(poll);
    lastPayload = pollPayload;
    if (!poll.ok && poll.status !== 400) {
      throw new Error(`atlascloud poll failed ${poll.status}: ${JSON.stringify(pollPayload).slice(0, 300)}`);
    }
    const data = atlasCloudPredictionData(pollPayload);
    const status = String(data.status || "").toLowerCase();
    if (status === "failed" || status === "error") {
      throw new Error(`atlascloud prediction failed: ${String(data.error || "unknown error")}`);
    }
    if (status === "completed" || status === "succeeded") {
      const outputs = Array.isArray(data.outputs) ? data.outputs : [];
      if (typeof outputs[0] !== "string" || !outputs[0]) {
        throw new Error(`atlascloud prediction returned no output URL: ${JSON.stringify(data).slice(0, 300)}`);
      }
      outputUrl = outputs[0];
      break;
    }
  }
  if (!outputUrl) {
    throw new Error(`atlascloud prediction timed out: ${JSON.stringify(lastPayload).slice(0, 300)}`);
  }
  const image = await fetch(outputUrl, {
    signal: AbortSignal.timeout(route.timeout_ms),
  });
  if (!image.ok) {
    throw new Error(`atlascloud image download failed: ${image.status}`);
  }
  return {
    data: Buffer.from(await image.arrayBuffer()),
    contentType: image.headers.get("content-type") || "image/png",
    model: route.model,
    provider: route.provider,
  };
}

async function runOllamaRoute(
  route: ModelRoute,
  payload: ModelMessage[],
): Promise<ModelTextResult> {
  const baseUrl = route.base_url || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  if (!baseUrl) throw new Error("OLLAMA_BASE_URL not configured");
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(route.timeout_ms),
      body: JSON.stringify({
        model: route.model,
        messages: payload,
        stream: false,
        options: {
          temperature: route.temperature,
          num_predict: route.max_tokens,
          num_ctx: route.context_window,
        },
        format: route.mode === "json" ? "json" : undefined,
      }),
    });
  } catch (error) {
    throw new Error(
      `ollama request failed for ${route.model}: ${
        error instanceof Error ? error.message : "request timed out"
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(`ollama request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    text: data.message?.content || "",
    model: route.model,
    provider: route.provider,
    usage: {
      input_tokens: data.prompt_eval_count ?? 0,
      output_tokens: data.eval_count ?? 0,
    },
  };
}

async function runOllamaEmbeddingRoute(
  route: ModelRoute,
  inputs: string[],
  dimensions?: number,
): Promise<ModelEmbeddingResult> {
  const baseUrl = route.base_url || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(route.timeout_ms),
      body: JSON.stringify({
        model: route.model,
        input: normalizeOllamaEmbeddingInputs(inputs),
        truncate: true,
      }),
    });
  } catch (error) {
    throw new Error(
      `ollama embed request failed for ${route.model}: ${
        error instanceof Error ? error.message : "request timed out"
      }`,
    );
  }
  if (!response.ok) {
    throw new Error(`ollama embed request failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    embeddings?: number[][];
    embedding?: number[];
  };
  const rawEmbeddings = data.embeddings || (data.embedding ? [data.embedding] : []);
  return {
    vectors: rawEmbeddings.map((vector) =>
      normalizeEmbeddingDimensions(vector, dimensions ?? route.dimensions),
    ),
    model: route.model,
    provider: route.provider,
  };
}

export async function generateText({
  taskId,
  prompt,
  system,
  messages,
  manifestPath,
}: {
  taskId: string;
  prompt?: string;
  system?: string;
  messages?: ModelMessage[];
  manifestPath?: string;
}): Promise<ModelTextResult> {
  const routes = loadRoutes(manifestPath);
  const route = getRoute(taskId, routes);
  validateRouteRequirements(route);
  const payload = buildMessages({ prompt, system, messages });
  if (route.provider === "anthropic") {
    return runAnthropicRoute(route, payload);
  }
  if (route.provider === "openai") {
    return runOpenAIRoute(route, payload);
  }
  if (route.provider === "openrouter") {
    return runOpenRouterRoute(route, payload);
  }
  if (route.provider === "ollama") {
    return runOllamaRoute(route, payload);
  }
  throw new Error(`unsupported model provider: ${route.provider}`);
}

export async function generateJson<T>({
  taskId,
  prompt,
  system,
  messages,
  manifestPath,
}: {
  taskId: string;
  prompt?: string;
  system?: string;
  messages?: ModelMessage[];
  manifestPath?: string;
}): Promise<ModelTextResult & { parsed: T }> {
  const result = await generateText({ taskId, prompt, system, messages, manifestPath });
  return {
    ...result,
    parsed: parseJsonText(result.text) as T,
  };
}

export async function embedTexts({
  taskId,
  inputs,
  dimensions,
  manifestPath,
}: {
  taskId: string;
  inputs: string[];
  dimensions?: number;
  manifestPath?: string;
}): Promise<ModelEmbeddingResult> {
  const routes = loadRoutes(manifestPath);
  const route = getRoute(taskId, routes);
  validateRouteRequirements(route);
  if (route.mode !== "embedding") {
    throw new Error(`task ${taskId} is not an embedding route`);
  }
  if (route.provider === "openai") {
    return runOpenAIEmbeddingRoute(route, inputs, dimensions);
  }
  if (route.provider === "openrouter") {
    return runOpenRouterEmbeddingRoute(route, inputs, dimensions);
  }
  if (route.provider === "ollama") {
    return runOllamaEmbeddingRoute(route, inputs, dimensions);
  }
  throw new Error(`unsupported embedding provider: ${route.provider}`);
}

export async function embedText({
  taskId,
  input,
  dimensions,
  manifestPath,
}: {
  taskId: string;
  input: string;
  dimensions?: number;
  manifestPath?: string;
}): Promise<number[]> {
  const result = await embedTexts({
    taskId,
    inputs: [input],
    dimensions,
    manifestPath,
  });
  return result.vectors[0] || [];
}

export async function generateImage({
  taskId,
  prompt,
  manifestPath,
}: {
  taskId: string;
  prompt: string;
  manifestPath?: string;
}): Promise<ModelImageResult> {
  const routes = loadRoutes(manifestPath);
  const route = getRoute(taskId, routes);
  validateRouteRequirements(route);
  if (route.mode !== "image") {
    throw new Error(`task ${taskId} is not an image route`);
  }
  if (route.provider === "openai" || route.provider === "xai") {
    return runOpenAIImageRoute(route, prompt);
  }
  if (route.provider === "atlascloud") {
    return runAtlasCloudImageRoute(route, prompt);
  }
  throw new Error(`unsupported image provider: ${route.provider}`);
}
