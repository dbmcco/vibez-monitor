import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import path from "path";

const DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");
const MILLION = 1_000_000;
const CHAT_ROUTE = "/api/chat";

const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS value_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  client_ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_usage_day_status ON api_usage_events(day_key, status);
CREATE INDEX IF NOT EXISTS idx_api_usage_day_route ON api_usage_events(day_key, route);
CREATE INDEX IF NOT EXISTS idx_api_usage_day_ip ON api_usage_events(day_key, client_ip);
`;

const API_USAGE_KEYS = [
  "api_guard_enabled",
  "api_guard_manual_lock",
  "api_daily_budget_usd",
  "api_daily_request_limit",
  "api_daily_requests_per_ip",
  "api_input_cost_per_million_usd",
  "api_output_cost_per_million_usd",
] as const;

type ApiUsageKey = (typeof API_USAGE_KEYS)[number];

type EventStatus = "success" | "error" | "blocked";

interface UsageTokenFields {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface DailyUsageRollup {
  model_requests: number;
  blocked_requests: number;
  success_requests: number;
  error_requests: number;
  estimated_cost_usd: number;
}

export interface ApiUsageConfig {
  api_guard_enabled: boolean;
  api_guard_manual_lock: boolean;
  api_daily_budget_usd: number;
  api_daily_request_limit: number;
  api_daily_requests_per_ip: number;
  api_input_cost_per_million_usd: number;
  api_output_cost_per_million_usd: number;
}

export interface ApiUsageGuardState {
  day_key: string;
  model_requests_today: number;
  blocked_requests_today: number;
  estimated_cost_usd_today: number;
  model_requests_from_ip_today: number;
  config: ApiUsageConfig;
}

export interface ApiUsageGuardResult {
  allowed: boolean;
  statusCode: number;
  reason: string | null;
  message: string | null;
  state: ApiUsageGuardState;
}

interface RouteUsageRow {
  route: string;
  success_requests: number;
  blocked_requests: number;
  error_requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

interface DayUsageRow extends Omit<RouteUsageRow, "route"> {
  day_key: string;
}

export interface ApiUsageSummary {
  generated_at: string;
  day_key: string;
  config: ApiUsageConfig;
  today: {
    success_requests: number;
    blocked_requests: number;
    error_requests: number;
    model_requests: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  };
  route_breakdown: RouteUsageRow[];
  recent_days: DayUsageRow[];
  client_breakdown: Array<{
    client: string;
    model_requests: number;
    blocked_requests: number;
    estimated_cost_usd: number;
  }>;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFinite(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeNonNegative(value: unknown, fallback: number): number {
  return Math.max(0, normalizeFinite(value, fallback));
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function dayKeyUTC(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(USAGE_SCHEMA);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readConfigRows(db: Database.Database): Record<string, unknown> {
  const placeholders = API_USAGE_KEYS.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT key, value FROM value_config WHERE key IN (${placeholders})`)
    .all(...API_USAGE_KEYS) as Array<{ key: ApiUsageKey; value: string }>;
  const configRows: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      configRows[row.key] = JSON.parse(row.value);
    } catch {
      configRows[row.key] = row.value;
    }
  }
  return configRows;
}

function defaultUsageConfig(): ApiUsageConfig {
  return {
    api_guard_enabled: parseBool(process.env.VIBEZ_API_GUARD_ENABLED, true),
    api_guard_manual_lock: parseBool(process.env.VIBEZ_API_GUARD_MANUAL_LOCK, false),
    api_daily_budget_usd: normalizeNonNegative(
      parseNum(process.env.VIBEZ_API_DAILY_BUDGET_USD, 6),
      6,
    ),
    api_daily_request_limit: normalizeNonNegative(
      parseNum(process.env.VIBEZ_API_DAILY_REQUEST_LIMIT, 240),
      240,
    ),
    api_daily_requests_per_ip: normalizeNonNegative(
      parseNum(process.env.VIBEZ_API_DAILY_REQUESTS_PER_IP, 80),
      80,
    ),
    api_input_cost_per_million_usd: normalizeNonNegative(
      parseNum(process.env.VIBEZ_API_INPUT_COST_PER_MILLION_USD, 3),
      3,
    ),
    api_output_cost_per_million_usd: normalizeNonNegative(
      parseNum(process.env.VIBEZ_API_OUTPUT_COST_PER_MILLION_USD, 15),
      15,
    ),
  };
}

