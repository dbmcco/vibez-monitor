import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Pool } from "pg";

const ALLOWED_SYNC_STATE_KEYS = new Set([
  "beeper_active_group_ids",
  "beeper_active_group_names",
  "google_groups_active_group_keys",
  "wisdom_last_run",
  "links_last_refresh_ts",
]);
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const EMBEDDING_BATCH_SIZE = 100;
let pgPool: Pool | null = null;

export interface MessagePayload {
  id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number;
  raw_event?: string;
}

export interface ClassificationPayload {
  relevance_score?: number;
  topics?: unknown;
  entities?: unknown;
  contribution_flag?: boolean;
  contribution_themes?: unknown;
  contribution_hint?: string;
  alert_level?: string;
}

export interface RecordPayload {
  message: MessagePayload;
  classification?: ClassificationPayload | null;
}

export interface LinkPayload {
  url: string;
  url_hash: string;
  title?: string | null;
  category?: string | null;
  relevance?: string | null;
  shared_by?: string | null;
  source_group?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  mention_count?: number | null;
  value_score?: number | null;
  report_date?: string | null;
  authored_by?: string | null;
  pinned?: number | null;
}

export interface DailyReportPayload {
  report_date: string;
  briefing_md?: string | null;
  briefing_json?: string | null;
  contributions?: string | null;
  trends?: string | null;
  daily_memo?: string | null;
  conversation_arcs?: string | null;
  stats?: string | null;
  generated_at?: string | null;
}

export interface WisdomTopicPayload {
  name: string;
  slug: string;
  summary?: string | null;
  message_count?: number | null;
  contributor_count?: number | null;
  last_active?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WisdomItemPayload {
  topic_slug: string;
  knowledge_type: string;
  title: string;
  summary?: string | null;
  source_links?: string | null;
  source_messages?: string | null;
  contributors?: string | null;
  confidence?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WisdomRecommendationPayload {
  from_topic_slug: string;
  to_topic_slug: string;
  strength?: number | null;
  reason?: string | null;
}

export interface MessageEmbeddingPayload {
  message_id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score?: number | null;
  topics?: string | unknown;
  entities?: string | unknown;
  contribution_flag?: number | boolean | null;
  contribution_themes?: string | unknown;
  contribution_hint?: string | null;
  alert_level?: string | null;
  embedding: string;
}

export interface LinkEmbeddingPayload {
  link_id: number;
  url: string;
  url_hash: string;
  title?: string | null;
  category?: string | null;
  relevance?: string | null;
  shared_by?: string | null;
  source_group?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  mention_count?: number | null;
  value_score?: number | null;
  report_date?: string | null;
  authored_by?: string | null;
  pinned?: number | boolean | null;
  embedding: string;
}

export interface PushPayload {
  records?: unknown;
  links?: unknown;
  replace_links?: unknown;
  daily_reports?: unknown;
  wisdom_topics?: unknown;
  wisdom_items?: unknown;
  wisdom_recommendations?: unknown;
  message_embeddings?: unknown;
  link_embeddings?: unknown;
  sync_state?: unknown;
}

export interface PushResult {
  messages_written: number;
  classifications_written: number;
  links_written: number;
  daily_reports_written: number;
  wisdom_topics_written: number;
  wisdom_items_written: number;
  wisdom_recommendations_written: number;
  message_embeddings_written: number;
  link_embeddings_written: number;
  sync_state_written: number;
}

export interface RawBeeperEventPayload {
  source_event_key: string;
  source_room_id: string;
  room_name: string;
  sender_key: string;
  sender_display_name: string;
  source_timestamp: string | number;
  body: string;
  attachments_json?: unknown;
  raw_payload_json?: unknown;
}

export interface BeeperBatchPayload {
  source?: string;
  batch_key: string;
  events: RawBeeperEventPayload[];
}

export interface BeeperBatchIngestResult {
  ok: true;
  source: string;
  batch_key: string;
  record_count: number;
  inserted_count: number;
  deduped_count: number;
}

export interface PgvectorWriter {
  writeMessageEmbeddings(rows: MessageEmbeddingPayload[]): Promise<number>;
  writeLinkEmbeddings(rows: LinkEmbeddingPayload[]): Promise<number>;
}

function corePostgresConfigured(): boolean {
  return Boolean(
    (process.env.VIBEZ_DATABASE_URL || process.env.DATABASE_URL || process.env.VIBEZ_PGVECTOR_URL || "").trim(),
  );
}

function parseJsonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

function normalizeAlertLevel(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "hot" || value === "digest" || value === "none") return value;
  return "none";
}

function toIntScore(raw: unknown): number {
  const value = Number.parseInt(String(raw ?? "0"), 10);
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 10) return 10;
  return value;
}

