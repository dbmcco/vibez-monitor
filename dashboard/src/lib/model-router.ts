import fs from "node:fs";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface ModelRoute {
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  mode: "text" | "json" | "embedding";
  max_tokens: number;
  temperature: number;
  timeout_ms: number;
  base_url?: string;
  dimensions?: number;
}

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

const ROUTE_CACHE = new Map<string, Record<string, ModelRoute>>();

export function defaultManifestPath(): string {
  return process.env.VIBEZ_MODEL_ROUTING_PATH ||
    path.join(/* turbopackIgnore: true */ process.cwd(), "..", "config", "model-routing.json");
}

function resolveManifestPath(manifestPath = defaultManifestPath()): string {
  if (path.isAbsolute(manifestPath)) return manifestPath;
  const cwdCandidate = path.join(/* turbopackIgnore: true */ process.cwd(), manifestPath);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  return path.join(/* turbopackIgnore: true */ process.cwd(), "..", manifestPath);
}

export function loadRoutes(manifestPath = defaultManifestPath()): Record<string, ModelRoute> {
  const resolvedPath = resolveManifestPath(manifestPath);
  const cached = ROUTE_CACHE.get(resolvedPath);
  if (cached) return cached;
  const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as {
    version: number;
    routes: Record<string, ModelRoute>;
  };
  if (payload.version !== 1 || !payload.routes || typeof payload.routes !== "object") {
    throw new Error("invalid model routing manifest");
  }
  ROUTE_CACHE.set(resolvedPath, payload.routes);
  return payload.routes;
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

function validateRouteRequirements(route: ModelRoute): void {
  if (route.provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  if (route.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  if (route.provider === "ollama" && !route.base_url && !process.env.OLLAMA_BASE_URL) {
    throw new Error("OLLAMA_BASE_URL not configured");
  }
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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
    apiKey: process.env.OPENAI_API_KEY,
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

async function runOpenAIEmbeddingRoute(
  route: ModelRoute,
  inputs: string[],
  dimensions?: number,
): Promise<ModelEmbeddingResult> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: route.timeout_ms,
  });
  const response = await client.embeddings.create({
    model: route.model,
    input: inputs,
    encoding_format: "float",
    dimensions: dimensions ?? route.dimensions,
  });
  return {
    vectors: response.data.map((item) => item.embedding as number[]),
    model: route.model,
    provider: route.provider,
  };
}

async function runOllamaRoute(
  route: ModelRoute,
  payload: ModelMessage[],
): Promise<ModelTextResult> {
  const baseUrl = route.base_url || process.env.OLLAMA_BASE_URL;
  if (!baseUrl) throw new Error("OLLAMA_BASE_URL not configured");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      messages: payload,
      stream: false,
      options: {
        temperature: route.temperature,
        num_predict: route.max_tokens,
      },
      format: route.mode === "json" ? "json" : undefined,
    }),
  });
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