function loadUsageConfig(db: Database.Database): ApiUsageConfig {
  const defaults = defaultUsageConfig();
  const configRows = readConfigRows(db);
  return {
    api_guard_enabled: normalizeBool(configRows.api_guard_enabled, defaults.api_guard_enabled),
    api_guard_manual_lock: normalizeBool(
      configRows.api_guard_manual_lock,
      defaults.api_guard_manual_lock,
    ),
    api_daily_budget_usd: normalizeNonNegative(
      configRows.api_daily_budget_usd,
      defaults.api_daily_budget_usd,
    ),
    api_daily_request_limit: normalizeNonNegative(
      configRows.api_daily_request_limit,
      defaults.api_daily_request_limit,
    ),
    api_daily_requests_per_ip: normalizeNonNegative(
      configRows.api_daily_requests_per_ip,
      defaults.api_daily_requests_per_ip,
    ),
    api_input_cost_per_million_usd: normalizeNonNegative(
      configRows.api_input_cost_per_million_usd,
      defaults.api_input_cost_per_million_usd,
    ),
    api_output_cost_per_million_usd: normalizeNonNegative(
      configRows.api_output_cost_per_million_usd,
      defaults.api_output_cost_per_million_usd,
    ),
  };
}

function toInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function toFloat(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function readDailyRollup(db: Database.Database, dayKey: string): DailyUsageRollup {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN status IN ('success', 'error') THEN 1 ELSE 0 END), 0) AS model_requests,
        COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_requests,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_requests,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_requests,
        COALESCE(SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd
       FROM api_usage_events
       WHERE day_key = ? AND route = ?`,
    )
    .get(dayKey, CHAT_ROUTE) as Record<string, unknown> | undefined;

  return {
    model_requests: toInt(row?.model_requests),
    blocked_requests: toInt(row?.blocked_requests),
    success_requests: toInt(row?.success_requests),
    error_requests: toInt(row?.error_requests),
    estimated_cost_usd: roundUsd(toFloat(row?.estimated_cost_usd)),
  };
}

function readDailyRequestsForIp(db: Database.Database, dayKey: string, clientIp: string): number {
  const row = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN status IN ('success', 'error') THEN 1 ELSE 0 END), 0) AS model_requests
       FROM api_usage_events
       WHERE day_key = ? AND route = ? AND client_ip = ?`,
    )
    .get(dayKey, CHAT_ROUTE, clientIp) as { model_requests?: unknown } | undefined;
  return toInt(row?.model_requests);
}

function normalizeIp(raw: string): string {
  return raw.trim().slice(0, 120) || "unknown";
}

function maskClientIp(raw: string): string {
  const value = normalizeIp(raw);
  if (value === "unknown") return value;
  if (value.includes(".")) {
    const parts = value.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
    }
  }
  if (value.includes(":")) {
    const parts = value.split(":").slice(0, 3).filter(Boolean);
    if (parts.length > 0) return `${parts.join(":")}::`;
  }
  if (value.length <= 6) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    if (first) return normalizeIp(first);
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return normalizeIp(realIp);
  return "unknown";
}

function reasonMessage(reason: string, config: ApiUsageConfig): string {
  if (reason === "manual_lock") {
    return "Chat assistant is temporarily locked by an administrator.";
  }
  if (reason === "daily_budget_reached") {
    return `Daily chat budget reached (${config.api_daily_budget_usd.toFixed(2)} USD). Resets at 00:00 UTC.`;
  }
  if (reason === "daily_request_limit_reached") {
    return `Daily chat request cap reached (${Math.round(config.api_daily_request_limit)} calls). Resets at 00:00 UTC.`;
  }
  if (reason === "ip_request_limit_reached") {
    return `Per-client chat cap reached (${Math.round(
      config.api_daily_requests_per_ip,
    )} calls/day). Resets at 00:00 UTC.`;
  }
  return "Chat request blocked by usage guard.";
}