function isValidMessage(message: MessagePayload): boolean {
  return Boolean(
    message.id &&
      message.room_id &&
      message.room_name &&
      message.sender_id &&
      message.sender_name &&
      typeof message.body === "string" &&
      Number.isFinite(message.timestamp),
  );
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseJsonText(value: unknown, fallback = "[]"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

function parseEmbeddingLiteral(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("[") ? trimmed : `[${trimmed}]`;
}

function messageTableName(): string {
  const raw = (process.env.VIBEZ_PGVECTOR_TABLE || "vibez_message_embeddings")
    .trim()
    .toLowerCase();
  if (!IDENT_RE.test(raw)) {
    throw new Error(`Invalid VIBEZ_PGVECTOR_TABLE '${raw}'.`);
  }
  return raw;
}

function linkTableName(): string {
  const raw = (process.env.VIBEZ_PGVECTOR_LINK_TABLE || "vibez_link_embeddings")
    .trim()
    .toLowerCase();
  if (!IDENT_RE.test(raw)) {
    throw new Error(`Invalid VIBEZ_PGVECTOR_LINK_TABLE '${raw}'.`);
  }
  return raw;
}

function pgvectorDimensions(): number {
  const value = Number.parseInt(process.env.VIBEZ_PGVECTOR_DIM || "256", 10);
  if (!Number.isFinite(value)) return 256;
  return Math.max(64, Math.min(value, 3072));
}

export function getPgPool(): Pool | null {
  const url = (process.env.VIBEZ_DATABASE_URL || process.env.DATABASE_URL || process.env.VIBEZ_PGVECTOR_URL || "").trim();
  if (!url) return null;
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }
  return pgPool;
}

export async function ensurePostgresCoreSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      raw_event TEXT NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classifications (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      relevance_score INTEGER NOT NULL DEFAULT 0,
      topics TEXT NOT NULL DEFAULT '[]',
      entities TEXT NOT NULL DEFAULT '[]',
      contribution_flag BOOLEAN NOT NULL DEFAULT FALSE,
      contribution_themes TEXT NOT NULL DEFAULT '[]',
      contribution_hint TEXT,
      alert_level TEXT NOT NULL DEFAULT 'none'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL UNIQUE,
      title TEXT,
      category TEXT,
      relevance TEXT,
      shared_by TEXT,
      source_group TEXT,
      first_seen TEXT,
      last_seen TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      value_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      report_date TEXT,
      authored_by TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id BIGSERIAL PRIMARY KEY,
      report_date TEXT UNIQUE NOT NULL,
      briefing_md TEXT,
      briefing_json TEXT,
      contributions TEXT,
      trends TEXT,
      daily_memo TEXT,
      conversation_arcs TEXT,
      stats TEXT,
      generated_at TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_room_name ON messages (room_name)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_links_last_seen ON links (last_seen DESC)");
}

export async function ensureCanonicalIngestSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_batches (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      batch_key TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      record_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      deduped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      UNIQUE (source, batch_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_watermarks (
      source TEXT NOT NULL,
      room_id TEXT NOT NULL,
      latest_source_event_id TEXT,
      latest_source_timestamp TIMESTAMPTZ,
      last_successful_batch_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source, room_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      source_event_key TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      sender_key TEXT NOT NULL,
      sender_display_name TEXT NOT NULL,
      source_timestamp TIMESTAMPTZ NOT NULL,
      body TEXT NOT NULL,
      attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      body_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, source_event_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_event_links (
      raw_event_id BIGINT NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      host TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (raw_event_id, normalized_url, position)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_events (source_timestamp DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_raw_events_room ON raw_events (source_room_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_raw_event_links_host ON raw_event_links (host)");
}

function stableJson(value: unknown, defaultValue: unknown): string {
  if (value === undefined || value === null) return JSON.stringify(defaultValue);
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function linkHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function normalizeSourceTimestamp(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid source_timestamp in Beeper batch.");
  }
  return date.toISOString();
}

function sourceTimestampMs(value: string | number): number {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid source_timestamp in Beeper batch.");
  }
  return date.getTime();
}

function isValidRawBeeperEvent(event: RawBeeperEventPayload): boolean {
  return Boolean(
    event?.source_event_key &&
      event.source_room_id &&
      event.room_name &&
      event.sender_key &&
      event.sender_display_name &&
      typeof event.body === "string" &&
      event.source_timestamp !== undefined &&
      event.source_timestamp !== null,
  );
}

function extractLinks(body: string): Array<{ url: string; normalized_url: string; host: string | null; position: number }> {
  const matches = body.matchAll(/https?:\/\/[^\s<>"']+/gi);
  const links: Array<{ url: string; normalized_url: string; host: string | null; position: number }> = [];
  for (const match of matches) {
    const url = match[0].replace(/[),.;!?]+$/, "");
    let normalizedUrl = url;
    let host: string | null = null;
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      normalizedUrl = parsed.toString();
      host = parsed.host.toLowerCase();
    } catch {
      normalizedUrl = url.trim();
    }
    links.push({
      url,
      normalized_url: normalizedUrl,
      host,
      position: match.index ?? links.length,
    });
  }
  return links;
}

export async function applyBeeperBatchPayload(
  payload: BeeperBatchPayload,
  pool: Pool | null = getPgPool(),
): Promise<BeeperBatchIngestResult> {
  if (!pool) {
    throw new Error("Postgres is not configured for Beeper ingest.");
  }
  const source = (payload.source || "beeper").trim();
  const batchKey = String(payload.batch_key || "").trim();
  const events = asArray<RawBeeperEventPayload>(payload.events);
  if (!source || !batchKey) {
    throw new Error("Beeper batch requires source and batch_key.");
  }
  if (events.length === 0) {
    throw new Error("Beeper batch requires at least one event.");
  }

  await ensureCanonicalIngestSchema(pool);
  await ensurePostgresCoreSchema(pool);
  await pool.query("BEGIN");
  let batchId: number | string | null = null;
  let insertedCount = 0;
  try {
    const batchResult = await pool.query(
      `
        INSERT INTO ingest_batches
          (source, batch_key, started_at, status, record_count, inserted_count, deduped_count, error)
        VALUES ($1, $2, now(), 'running', $3, 0, 0, NULL)
        ON CONFLICT (source, batch_key) DO UPDATE SET
          started_at = now(),
          status = 'running',
          record_count = EXCLUDED.record_count,
          error = NULL
        RETURNING id
      `,
      [source, batchKey, events.length],
    );
    batchId = batchResult.rows?.[0]?.id ?? null;

    const latestByRoom = new Map<string, RawBeeperEventPayload>();
    for (const event of events) {
      if (!isValidRawBeeperEvent(event)) {
        throw new Error("Invalid event in Beeper batch.");
      }
      const timestamp = normalizeSourceTimestamp(event.source_timestamp);
      const insertResult = await pool.query(
        `
          INSERT INTO raw_events
            (source, source_event_key, source_room_id, room_name, sender_key,
             sender_display_name, source_timestamp, body, attachments_json,
             raw_payload_json, body_hash)
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb, $10::jsonb, $11)
          ON CONFLICT (source, source_event_key) DO NOTHING
          RETURNING id
        `,
        [
          source,
          event.source_event_key.trim(),
          event.source_room_id.trim(),
          event.room_name.trim(),
          event.sender_key.trim(),
          event.sender_display_name.trim(),
          timestamp,
          event.body,
          stableJson(event.attachments_json, []),
          stableJson(event.raw_payload_json, {}),
          bodyHash(event.body),
        ],
      );
      const rawEventId = insertResult.rows?.[0]?.id;
      await pool.query(
        `
          INSERT INTO messages
            (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            room_id = EXCLUDED.room_id,
            room_name = EXCLUDED.room_name,
            sender_id = EXCLUDED.sender_id,
            sender_name = EXCLUDED.sender_name,
            body = EXCLUDED.body,
            timestamp = EXCLUDED.timestamp,
            raw_event = EXCLUDED.raw_event
        `,
        [
          event.source_event_key.trim(),
          event.source_room_id.trim(),
          event.room_name.trim(),
          event.sender_key.trim(),
          event.sender_display_name.trim(),
          event.body,
          sourceTimestampMs(event.source_timestamp),
          stableJson(event.raw_payload_json, {}),
        ],
      );
      if (insertResult.rowCount && rawEventId) {
        insertedCount += 1;
        for (const link of extractLinks(event.body)) {
          await pool.query(
            `
              INSERT INTO raw_event_links
                (raw_event_id, url, normalized_url, host, position)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (raw_event_id, normalized_url, position) DO NOTHING
            `,
            [rawEventId, link.url, link.normalized_url, link.host, link.position],
          );
          await pool.query(
            `
              INSERT INTO links
                (url, url_hash, title, category, relevance, shared_by, source_group,
                 first_seen, last_seen, mention_count, value_score, report_date,
                 authored_by, pinned)
              VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, $5, 1, 0, $6, NULL, 0)
              ON CONFLICT (url_hash) DO UPDATE SET
                url = EXCLUDED.url,
                shared_by = COALESCE(links.shared_by, EXCLUDED.shared_by),
                source_group = COALESCE(links.source_group, EXCLUDED.source_group),
                first_seen = COALESCE(links.first_seen, EXCLUDED.first_seen),
                last_seen = GREATEST(COALESCE(links.last_seen, ''), EXCLUDED.last_seen),
                mention_count = links.mention_count + 1
            `,
            [
              link.normalized_url,
              linkHash(link.normalized_url),
              event.sender_display_name.trim(),
              event.room_name.trim(),
              timestamp,
              timestamp.slice(0, 10),
            ],
          );
        }
      }
      const previous = latestByRoom.get(event.source_room_id);
      if (!previous || normalizeSourceTimestamp(previous.source_timestamp) <= timestamp) {
        latestByRoom.set(event.source_room_id, event);
      }
    }

    for (const [roomId, event] of latestByRoom.entries()) {
      await pool.query(
        `
          INSERT INTO source_watermarks
            (source, room_id, latest_source_event_id, latest_source_timestamp,
             last_successful_batch_id, updated_at)
          VALUES ($1, $2, $3, $4::timestamptz, $5, now())
          ON CONFLICT (source, room_id) DO UPDATE SET
            latest_source_event_id = CASE
              WHEN source_watermarks.latest_source_timestamp IS NULL
                OR EXCLUDED.latest_source_timestamp >= source_watermarks.latest_source_timestamp
              THEN EXCLUDED.latest_source_event_id
              ELSE source_watermarks.latest_source_event_id
            END,
            latest_source_timestamp = GREATEST(
              COALESCE(source_watermarks.latest_source_timestamp, '-infinity'::timestamptz),
              EXCLUDED.latest_source_timestamp
            ),
            last_successful_batch_id = EXCLUDED.last_successful_batch_id,
            updated_at = now()
        `,
        [
          source,
          roomId,
          event.source_event_key.trim(),
          normalizeSourceTimestamp(event.source_timestamp),
          batchId,
        ],
      );
    }

    const dedupedCount = events.length - insertedCount;
    await pool.query(
      `
        UPDATE ingest_batches
        SET completed_at = now(),
            status = 'succeeded',
            inserted_count = $3,
            deduped_count = $4,
            error = NULL
        WHERE source = $1 AND batch_key = $2
      `,
      [source, batchKey, insertedCount, dedupedCount],
    );
    await pool.query("COMMIT");
    return {
      ok: true,
      source,
      batch_key: batchKey,
      record_count: events.length,
      inserted_count: insertedCount,
      deduped_count: dedupedCount,
    };
  } catch (error) {
    await pool.query("ROLLBACK");
    await pool.query(
      `
        UPDATE ingest_batches
        SET completed_at = now(),
            status = 'failed',
            error = $3
        WHERE source = $1 AND batch_key = $2
      `,
      [source, batchKey, error instanceof Error ? error.message : String(error || "unknown error")],
    );
    throw error;
  }
}

function isValidMessageEmbedding(row: MessageEmbeddingPayload): boolean {
  return Boolean(
    row.message_id &&
      row.room_id &&
      row.room_name &&
      row.sender_id &&
      row.sender_name &&
      typeof row.body === "string" &&
      Number.isFinite(Number(row.timestamp)) &&
      parseEmbeddingLiteral(row.embedding),
  );
}

function isValidLinkEmbedding(row: LinkEmbeddingPayload): boolean {
  return Boolean(
    Number.isFinite(Number(row.link_id)) &&
      row.url &&
      row.url_hash &&
      parseEmbeddingLiteral(row.embedding),
  );
}

function sanitizeSyncState(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== "object") return [];
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || !ALLOWED_SYNC_STATE_KEYS.has(normalizedKey)) continue;
    entries.push([
      normalizedKey,
      typeof value === "string" ? value : JSON.stringify(value ?? null),
    ]);
  }
  return entries;
}

export function hasPushPayloadContent(payload: PushPayload): boolean {
  return (
    asArray(payload.records).length > 0 ||
    asArray(payload.links).length > 0 ||
    asArray(payload.daily_reports).length > 0 ||
    asArray(payload.wisdom_topics).length > 0 ||
    asArray(payload.wisdom_items).length > 0 ||
    asArray(payload.wisdom_recommendations).length > 0 ||
    asArray(payload.message_embeddings).length > 0 ||
    asArray(payload.link_embeddings).length > 0 ||
    sanitizeSyncState(payload.sync_state).length > 0
  );
}

export function getRecordCount(payload: PushPayload): number {
  return asArray(payload.records).length;
}

function syncLinkFtsByUrlHash(db: Database.Database, urlHash: string): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS links_fts USING fts5(
      title, relevance, category, url
    )
  `);
  const row = db
    .prepare(
      "SELECT id, coalesce(title,''), coalesce(relevance,''), coalesce(category,''), coalesce(url,'') FROM links WHERE url_hash = ?",
    )
    .get(urlHash) as
    | { id: number; "coalesce(title,'')": string; "coalesce(relevance,'')": string; "coalesce(category,'')": string; "coalesce(url,'')": string }
    | undefined;
  if (!row) return;
  db.prepare("DELETE FROM links_fts WHERE rowid = ?").run(row.id);
  db.prepare(
    "INSERT INTO links_fts(rowid, title, relevance, category, url) VALUES (?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row["coalesce(title,'')"],
    row["coalesce(relevance,'')"],
    row["coalesce(category,'')"],
    row["coalesce(url,'')"],
  );
}

function upsertLink(db: Database.Database, link: LinkPayload): void {
  db.prepare(
    `INSERT INTO links
       (url, url_hash, title, category, relevance, shared_by, source_group, first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
     VALUES
       (@url, @url_hash, @title, @category, @relevance, @shared_by, @source_group, @first_seen, @last_seen, @mention_count, @value_score, @report_date, @authored_by, @pinned)
     ON CONFLICT(url_hash) DO UPDATE SET
       url = excluded.url,
       title = excluded.title,
       category = excluded.category,
       relevance = excluded.relevance,
       shared_by = excluded.shared_by,
       source_group = excluded.source_group,
       first_seen = excluded.first_seen,
       last_seen = excluded.last_seen,
       mention_count = excluded.mention_count,
       value_score = excluded.value_score,
       report_date = excluded.report_date,
       authored_by = excluded.authored_by,
       pinned = excluded.pinned`,
  ).run({
    url: link.url,
    url_hash: link.url_hash,
    title: link.title ?? null,
    category: link.category ?? null,
    relevance: link.relevance ?? null,
    shared_by: link.shared_by ?? null,
    source_group: link.source_group ?? null,
    first_seen: link.first_seen ?? null,
    last_seen: link.last_seen ?? null,
    mention_count: Number(link.mention_count ?? 1),
    value_score: Number(link.value_score ?? 0),
    report_date: link.report_date ?? null,
    authored_by: link.authored_by ?? null,
    pinned: Number(link.pinned ?? 0),
  });
}

function upsertDailyReport(db: Database.Database, report: DailyReportPayload): void {
  db.prepare(
    `INSERT INTO daily_reports
       (report_date, briefing_md, briefing_json, contributions, trends, daily_memo, conversation_arcs, stats, generated_at)
     VALUES
       (@report_date, @briefing_md, @briefing_json, @contributions, @trends, @daily_memo, @conversation_arcs, @stats, @generated_at)
     ON CONFLICT(report_date) DO UPDATE SET
       briefing_md = excluded.briefing_md,
       briefing_json = excluded.briefing_json,
       contributions = excluded.contributions,
       trends = excluded.trends,
       daily_memo = excluded.daily_memo,
       conversation_arcs = excluded.conversation_arcs,
       stats = excluded.stats,
       generated_at = excluded.generated_at`,
  ).run({
    report_date: report.report_date,
    briefing_md: report.briefing_md ?? null,
    briefing_json: report.briefing_json ?? null,
    contributions: report.contributions ?? null,
    trends: report.trends ?? null,
    daily_memo: report.daily_memo ?? null,
    conversation_arcs: report.conversation_arcs ?? null,
    stats: report.stats ?? null,
    generated_at: report.generated_at ?? null,
  });
}

function upsertWisdomTopic(db: Database.Database, topic: WisdomTopicPayload): void {
  db.prepare(
    `INSERT INTO wisdom_topics
       (name, slug, summary, message_count, contributor_count, last_active, created_at, updated_at)
     VALUES
       (@name, @slug, @summary, @message_count, @contributor_count, @last_active, @created_at, @updated_at)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name,
       summary = excluded.summary,
       message_count = excluded.message_count,
       contributor_count = excluded.contributor_count,
       last_active = excluded.last_active,
       created_at = COALESCE(wisdom_topics.created_at, excluded.created_at),
       updated_at = excluded.updated_at`,
  ).run({
    name: topic.name,
    slug: topic.slug,
    summary: topic.summary ?? null,
    message_count: Number(topic.message_count ?? 0),
    contributor_count: Number(topic.contributor_count ?? 0),
    last_active: topic.last_active ?? null,
    created_at: topic.created_at ?? topic.updated_at ?? null,
    updated_at: topic.updated_at ?? topic.created_at ?? null,
  });
}

function resolveTopicIdBySlug(db: Database.Database, slug: string): number {
  const row = db.prepare("SELECT id FROM wisdom_topics WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;
  if (!row) {
    throw new Error(`Missing wisdom topic for slug: ${slug}`);
  }
  return row.id;
}

function upsertWisdomItem(db: Database.Database, item: WisdomItemPayload): void {
  const topicId = resolveTopicIdBySlug(db, item.topic_slug);
  const existing = db
    .prepare("SELECT id FROM wisdom_items WHERE topic_id = ? AND lower(title) = lower(?)")
    .get(topicId, item.title) as { id: number } | undefined;

  const params = {
    topic_id: topicId,
    knowledge_type: item.knowledge_type,
    title: item.title,
    summary: item.summary ?? null,
    source_links: item.source_links ?? "[]",
    source_messages: item.source_messages ?? "[]",
    contributors: item.contributors ?? "[]",
    confidence: Number(item.confidence ?? 0.5),
    created_at: item.created_at ?? item.updated_at ?? null,
    updated_at: item.updated_at ?? item.created_at ?? null,
  };

  if (existing) {
    db.prepare(
      `UPDATE wisdom_items
       SET knowledge_type = @knowledge_type,
           summary = @summary,
           source_links = @source_links,
           source_messages = @source_messages,
           contributors = @contributors,
           confidence = @confidence,
           updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...params, id: existing.id });
    return;
  }

  db.prepare(
    `INSERT INTO wisdom_items
       (topic_id, knowledge_type, title, summary, source_links, source_messages, contributors, confidence, created_at, updated_at)
     VALUES
       (@topic_id, @knowledge_type, @title, @summary, @source_links, @source_messages, @contributors, @confidence, @created_at, @updated_at)`,
  ).run(params);
}

function upsertWisdomRecommendation(
  db: Database.Database,
  recommendation: WisdomRecommendationPayload,
): void {
  const fromTopicId = resolveTopicIdBySlug(db, recommendation.from_topic_slug);
  const toTopicId = resolveTopicIdBySlug(db, recommendation.to_topic_slug);
  const existing = db
    .prepare(
      "SELECT id FROM wisdom_recommendations WHERE from_topic_id = ? AND to_topic_id = ?",
    )
    .get(fromTopicId, toTopicId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE wisdom_recommendations
       SET strength = ?, reason = ?
       WHERE id = ?`,
    ).run(
      Number(recommendation.strength ?? 0),
      recommendation.reason ?? null,
      existing.id,
    );
    return;
  }

  db.prepare(
    `INSERT INTO wisdom_recommendations
       (from_topic_id, to_topic_id, strength, reason)
     VALUES (?, ?, ?, ?)`,
  ).run(
    fromTopicId,
    toTopicId,
    Number(recommendation.strength ?? 0),
    recommendation.reason ?? null,
  );
}

async function ensureMessagePgvectorSchema(pool: Pool): Promise<void> {
  const table = messageTableName();
  const dims = pgvectorDimensions();
  const idxPrefix = `${table}_idx`;
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      message_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      relevance_score DOUBLE PRECISION,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      entities JSONB NOT NULL DEFAULT '[]'::jsonb,
      contribution_flag BOOLEAN NOT NULL DEFAULT FALSE,
      contribution_themes JSONB NOT NULL DEFAULT '[]'::jsonb,
      contribution_hint TEXT,
      alert_level TEXT,
      embedding VECTOR(${dims}) NOT NULL,
      body_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_embedding ON ${table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_tsv ON ${table} USING gin (body_tsv)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_timestamp ON ${table} (timestamp DESC)`,
  );
}