function insertUsageEvent(db: Database.Database, args: {
  dayKey: string;
  route: string;
  model: string;
  clientIp: string;
  status: EventStatus;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  estimatedCostUsd?: number;
}) {
  db.prepare(
    `INSERT INTO api_usage_events (
      day_key, route, model, client_ip, status, reason,
      input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.dayKey,
    args.route,
    args.model,
    args.clientIp,
    args.status,
    args.reason || "",
    Math.max(0, Math.round(args.inputTokens || 0)),
    Math.max(0, Math.round(args.outputTokens || 0)),
    Math.max(0, Math.round(args.cacheCreationInputTokens || 0)),
    Math.max(0, Math.round(args.cacheReadInputTokens || 0)),
    roundUsd(args.estimatedCostUsd || 0),
  );
}

function usageToBilling(usage: UsageTokenFields | null | undefined, config: ApiUsageConfig) {
  const inputTokens = Math.max(0, Math.round(Number(usage?.input_tokens || 0)));
  const outputTokens = Math.max(0, Math.round(Number(usage?.output_tokens || 0)));
  const cacheCreationInputTokens = Math.max(
    0,
    Math.round(Number(usage?.cache_creation_input_tokens || 0)),
  );
  const cacheReadInputTokens = Math.max(
    0,
    Math.round(Number(usage?.cache_read_input_tokens || 0)),
  );
  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const estimatedCostUsd =
    (totalInputTokens / MILLION) * config.api_input_cost_per_million_usd +
    (outputTokens / MILLION) * config.api_output_cost_per_million_usd;
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    estimatedCostUsd: roundUsd(estimatedCostUsd),
  };
}

export function enforceApiUsageGuard(args: {
  route: string;
  model: string;
  clientIp: string;
}): ApiUsageGuardResult {
  return withDb((db) => {
    const config = loadUsageConfig(db);
    const dayKey = dayKeyUTC();
    const daily = readDailyRollup(db, dayKey);
    const ipRequests = readDailyRequestsForIp(db, dayKey, normalizeIp(args.clientIp));
    const state: ApiUsageGuardState = {
      day_key: dayKey,
      model_requests_today: daily.model_requests,
      blocked_requests_today: daily.blocked_requests,
      estimated_cost_usd_today: daily.estimated_cost_usd,
      model_requests_from_ip_today: ipRequests,
      config,
    };

    if (!config.api_guard_enabled) {
      return { allowed: true, statusCode: 200, reason: null, message: null, state };
    }

    let reason: string | null = null;
    if (config.api_guard_manual_lock) {
      reason = "manual_lock";
    } else if (
      config.api_daily_budget_usd > 0 &&
      daily.estimated_cost_usd >= config.api_daily_budget_usd
    ) {
      reason = "daily_budget_reached";
    } else if (
      config.api_daily_request_limit > 0 &&
      daily.model_requests >= config.api_daily_request_limit
    ) {
      reason = "daily_request_limit_reached";
    } else if (
      config.api_daily_requests_per_ip > 0 &&
      ipRequests >= config.api_daily_requests_per_ip
    ) {
      reason = "ip_request_limit_reached";
    }

    if (!reason) {
      return { allowed: true, statusCode: 200, reason: null, message: null, state };
    }

    insertUsageEvent(db, {
      dayKey,
      route: args.route,
      model: args.model,
      clientIp: normalizeIp(args.clientIp),
      status: "blocked",
      reason,
    });

    return {
      allowed: false,
      statusCode: 429,
      reason,
      message: reasonMessage(reason, config),
      state,
    };
  });
}

export function recordApiUsageSuccess(args: {
  route: string;
  model: string;
  clientIp: string;
  usage: UsageTokenFields | null | undefined;
}) {
  withDb((db) => {
    const config = loadUsageConfig(db);
    const billing = usageToBilling(args.usage, config);
    insertUsageEvent(db, {
      dayKey: dayKeyUTC(),
      route: args.route,
      model: args.model,
      clientIp: normalizeIp(args.clientIp),
      status: "success",
      inputTokens: billing.inputTokens,
      outputTokens: billing.outputTokens,
      cacheCreationInputTokens: billing.cacheCreationInputTokens,
      cacheReadInputTokens: billing.cacheReadInputTokens,
      estimatedCostUsd: billing.estimatedCostUsd,
    });
  });
}

export function recordApiUsageError(args: {
  route: string;
  model: string;
  clientIp: string;
  reason?: string;
}) {
  withDb((db) => {
    insertUsageEvent(db, {
      dayKey: dayKeyUTC(),
      route: args.route,
      model: args.model,
      clientIp: normalizeIp(args.clientIp),
      status: "error",
      reason: (args.reason || "").slice(0, 240),
    });
  });
}

export function getApiUsageSummary(): ApiUsageSummary {
  return withDb((db) => {
    const config = loadUsageConfig(db);
    const dayKey = dayKeyUTC();

    const today = db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_requests,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_requests,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_requests,
          COALESCE(SUM(CASE WHEN status IN ('success', 'error') THEN 1 ELSE 0 END), 0) AS model_requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + cache_creation_input_tokens + cache_read_input_tokens ELSE 0 END), 0) AS input_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd
         FROM api_usage_events
         WHERE day_key = ? AND route = ?`,
      )
      .get(dayKey, CHAT_ROUTE) as Record<string, unknown> | undefined;

    const routeBreakdown = db
      .prepare(
        `SELECT
          route,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_requests,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_requests,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + cache_creation_input_tokens + cache_read_input_tokens ELSE 0 END), 0) AS input_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd
         FROM api_usage_events
         WHERE day_key = ? AND route = ?
         GROUP BY route
         ORDER BY estimated_cost_usd DESC, success_requests DESC`,
      )
      .all(dayKey, CHAT_ROUTE) as Array<Record<string, unknown>>;

    const recentDays = db
      .prepare(
        `SELECT
          day_key,
          COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_requests,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_requests,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN input_tokens + cache_creation_input_tokens + cache_read_input_tokens ELSE 0 END), 0) AS input_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
          COALESCE(SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd
         FROM api_usage_events
         WHERE route = ?
         GROUP BY day_key
         ORDER BY day_key DESC
         LIMIT 14`,
      )
      .all(CHAT_ROUTE) as Array<Record<string, unknown>>;

    const clients = db
      .prepare(
        `SELECT
          client_ip,
          COALESCE(SUM(CASE WHEN status IN ('success', 'error') THEN 1 ELSE 0 END), 0) AS model_requests,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_requests,
          COALESCE(SUM(CASE WHEN status = 'success' THEN estimated_cost_usd ELSE 0 END), 0) AS estimated_cost_usd
         FROM api_usage_events
         WHERE day_key = ? AND route = ?
         GROUP BY client_ip
         ORDER BY model_requests DESC, blocked_requests DESC
         LIMIT 12`,
      )
      .all(dayKey, CHAT_ROUTE) as Array<Record<string, unknown>>;

    return {
      generated_at: new Date().toISOString(),
      day_key: dayKey,
      config,
      today: {
        success_requests: toInt(today?.success_requests),
        blocked_requests: toInt(today?.blocked_requests),
        error_requests: toInt(today?.error_requests),
        model_requests: toInt(today?.model_requests),
        input_tokens: toInt(today?.input_tokens),
        output_tokens: toInt(today?.output_tokens),
        estimated_cost_usd: roundUsd(toFloat(today?.estimated_cost_usd)),
      },
      route_breakdown: routeBreakdown.map((row) => ({
        route: String(row.route || "unknown"),
        success_requests: toInt(row.success_requests),
        blocked_requests: toInt(row.blocked_requests),
        error_requests: toInt(row.error_requests),
        input_tokens: toInt(row.input_tokens),
        output_tokens: toInt(row.output_tokens),
        estimated_cost_usd: roundUsd(toFloat(row.estimated_cost_usd)),
      })),
      recent_days: recentDays.map((row) => ({
        day_key: String(row.day_key || ""),
        success_requests: toInt(row.success_requests),
        blocked_requests: toInt(row.blocked_requests),
        error_requests: toInt(row.error_requests),
        input_tokens: toInt(row.input_tokens),
        output_tokens: toInt(row.output_tokens),
        estimated_cost_usd: roundUsd(toFloat(row.estimated_cost_usd)),
      })),
      client_breakdown: clients.map((row) => ({
        client: maskClientIp(String(row.client_ip || "unknown")),
        model_requests: toInt(row.model_requests),
        blocked_requests: toInt(row.blocked_requests),
        estimated_cost_usd: roundUsd(toFloat(row.estimated_cost_usd)),
      })),
    };
  });
}