async function ensureLinkPgvectorSchema(pool: Pool): Promise<void> {
  const table = linkTableName();
  const dims = pgvectorDimensions();
  const idxPrefix = `${table}_idx`;
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      link_id BIGINT PRIMARY KEY,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL UNIQUE,
      title TEXT,
      category TEXT,
      relevance TEXT,
      shared_by TEXT,
      source_group TEXT,
      first_seen TEXT,
      last_seen TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      value_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      report_date DATE,
      authored_by TEXT,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      embedding VECTOR(${dims}) NOT NULL,
      search_tsv TSVECTOR GENERATED ALWAYS AS (
        to_tsvector(
          'english',
          coalesce(title, '')
          || ' ' || coalesce(relevance, '')
          || ' ' || coalesce(category, '')
          || ' ' || coalesce(url, '')
          || ' ' || coalesce(shared_by, '')
          || ' ' || coalesce(source_group, '')
          || ' ' || coalesce(authored_by, '')
        )
      ) STORED,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_embedding ON ${table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_tsv ON ${table} USING gin (search_tsv)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${idxPrefix}_last_seen ON ${table} (last_seen DESC)`,
  );
}

async function upsertMessageEmbeddingBatch(
  pool: Pool,
  rows: MessageEmbeddingPayload[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const table = messageTableName();
  const params: unknown[] = [];
  const values = rows.map((row) => {
    const base = params.length;
    params.push(
      row.message_id.trim(),
      row.room_id.trim(),
      row.room_name.trim(),
      row.sender_id.trim(),
      row.sender_name.trim(),
      row.body,
      Math.trunc(Number(row.timestamp)),
      row.relevance_score === null || row.relevance_score === undefined ? null : Number(row.relevance_score),
      parseJsonText(row.topics, "[]"),
      parseJsonText(row.entities, "[]"),
      Boolean(row.contribution_flag),
      parseJsonText(row.contribution_themes, "[]"),
      row.contribution_hint ?? null,
      normalizeAlertLevel(row.alert_level),
      parseEmbeddingLiteral(row.embedding),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10}::jsonb, $${base + 11}, $${base + 12}::jsonb, $${base + 13}, $${base + 14}, $${base + 15}::vector, now())`;
  });
  await pool.query(
    `
      INSERT INTO ${table} (
        message_id, room_id, room_name, sender_id, sender_name, body, timestamp,
        relevance_score, topics, entities, contribution_flag, contribution_themes,
        contribution_hint, alert_level, embedding, updated_at
      ) VALUES ${values.join(", ")}
      ON CONFLICT (message_id) DO UPDATE SET
        room_id = EXCLUDED.room_id,
        room_name = EXCLUDED.room_name,
        sender_id = EXCLUDED.sender_id,
        sender_name = EXCLUDED.sender_name,
        body = EXCLUDED.body,
        timestamp = EXCLUDED.timestamp,
        relevance_score = EXCLUDED.relevance_score,
        topics = EXCLUDED.topics,
        entities = EXCLUDED.entities,
        contribution_flag = EXCLUDED.contribution_flag,
        contribution_themes = EXCLUDED.contribution_themes,
        contribution_hint = EXCLUDED.contribution_hint,
        alert_level = EXCLUDED.alert_level,
        embedding = EXCLUDED.embedding,
        updated_at = now()
    `,
    params,
  );
  return rows.length;
}

async function upsertLinkEmbeddingBatch(
  pool: Pool,
  rows: LinkEmbeddingPayload[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const table = linkTableName();
  const params: unknown[] = [];
  const values = rows.map((row) => {
    const base = params.length;
    params.push(
      Math.trunc(Number(row.link_id)),
      row.url,
      row.url_hash,
      row.title ?? null,
      row.category ?? null,
      row.relevance ?? null,
      row.shared_by ?? null,
      row.source_group ?? null,
      row.first_seen ?? null,
      row.last_seen ?? null,
      Number(row.mention_count ?? 0),
      Number(row.value_score ?? 0),
      row.report_date ? String(row.report_date).trim() || null : null,
      row.authored_by ?? null,
      Boolean(row.pinned),
      parseEmbeddingLiteral(row.embedding),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}::vector, now())`;
  });
  await pool.query(
    `
      INSERT INTO ${table} (
        link_id, url, url_hash, title, category, relevance, shared_by, source_group,
        first_seen, last_seen, mention_count, value_score, report_date, authored_by,
        pinned, embedding, updated_at
      ) VALUES ${values.join(", ")}
      ON CONFLICT (url_hash) DO UPDATE SET
        link_id = EXCLUDED.link_id,
        url = EXCLUDED.url,
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        relevance = EXCLUDED.relevance,
        shared_by = EXCLUDED.shared_by,
        source_group = EXCLUDED.source_group,
        first_seen = EXCLUDED.first_seen,
        last_seen = EXCLUDED.last_seen,
        mention_count = EXCLUDED.mention_count,
        value_score = EXCLUDED.value_score,
        report_date = EXCLUDED.report_date,
        authored_by = EXCLUDED.authored_by,
        pinned = EXCLUDED.pinned,
        embedding = EXCLUDED.embedding,
        updated_at = now()
    `,
    params,
  );
  return rows.length;
}

function createDefaultPgvectorWriter(): PgvectorWriter | null {
  const pool = getPgPool();
  if (!pool) return null;
  return {
    async writeMessageEmbeddings(rows: MessageEmbeddingPayload[]) {
      await ensureMessagePgvectorSchema(pool);
      let written = 0;
      for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_SIZE) {
        written += await upsertMessageEmbeddingBatch(
          pool,
          rows.slice(i, i + EMBEDDING_BATCH_SIZE),
        );
      }
      return written;
    },
    async writeLinkEmbeddings(rows: LinkEmbeddingPayload[]) {
      await ensureLinkPgvectorSchema(pool);
      let written = 0;
      for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_SIZE) {
        written += await upsertLinkEmbeddingBatch(
          pool,
          rows.slice(i, i + EMBEDDING_BATCH_SIZE),
        );
      }
      return written;
    },
  };
}

export async function applyPgvectorPayload(
  payload: PushPayload,
  writer?: PgvectorWriter | null,
): Promise<Pick<PushResult, "message_embeddings_written" | "link_embeddings_written">> {
  const messageEmbeddings = asArray<MessageEmbeddingPayload>(payload.message_embeddings).filter(
    (row) => row && isValidMessageEmbedding(row),
  );
  const linkEmbeddings = asArray<LinkEmbeddingPayload>(payload.link_embeddings).filter(
    (row) => row && isValidLinkEmbedding(row),
  );

  const result = {
    message_embeddings_written: 0,
    link_embeddings_written: 0,
  };
  if (messageEmbeddings.length === 0 && linkEmbeddings.length === 0) {
    return result;
  }

  const resolvedWriter = writer ?? createDefaultPgvectorWriter();
  if (!resolvedWriter) {
    throw new Error("Pgvector is not configured for embedding payloads.");
  }

  if (messageEmbeddings.length > 0) {
    result.message_embeddings_written =
      await resolvedWriter.writeMessageEmbeddings(messageEmbeddings);
  }
  if (linkEmbeddings.length > 0) {
    result.link_embeddings_written =
      await resolvedWriter.writeLinkEmbeddings(linkEmbeddings);
  }
  return result;
}

export async function applyPostgresPayload(
  payload: PushPayload,
): Promise<Omit<PushResult, "message_embeddings_written" | "link_embeddings_written"> | null> {
  if (!corePostgresConfigured()) return null;
  const pool = getPgPool();
  if (!pool) return null;
  await ensurePostgresCoreSchema(pool);

  const records = asArray<RecordPayload>(payload.records);
  const links = asArray<LinkPayload>(payload.links);
  const dailyReports = asArray<DailyReportPayload>(payload.daily_reports);
  const syncStateEntries = sanitizeSyncState(payload.sync_state);
  const messageEmbeddings = asArray<MessageEmbeddingPayload>(payload.message_embeddings).filter(
    (row) => row && isValidMessageEmbedding(row),
  );
  const linkEmbeddings = asArray<LinkEmbeddingPayload>(payload.link_embeddings).filter(
    (row) => row && isValidLinkEmbedding(row),
  );

  const result = {
    messages_written: 0,
    classifications_written: 0,
    links_written: 0,
    daily_reports_written: 0,
    wisdom_topics_written: 0,
    wisdom_items_written: 0,
    wisdom_recommendations_written: 0,
    sync_state_written: 0,
  };

  if (payload.replace_links === true && links.length > 0) {
    await pool.query("DELETE FROM links");
  }

  for (const record of records) {
    const message = record?.message as MessagePayload;
    if (!message || !isValidMessage(message)) {
      throw new Error("Invalid message record in payload.");
    }
    await pool.query(
      `INSERT INTO messages
       (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         room_id = EXCLUDED.room_id,
         room_name = EXCLUDED.room_name,
         sender_id = EXCLUDED.sender_id,
         sender_name = EXCLUDED.sender_name,
         body = EXCLUDED.body,
         timestamp = EXCLUDED.timestamp,
         raw_event = EXCLUDED.raw_event`,
      [
        message.id.trim(),
        message.room_id.trim(),
        message.room_name.trim(),
        message.sender_id.trim(),
        message.sender_name.trim(),
        message.body,
        Math.trunc(Number(message.timestamp)),
        typeof message.raw_event === "string" ? message.raw_event : "{}",
      ],
    );
    result.messages_written += 1;

    const classification = record?.classification;
    if (classification && typeof classification === "object") {
      await pool.query(
        `INSERT INTO classifications
         (message_id, relevance_score, topics, entities, contribution_flag,
          contribution_themes, contribution_hint, alert_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (message_id) DO UPDATE SET
           relevance_score = EXCLUDED.relevance_score,
           topics = EXCLUDED.topics,
           entities = EXCLUDED.entities,
           contribution_flag = EXCLUDED.contribution_flag,
           contribution_themes = EXCLUDED.contribution_themes,
           contribution_hint = EXCLUDED.contribution_hint,
           alert_level = EXCLUDED.alert_level`,
        [
          message.id.trim(),
          toIntScore(classification.relevance_score),
          JSON.stringify(parseJsonList(classification.topics)),
          JSON.stringify(parseJsonList(classification.entities)),
          Boolean(classification.contribution_flag),
          JSON.stringify(parseJsonList(classification.contribution_themes)),
          String(classification.contribution_hint || ""),
          normalizeAlertLevel(classification.alert_level),
        ],
      );
      result.classifications_written += 1;
    }
  }

  for (const row of messageEmbeddings) {
    await pool.query(
      `INSERT INTO messages
       (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')
       ON CONFLICT (id) DO UPDATE SET
         room_id = EXCLUDED.room_id,
         room_name = EXCLUDED.room_name,
         sender_id = EXCLUDED.sender_id,
         sender_name = EXCLUDED.sender_name,
         body = EXCLUDED.body,
         timestamp = EXCLUDED.timestamp`,
      [
        row.message_id.trim(),
        row.room_id.trim(),
        row.room_name.trim(),
        row.sender_id.trim(),
        row.sender_name.trim(),
        row.body,
        Math.trunc(Number(row.timestamp)),
      ],
    );
    await pool.query(
      `INSERT INTO classifications
       (message_id, relevance_score, topics, entities, contribution_flag,
        contribution_themes, contribution_hint, alert_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (message_id) DO UPDATE SET
         relevance_score = EXCLUDED.relevance_score,
         topics = EXCLUDED.topics,
         entities = EXCLUDED.entities,
         contribution_flag = EXCLUDED.contribution_flag,
         contribution_themes = EXCLUDED.contribution_themes,
         contribution_hint = EXCLUDED.contribution_hint,
         alert_level = EXCLUDED.alert_level`,
      [
        row.message_id.trim(),
        toIntScore(row.relevance_score),
        parseJsonText(row.topics),
        parseJsonText(row.entities),
        Boolean(row.contribution_flag),
        parseJsonText(row.contribution_themes),
        row.contribution_hint ?? "",
        normalizeAlertLevel(row.alert_level),
      ],
    );
  }

  for (const link of links) {
    await pool.query(
      `INSERT INTO links
       (url, url_hash, title, category, relevance, shared_by, source_group,
        first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (url_hash) DO UPDATE SET
         url = EXCLUDED.url,
         title = EXCLUDED.title,
         category = EXCLUDED.category,
         relevance = EXCLUDED.relevance,
         shared_by = EXCLUDED.shared_by,
         source_group = EXCLUDED.source_group,
         first_seen = EXCLUDED.first_seen,
         last_seen = EXCLUDED.last_seen,
         mention_count = EXCLUDED.mention_count,
         value_score = EXCLUDED.value_score,
         report_date = EXCLUDED.report_date,
         authored_by = EXCLUDED.authored_by,
         pinned = EXCLUDED.pinned`,
      [
        link.url,
        link.url_hash,
        link.title ?? null,
        link.category ?? null,
        link.relevance ?? null,
        link.shared_by ?? null,
        link.source_group ?? null,
        link.first_seen ?? null,
        link.last_seen ?? null,
        Number(link.mention_count ?? 1),
        Number(link.value_score ?? 0),
        link.report_date ?? null,
        link.authored_by ?? null,
        Number(link.pinned ?? 0),
      ],
    );
    result.links_written += 1;
  }

  for (const row of linkEmbeddings) {
    await pool.query(
      `INSERT INTO links
       (id, url, url_hash, title, category, relevance, shared_by, source_group,
        first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (url_hash) DO UPDATE SET
         url = EXCLUDED.url,
         title = EXCLUDED.title,
         category = EXCLUDED.category,
         relevance = EXCLUDED.relevance,
         shared_by = EXCLUDED.shared_by,
         source_group = EXCLUDED.source_group,
         first_seen = EXCLUDED.first_seen,
         last_seen = EXCLUDED.last_seen,
         mention_count = EXCLUDED.mention_count,
         value_score = EXCLUDED.value_score,
         report_date = EXCLUDED.report_date,
         authored_by = EXCLUDED.authored_by,
         pinned = EXCLUDED.pinned`,
      [
        Math.trunc(Number(row.link_id)),
        row.url,
        row.url_hash,
        row.title ?? null,
        row.category ?? null,
        row.relevance ?? null,
        row.shared_by ?? null,
        row.source_group ?? null,
        row.first_seen ?? null,
        row.last_seen ?? null,
        Number(row.mention_count ?? 1),
        Number(row.value_score ?? 0),
        row.report_date ? String(row.report_date).trim() || null : null,
        row.authored_by ?? null,
        Number(row.pinned ?? 0),
      ],
    );
  }

  for (const report of dailyReports) {
    await pool.query(
      `INSERT INTO daily_reports
       (report_date, briefing_md, briefing_json, contributions, trends, daily_memo,
        conversation_arcs, stats, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (report_date) DO UPDATE SET
         briefing_md = EXCLUDED.briefing_md,
         briefing_json = EXCLUDED.briefing_json,
         contributions = EXCLUDED.contributions,
         trends = EXCLUDED.trends,
         daily_memo = EXCLUDED.daily_memo,
         conversation_arcs = EXCLUDED.conversation_arcs,
         stats = EXCLUDED.stats,
         generated_at = EXCLUDED.generated_at`,
      [
        report.report_date,
        report.briefing_md ?? null,
        report.briefing_json ?? null,
        report.contributions ?? null,
        report.trends ?? null,
        report.daily_memo ?? null,
        report.conversation_arcs ?? null,
        report.stats ?? null,
        report.generated_at ?? null,
      ],
    );
    result.daily_reports_written += 1;
  }

  for (const [key, value] of syncStateEntries) {
    await pool.query(
      `INSERT INTO sync_state (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
    result.sync_state_written += 1;
  }

  return result;
}

export async function backfillPostgresCoreFromEmbeddings(): Promise<{
  messages_backfilled: number;
  links_backfilled: number;
}> {
  const pool = getPgPool();
  if (!pool) {
    throw new Error("Postgres is not configured.");
  }
  await ensurePostgresCoreSchema(pool);
  const messageTable = messageTableName();
  const linkTable = linkTableName();
  const messageResult = await pool.query(`
    INSERT INTO messages (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
    SELECT message_id, room_id, room_name, sender_id, sender_name, body, timestamp, '{}'
    FROM ${messageTable}
    ON CONFLICT (id) DO UPDATE SET
      room_id = EXCLUDED.room_id,
      room_name = EXCLUDED.room_name,
      sender_id = EXCLUDED.sender_id,
      sender_name = EXCLUDED.sender_name,
      body = EXCLUDED.body,
      timestamp = EXCLUDED.timestamp
  `);
  await pool.query(`
    INSERT INTO classifications
      (message_id, relevance_score, topics, entities, contribution_flag,
       contribution_themes, contribution_hint, alert_level)
    SELECT message_id, coalesce(relevance_score, 0)::integer, topics::text, entities::text,
           contribution_flag, contribution_themes::text, contribution_hint, coalesce(alert_level, 'none')
    FROM ${messageTable}
    ON CONFLICT (message_id) DO UPDATE SET
      relevance_score = EXCLUDED.relevance_score,
      topics = EXCLUDED.topics,
      entities = EXCLUDED.entities,
      contribution_flag = EXCLUDED.contribution_flag,
      contribution_themes = EXCLUDED.contribution_themes,
      contribution_hint = EXCLUDED.contribution_hint,
      alert_level = EXCLUDED.alert_level
  `);
  const linkResult = await pool.query(`
    INSERT INTO links
      (id, url, url_hash, title, category, relevance, shared_by, source_group,
       first_seen, last_seen, mention_count, value_score, report_date, authored_by, pinned)
    SELECT link_id, url, url_hash, title, category, relevance, shared_by, source_group,
           first_seen, last_seen, mention_count, value_score, report_date::text, authored_by,
           CASE WHEN pinned THEN 1 ELSE 0 END
    FROM ${linkTable}
    ON CONFLICT (url_hash) DO UPDATE SET
      url = EXCLUDED.url,
      title = EXCLUDED.title,
      category = EXCLUDED.category,
      relevance = EXCLUDED.relevance,
      shared_by = EXCLUDED.shared_by,
      source_group = EXCLUDED.source_group,
      first_seen = EXCLUDED.first_seen,
      last_seen = EXCLUDED.last_seen,
      mention_count = EXCLUDED.mention_count,
      value_score = EXCLUDED.value_score,
      report_date = EXCLUDED.report_date,
      authored_by = EXCLUDED.authored_by,
      pinned = EXCLUDED.pinned
  `);
  return {
    messages_backfilled: messageResult.rowCount || 0,
    links_backfilled: linkResult.rowCount || 0,
  };
}

export function applyPushPayload(
  db: Database.Database,
  payload: PushPayload,
): PushResult {
  const records = asArray<RecordPayload>(payload.records);
  const links = asArray<LinkPayload>(payload.links);
  const dailyReports = asArray<DailyReportPayload>(payload.daily_reports);
  const wisdomTopics = asArray<WisdomTopicPayload>(payload.wisdom_topics);
  const wisdomItems = asArray<WisdomItemPayload>(payload.wisdom_items);
  const wisdomRecommendations = asArray<WisdomRecommendationPayload>(
    payload.wisdom_recommendations,
  );
  const syncStateEntries = sanitizeSyncState(payload.sync_state);

  const insertMessage = db.prepare(
    `INSERT OR REPLACE INTO messages
     (id, room_id, room_name, sender_id, sender_name, body, timestamp, raw_event)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertClassification = db.prepare(
    `INSERT OR REPLACE INTO classifications
     (message_id, relevance_score, topics, entities, contribution_flag, contribution_themes, contribution_hint, alert_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertSyncState = db.prepare(
    "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
  );

  const result: PushResult = {
    messages_written: 0,
    classifications_written: 0,
    links_written: 0,
    daily_reports_written: 0,
    wisdom_topics_written: 0,
    wisdom_items_written: 0,
    wisdom_recommendations_written: 0,
    message_embeddings_written: 0,
    link_embeddings_written: 0,
    sync_state_written: 0,
  };

  const transaction = db.transaction(() => {
    if (payload.replace_links === true && links.length > 0) {
      db.prepare("DELETE FROM links").run();
      db.exec("DROP TABLE IF EXISTS links_fts");
    }

    for (const record of records) {
      const message = record?.message as MessagePayload;
      if (!message || !isValidMessage(message)) {
        throw new Error("Invalid message record in payload.");
      }

      insertMessage.run(
        message.id.trim(),
        message.room_id.trim(),
        message.room_name.trim(),
        message.sender_id.trim(),
        message.sender_name.trim(),
        message.body,
        Math.trunc(Number(message.timestamp)),
        typeof message.raw_event === "string" ? message.raw_event : "{}",
      );
      result.messages_written += 1;

      const classification = record?.classification;
      if (classification && typeof classification === "object") {
        insertClassification.run(
          message.id.trim(),
          toIntScore(classification.relevance_score),
          JSON.stringify(parseJsonList(classification.topics)),
          JSON.stringify(parseJsonList(classification.entities)),
          classification.contribution_flag ? 1 : 0,
          JSON.stringify(parseJsonList(classification.contribution_themes)),
          String(classification.contribution_hint || ""),
          normalizeAlertLevel(classification.alert_level),
        );
        result.classifications_written += 1;
      }
    }

    for (const link of links) {
      upsertLink(db, link);
      syncLinkFtsByUrlHash(db, link.url_hash);
      result.links_written += 1;
    }

    for (const report of dailyReports) {
      upsertDailyReport(db, report);
      result.daily_reports_written += 1;
    }

    for (const topic of wisdomTopics) {
      upsertWisdomTopic(db, topic);
      result.wisdom_topics_written += 1;
    }

    for (const item of wisdomItems) {
      upsertWisdomItem(db, item);
      result.wisdom_items_written += 1;
    }

    for (const recommendation of wisdomRecommendations) {
      upsertWisdomRecommendation(db, recommendation);
      result.wisdom_recommendations_written += 1;
    }

    for (const [key, value] of syncStateEntries) {
      upsertSyncState.run(key, value);
      result.sync_state_written += 1;
    }
  });

  transaction();
  return result;
}
