import { Pool } from "pg";
import Database from "better-sqlite3";
import path from "path";
import {
  buildAtlasSnapshotFromRows,
  type AtlasSnapshot,
  type AtlasMessageRow,
  type AtlasLinkRow,
  type AtlasPeopleInsights,
  type AtlasNewFaceReason,
} from "./atlas";
import { buildLinksFtsQuery, normalizeLinkSearchTerms } from "@/lib/link-search";
import { buildSelfMentionRegex, getSubjectAliases, getSubjectName } from "@/lib/profile";
import {
  computeSemanticAnalytics,
  searchHybridLinks,
  searchHybridMessages,
  searchThreadEvidence,
  type SemanticAnalytics,
} from "@/lib/semantic";


const pool = new Pool({
  connectionString:
    process.env.VIBEZ_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.VIBEZ_PGVECTOR_URL ||
    "postgresql://braydon@localhost:5432/vibez_monitor",
});

const SQLITE_DB_PATH = process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

function shouldUseSqliteAtlas(): boolean {
  return Boolean(
    process.env.VIBEZ_DB_PATH &&
      !process.env.VIBEZ_DATABASE_URL &&
      !process.env.DATABASE_URL &&
      !process.env.VIBEZ_PGVECTOR_URL,
  );
}

const DEFAULT_EXCLUDED_GROUPS = [
  "BBC News",
  "Bloomberg News",
  "MTB Rides",
  "Plum",
];

interface RoomScope {
  mode: "active_groups" | "excluded_groups" | "all";
  activeGroupIds: string[];
  activeGroupNames: string[];
  excludedGroups: string[];
}

type UserAliasMap = Record<string, string>;

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function loadExcludedGroups(): string[] {
  const raw = process.env.VIBEZ_EXCLUDED_GROUPS;
  const base =
    raw === undefined
      ? [...DEFAULT_EXCLUDED_GROUPS]
      : raw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
  if (!isPublicModeEnabled()) return base;

  const publicRaw = process.env.VIBEZ_PUBLIC_EXCLUDED_GROUPS;
  const publicList =
    publicRaw && publicRaw.trim().length > 0
      ? publicRaw
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      : ["goodsense grocers"];

  return Array.from(new Set([...base, ...publicList]));
}

function loadAllowedGroups(): string[] {
  const raw = process.env.VIBEZ_ALLOWED_GROUPS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function isPublicModeEnabled(): boolean {
  const raw = process.env.VIBEZ_PUBLIC_MODE || process.env.NEXT_PUBLIC_VIBEZ_PUBLIC_MODE;
  return typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function normalizeExclusionList(values: string[]): string[] {
  return values
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

function isMissingTableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "42P01");
}

function buildEnvRoomScope(): RoomScope {
  const excludedGroups = normalizeExclusionList(loadExcludedGroups());
  const allowedGroups = loadAllowedGroups();
  if (allowedGroups.length > 0) {
    return {
      mode: "active_groups",
      activeGroupIds: [],
      activeGroupNames: allowedGroups,
      excludedGroups,
    };
  }
  if (excludedGroups.length > 0) {
    return { mode: "excluded_groups", activeGroupIds: [], activeGroupNames: [], excludedGroups };
  }
  return { mode: "all", activeGroupIds: [], activeGroupNames: [], excludedGroups: [] };
}

async function loadRoomScope(pool: Pool): Promise<RoomScope> {
  let beeperActiveGroupIds: string[];
  let beeperActiveGroupNames: string[];
  let googleGroupKeys: string[];
  try {
    const { rows: _beeperIds } = await pool.query(
      "SELECT value FROM sync_state WHERE key = $1",
      ["beeper_active_group_ids"],
    );
    const beeperActiveIdsRow = _beeperIds[0] as { value: string } | undefined;
    beeperActiveGroupIds = parseJsonStringArray(beeperActiveIdsRow?.value);
    const { rows: _beeperNames } = await pool.query(
      "SELECT value FROM sync_state WHERE key = $1",
      ["beeper_active_group_names"],
    );
    const beeperActiveNamesRow = _beeperNames[0] as { value: string } | undefined;
    beeperActiveGroupNames = parseJsonStringArray(beeperActiveNamesRow?.value);
    const { rows: _googleRows } = await pool.query(
      "SELECT value FROM sync_state WHERE key = $1",
      ["google_groups_active_group_keys"],
    );
    const googleGroupsRow = _googleRows[0] as { value: string } | undefined;
    googleGroupKeys = parseJsonStringArray(googleGroupsRow?.value);
  } catch (error) {
    if (isMissingTableError(error)) {
      return buildEnvRoomScope();
    }
    throw error;
  }
  const googleGroupIds = googleGroupKeys.map((key) => `googlegroup:${key}`);

  const activeGroupIds = Array.from(new Set([...beeperActiveGroupIds, ...googleGroupIds]));
  const activeGroupNames = Array.from(new Set([...beeperActiveGroupNames, ...googleGroupKeys]));
  const excludedGroups = normalizeExclusionList(loadExcludedGroups());
  const allowedGroups = loadAllowedGroups();

  if (allowedGroups.length > 0) {
    const allowedGroupSet = new Set(allowedGroups.map((name) => name.toLowerCase()));
    const allowedBeeperGroupIds =
      beeperActiveGroupIds.length === beeperActiveGroupNames.length
        ? beeperActiveGroupIds.filter((_, index) =>
            allowedGroupSet.has((beeperActiveGroupNames[index] || "").toLowerCase()),
          )
        : [];
    const allowedGoogleGroupIds = googleGroupKeys
      .filter((groupKey) => allowedGroupSet.has(groupKey.toLowerCase()))
      .map((groupKey) => `googlegroup:${groupKey}`);
    return {
      mode: "active_groups",
      activeGroupIds: Array.from(new Set([...allowedBeeperGroupIds, ...allowedGoogleGroupIds])),
      activeGroupNames: Array.from(new Set(allowedGroups)),
      excludedGroups,
    };
  }

  if (activeGroupIds.length > 0 || activeGroupNames.length > 0) {
    return { mode: "active_groups", activeGroupIds, activeGroupNames, excludedGroups };
  }
  if (excludedGroups.length > 0) {
    return { mode: "excluded_groups", activeGroupIds: [], activeGroupNames: [], excludedGroups };
  }
  return { mode: "all", activeGroupIds: [], activeGroupNames: [], excludedGroups: [] };
}

export async function getCurrentRoomScope(): Promise<RoomScope> {
  return loadRoomScope(pool);
}

function buildRoomScopeWhere(
  alias: string,
  scope: RoomScope,
  startIndex: number,
): {
  clause: string;
  params: unknown[];
  nextIndex: number;
} {
  let idx = startIndex;
  if (scope.activeGroupIds.length > 0 || scope.activeGroupNames.length > 0) {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (scope.activeGroupIds.length > 0) {
      const phs = scope.activeGroupIds.map(() => `$${idx++}`);
      parts.push(`${alias}.room_id IN (${phs.join(", ")})`);
      params.push(...scope.activeGroupIds);
    }
    if (scope.activeGroupNames.length > 0) {
      const phs = scope.activeGroupNames.map(() => `$${idx++}`);
      parts.push(`LOWER(${alias}.room_name) IN (${phs.join(", ")})`);
      params.push(...scope.activeGroupNames.map((name) => name.toLowerCase()));
    }
    return { clause: `(${parts.join(" OR ")})`, params, nextIndex: idx };
  }
  if (scope.excludedGroups.length > 0) {
    const phs = scope.excludedGroups.map(() => `$${idx++}`);
    return {
      clause: `LOWER(${alias}.room_name) NOT IN (${phs.join(", ")})`,
      params: scope.excludedGroups,
      nextIndex: idx,
    };
  }
  return { clause: "", params: [], nextIndex: idx };
}

function readSqliteSyncState(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function loadSqliteRoomScope(db: Database.Database): RoomScope {
  const beeperActiveGroupIds = parseJsonStringArray(
    readSqliteSyncState(db, "beeper_active_group_ids"),
  );
  const beeperActiveGroupNames = parseJsonStringArray(
    readSqliteSyncState(db, "beeper_active_group_names"),
  );
  const googleGroupKeys = parseJsonStringArray(
    readSqliteSyncState(db, "google_groups_active_group_keys"),
  );
  const googleGroupIds = googleGroupKeys.map((key) => `googlegroup:${key}`);
  const activeGroupIds = Array.from(new Set([...beeperActiveGroupIds, ...googleGroupIds]));
  const activeGroupNames = Array.from(new Set([...beeperActiveGroupNames, ...googleGroupKeys]));
  const excludedGroups = normalizeExclusionList(loadExcludedGroups());
  const allowedGroups = loadAllowedGroups();

  if (allowedGroups.length > 0) {
    const allowedGroupSet = new Set(allowedGroups.map((name) => name.toLowerCase()));
    const allowedBeeperGroupIds =
      beeperActiveGroupIds.length === beeperActiveGroupNames.length
        ? beeperActiveGroupIds.filter((_, index) =>
            allowedGroupSet.has((beeperActiveGroupNames[index] || "").toLowerCase()),
          )
        : [];
    const allowedGoogleGroupIds = googleGroupKeys
      .filter((groupKey) => allowedGroupSet.has(groupKey.toLowerCase()))
      .map((groupKey) => `googlegroup:${groupKey}`);
    return {
      mode: "active_groups",
      activeGroupIds: Array.from(new Set([...allowedBeeperGroupIds, ...allowedGoogleGroupIds])),
      activeGroupNames: Array.from(new Set(allowedGroups)),
      excludedGroups,
    };
  }

  if (activeGroupIds.length > 0 || activeGroupNames.length > 0) {
    return { mode: "active_groups", activeGroupIds, activeGroupNames, excludedGroups };
  }
  if (excludedGroups.length > 0) {
    return { mode: "excluded_groups", activeGroupIds: [], activeGroupNames: [], excludedGroups };
  }
  return { mode: "all", activeGroupIds: [], activeGroupNames: [], excludedGroups: [] };
}

function buildSqliteRoomScopeWhere(alias: string, scope: RoomScope): {
  clause: string;
  params: unknown[];
} {
  if (scope.activeGroupIds.length > 0 || scope.activeGroupNames.length > 0) {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (scope.activeGroupIds.length > 0) {
      parts.push(`${alias}.room_id IN (${scope.activeGroupIds.map(() => "?").join(", ")})`);
      params.push(...scope.activeGroupIds);
    }
    if (scope.activeGroupNames.length > 0) {
      parts.push(
        `LOWER(${alias}.room_name) IN (${scope.activeGroupNames.map(() => "?").join(", ")})`,
      );
      params.push(...scope.activeGroupNames.map((name) => name.toLowerCase()));
    }
    return { clause: `(${parts.join(" OR ")})`, params };
  }
  if (scope.excludedGroups.length > 0) {
    return {
      clause: `LOWER(${alias}.room_name) NOT IN (${scope.excludedGroups.map(() => "?").join(", ")})`,
      params: scope.excludedGroups,
    };
  }
  return { clause: "", params: [] };
}

function buildSqliteLinkScopeWhere(scope: RoomScope): {
  clause: string;
  params: unknown[];
} {
  if (scope.activeGroupNames.length > 0) {
    return {
      clause: `LOWER(source_group) IN (${scope.activeGroupNames.map(() => "?").join(", ")})`,
      params: scope.activeGroupNames.map((name) => name.toLowerCase()),
    };
  }
  if (scope.excludedGroups.length > 0) {
    return {
      clause: `LOWER(source_group) NOT IN (${scope.excludedGroups.map(() => "?").join(", ")})`,
      params: scope.excludedGroups,
    };
  }
  return { clause: "", params: [] };
}

function loadUserAliases(): UserAliasMap {
  const subjectName = getSubjectName();
  const aliases: UserAliasMap = {};
  for (const alias of getSubjectAliases(subjectName)) {
    aliases[alias.toLowerCase()] = subjectName;
  }

  const envRaw = process.env.VIBEZ_USER_ALIASES;
  if (!envRaw) return aliases;

  for (const pair of envRaw.split(",")) {
    const [rawName, canonicalName] = pair.split("=").map((part) => part.trim());
    if (!rawName || !canonicalName) continue;
    aliases[rawName.toLowerCase()] = canonicalName;
  }

  return aliases;
}

function normalizeSenderName(raw: string, aliases: UserAliasMap): string {
  const trimmed = raw.trim();
  if (!trimmed) return "Unknown";
  return aliases[trimmed.toLowerCase()] || trimmed;
}

function buildLinkTermMatchScore(
  alias: string,
  terms: string[],
  startIndex: number,
): {
  sql: string;
  params: unknown[];
  nextIndex: number;
} {
  const searchable = `lower(coalesce(${alias}.title,'') || ' ' || coalesce(${alias}.relevance,'') || ' ' || coalesce(${alias}.category,'') || ' ' || coalesce(${alias}.url,''))`;
  if (!terms.length) {
    return { sql: "0", params: [], nextIndex: startIndex };
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;
  for (const term of terms) {
    clauses.push(`CASE WHEN ${searchable} LIKE $${idx++} THEN $${idx++} ELSE 0 END`);
    params.push(`%${term.toLowerCase()}%`, term.length);
  }
  return { sql: clauses.join(" + "), params, nextIndex: idx };
}



export interface Message {
  id: string;
  room_id: string;
  room_name: string;
  sender_id: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  entities: string | null;
  contribution_flag: number | null;
  contribution_themes: string | null;
  contribution_hint: string | null;
  alert_level: string | null;
}

export interface DailyReport {
  id: number;
  report_date: string;
  briefing_md: string | null;
  briefing_json: string | null;
  contributions: string | null;
  trends: string | null;
  daily_memo: string | null;
  conversation_arcs: string | null;
  stats: string | null;
  generated_at: string | null;
}

export interface RecentUpdateQuote {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

export interface RecentUpdateTopic {
  topic: string;
  count: number;
}

export interface RecentUpdateChannel {
  name: string;
  count: number;
}

export interface RecentUpdateSnapshot {
  window_start_iso: string;
  window_end_iso: string;
  window_label: string;
  next_refresh_iso: string;
  next_refresh_label: string;
  refresh_cadence: string;
  message_count: number;
  active_users: number;
  active_channels: number;
  top_topics: RecentUpdateTopic[];
  top_channels: RecentUpdateChannel[];
  quotes: RecentUpdateQuote[];
  summary: string;
}

export interface VibezRadarGapQuote {
  id: string;
  timestamp: number;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
}

export interface VibezRadarGap {
  topic: string;
  message_count: number;
  people: number;
  channels: number;
  first_seen: string;
  last_seen: string;
  avg_relevance: number | null;
  reason: string;
  sample_quote: VibezRadarGapQuote | null;
}

export interface VibezRadarRedundancy {
  type: "thread_overlap" | "message_duplication";
  score_pct: number;
  title: string;
  detail: string;
}

export interface VibezRadarThreadQuality {
  thread_title: string;
  evidence_messages: number;
  evidence_people: number;
  newest_evidence: string | null;
  quality: "strong" | "mixed" | "thin";
  notes: string[];
}

export interface VibezRadarSnapshot {
  generated_at: string;
  window_hours: number;
  window_start_iso: string;
  coverage: {
    topic_coverage_pct: number;
    classification_coverage_pct: number;
    duplicate_pressure_pct: number;
  };
  totals: {
    messages: number;
    people: number;
    channels: number;
    briefing_threads: number;
  };
  gaps: VibezRadarGap[];
  redundancies: VibezRadarRedundancy[];
  thread_quality: VibezRadarThreadQuality[];
}

export type ContributionNeedType =
  | "decision"
  | "information"
  | "coordination"
  | "creation"
  | "support"
  | "none";

export type ContributionAxisKey =
  | "urgency"
  | "need_strength"
  | "aging_risk"
  | "leverage"
  | "strategic_fit"
  | "comparative_advantage"
  | "effort_to_value"
  | "dependency_blocker"
  | "relationship_stakes"
  | "risk_if_ignored"
  | "recurrence_signal"
  | "confidence";

export interface ContributionAxes {
  urgency: number;
  need_strength: number;
  aging_risk: number;
  leverage: number;
  strategic_fit: number;
  comparative_advantage: number;
  effort_to_value: number;
  dependency_blocker: number;
  relationship_stakes: number;
  risk_if_ignored: number;
  recurrence_signal: number;
  confidence: number;
}

export interface ContributionOpportunity {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  alert_level: string | null;
  topics: string[];
  contribution_themes: string[];
  entities: string[];
  contribution_hint: string | null;
  need_type: ContributionNeedType;
  hours_old: number;
  priority_score: number;
  axes: ContributionAxes;
  reasons: string[];
}

export interface ContributionSection {
  key:
    | "act_now"
    | "high_leverage"
    | "aging_risk"
    | "blocked"
    | "relationship"
    | "quick_wins";
  label: string;
  description: string;
  items: ContributionOpportunity[];
}

export interface ContributionAxisSummary {
  axis: ContributionAxisKey;
  label: string;
  average: number;
  high_count: number;
}

export interface ContributionNeedSummary {
  need_type: ContributionNeedType;
  count: number;
}

export interface RecurringContributionTheme {
  theme: string;
  messages: number;
  avg_priority: number;
  latest_seen: string;
  channels: string[];
  dominant_need_type: ContributionNeedType;
}

export interface ContributionDashboard {
  generated_at: string;
  lookback_days: number;
  totals: {
    messages: number;
    opportunities: number;
    act_now: number;
    high_leverage: number;
    aging_risk: number;
    blocked: number;
  };
  axis_summary: ContributionAxisSummary[];
  need_summary: ContributionNeedSummary[];
  recurring_themes: RecurringContributionTheme[];
  opportunities: ContributionOpportunity[];
  sections: ContributionSection[];
}

export async function getMessages(opts: {
  limit?: number;
  offset?: number;
  room?: string;
  minRelevance?: number;
  contributionOnly?: boolean;
}): Promise<Message[]> {
  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 1);
  const userAliases = loadUserAliases();
  let query = `
    SELECT m.*, c.relevance_score, c.topics, c.entities,
           c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
    FROM messages m
    LEFT JOIN classifications c ON m.id = c.message_id
    WHERE 1=1
  `;
  let pi = roomScope.nextIndex;
  const params: unknown[] = [...roomScope.params];

  if (roomScope.clause) {
    query += ` AND ${roomScope.clause}`;
  }
  if (opts.room) {
    query += ` AND m.room_name = $${pi++}`;
    params.push(opts.room);
  }
  if (opts.minRelevance) {
    query += ` AND c.relevance_score >= $${pi++}`;
    params.push(opts.minRelevance);
  }
  if (opts.contributionOnly) {
    query += " AND c.contribution_flag = 1";
  }

  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  query += ` ORDER BY m.timestamp DESC LIMIT $${pi++} OFFSET $${pi++}`;
  params.push(limit, offset);

  const { rows } = await pool.query(query, params);
  return (rows as Message[]).map((row) => ({
    ...row,
    sender_name: normalizeSenderName(row.sender_name, userAliases),
  }));
}

const CONTRIBUTION_AXIS_LABELS: Record<ContributionAxisKey, string> = {
  urgency: "Urgency",
  need_strength: "Need Strength",
  aging_risk: "Aging Risk",
  leverage: "Leverage",
  strategic_fit: "Strategic Fit",
  comparative_advantage: "Comparative Advantage",
  effort_to_value: "Effort to Value",
  dependency_blocker: "Dependency / Blocker",
  relationship_stakes: "Relationship Stakes",
  risk_if_ignored: "Risk if Ignored",
  recurrence_signal: "Recurrence Signal",
  confidence: "Confidence",
};

const URGENCY_RE =
  /\b(urgent|asap|today|tonight|tomorrow|deadline|immediately|time[-\s]?sensitive|quick turn|before [a-z0-9]|eod)\b/i;
const NEED_RE =
  /\b(can you|could you|would you|please|need\b|looking for|anyone know|who can|help\b|thoughts\?|what do you think|can we|should we|should i)\b/i;
const DECISION_RE = /\b(decide|decision|choose|which option|trade[-\s]?off|should we|should i|go\/no-go)\b/i;
const INFORMATION_RE =
  /\b(anyone know|what is|how do|docs?|reference|clarify|details?|evidence|source)\b/i;
const COORDINATION_RE =
  /\b(schedule|meet|call|sync|coordinate|available|join|timeline|when can|calendar)\b/i;
const CREATION_RE =
  /\b(build|ship|write|draft|prototype|implement|code|create|design|publish)\b/i;
const SUPPORT_RE =
  /\b(stuck|frustrated|overwhelmed|unsure|confused|need support|could use help)\b/i;
const DEPENDENCY_RE =
  /\b(blocked|waiting on|pending approval|stuck on|cannot proceed|can't proceed|unblock|hold up)\b/i;
const RISK_RE =
  /\b(risk|security|broken|bug|issue|problem|incident|failure|outage|misinformation|wrong)\b/i;
const HIGH_EFFORT_RE =
  /\b(comprehensive|deep dive|full plan|big refactor|architecture|research packet|end-to-end)\b/i;
const QUICK_WIN_RE = /\b(quick|small|short|simple|one-liner|fast)\b/i;
const GROUP_IMPACT_RE = /\b(we|team|everyone|anyone|community|group|channel)\b/i;
const SELF_MENTION_RE = buildSelfMentionRegex();

interface ContributionRawRow {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  entities: string | null;
  contribution_flag: number | null;
  contribution_themes: string | null;
  contribution_hint: string | null;
  alert_level: string | null;
}

interface ContributionPrep {
  row: ContributionRawRow;
  sender_name: string;
  body: string;
  text: string;
  topics: string[];
  entities: string[];
  themes: string[];
  need_type: ContributionNeedType;
  has_explicit_need: boolean;
  has_question: boolean;
  has_dependency: boolean;
  has_self_mention: boolean;
}

function clampScore(value: number, min = 0, max = 10): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function inferNeedType(text: string): ContributionNeedType {
  if (DECISION_RE.test(text)) return "decision";
  if (COORDINATION_RE.test(text)) return "coordination";
  if (CREATION_RE.test(text)) return "creation";
  if (SUPPORT_RE.test(text)) return "support";
  if (INFORMATION_RE.test(text)) return "information";
  return "none";
}

function dominantNeedType(counts: Map<ContributionNeedType, number>): ContributionNeedType {
  let top: ContributionNeedType = "none";
  let topCount = -1;
  for (const [needType, count] of counts.entries()) {
    if (count > topCount) {
      top = needType;
      topCount = count;
    }
  }
  return top;
}

interface ContributionDashboardOpts {
  lookbackDays?: number;
  limit?: number;
}

export async function getContributionDashboard(
  opts: ContributionDashboardOpts = {},
): Promise<ContributionDashboard> {
  const resolvedWindow = resolveWindowDays(opts.lookbackDays ?? 45) ?? 45;
  const limit = Math.max(50, Math.min(opts.limit ?? 600, 2000));
  const cutoffTs = Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;

  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope, 1);

  let pi = roomScope.nextIndex;
  const whereParts = [`m.timestamp >= $${pi++}`];
  const whereParams: unknown[] = [];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    whereParams.push(...roomScope.params);
  }
  whereParams.push(cutoffTs);
  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  const { rows } = await pool.query(
    `SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
            c.relevance_score, c.topics, c.entities, c.contribution_flag,
            c.contribution_themes, c.contribution_hint, c.alert_level
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     ${whereClause}
     AND (c.contribution_flag = 1 OR c.alert_level = 'hot' OR (c.contribution_hint IS NOT NULL AND trim(c.contribution_hint) != ''))
     ORDER BY m.timestamp DESC
     LIMIT $${pi++}`,
    [...whereParams, limit],
  );
  const rowsData = rows as ContributionRawRow[];

  const { rows: totalRows } = await pool.query(
    `SELECT count(*) as count FROM messages m ${whereClause}`,
    whereParams,
  );
  const totalRow = totalRows[0] as { count: number } | undefined;

  const { rows: _vr } = await pool.query(
    "SELECT key, value FROM value_config WHERE key IN ($1, $2)",
    ["topics", "projects"],
  );
  const valueRows = _vr as { key: string; value: string }[];

  const valueLexicon = new Set<string>();
  for (const row of valueRows) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        const term = String(item).trim().toLowerCase();
        if (term.length > 2) valueLexicon.add(term);
      }
    } catch {
      continue;
    }
  }
  const lexiconTerms = Array.from(valueLexicon);

  const prepped: ContributionPrep[] = rowsData.map((row) => {
    const body = row.body || "";
    const hint = row.contribution_hint || "";
    const text = `${body}\n${hint}`.toLowerCase();
    const themes = parseTopics(row.contribution_themes);
    const topics = parseTopics(row.topics);
    const entities = parseTopics(row.entities);
    const needType = inferNeedType(text);
    return {
      row,
      sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
      body,
      text,
      topics,
      entities,
      themes: themes.length > 0 ? themes : topics.slice(0, 2),
      need_type: needType,
      has_explicit_need: NEED_RE.test(text),
      has_question: text.includes("?"),
      has_dependency: DEPENDENCY_RE.test(text),
      has_self_mention: SELF_MENTION_RE.test(text),
    };
  });

  const senderCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();
  const themeCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();

  for (const item of prepped) {
    senderCounts.set(item.sender_name, (senderCounts.get(item.sender_name) || 0) + 1);
    channelCounts.set(item.row.room_name, (channelCounts.get(item.row.room_name) || 0) + 1);
    for (const theme of new Set(item.themes)) {
      themeCounts.set(theme, (themeCounts.get(theme) || 0) + 1);
    }
    for (const topic of new Set(item.topics)) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  const senderMax = Math.max(1, ...Array.from(senderCounts.values()));
  const channelMax = Math.max(1, ...Array.from(channelCounts.values()));

  const opportunities: ContributionOpportunity[] = prepped.map((item) => {
    const now = Date.now();
    const hoursOld = Math.max(0, (now - item.row.timestamp) / (1000 * 60 * 60));
    const themeSignal = Math.max(
      1,
      ...item.themes.map((theme) => themeCounts.get(theme) || 1),
    );
    const topicSignal = Math.max(
      1,
      ...item.topics.map((topic) => topicCounts.get(topic) || 1),
    );
    const senderSignal = senderCounts.get(item.sender_name) || 1;
    const channelSignal = channelCounts.get(item.row.room_name) || 1;

    const hasValueMatch = lexiconTerms.some(
      (term) =>
        item.text.includes(term) ||
        item.topics.some((topic) => topic.toLowerCase().includes(term)),
    );

    const freshnessScore =
      hoursOld <= 6
        ? 10
        : hoursOld <= 24
          ? 8
          : hoursOld <= 72
            ? 6
            : hoursOld <= 168
              ? 4
              : hoursOld <= 336
                ? 3
                : 2;

    const urgency = clampScore(
      (item.row.alert_level === "hot" ? 4 : item.row.alert_level === "digest" ? 1 : 0) +
        (URGENCY_RE.test(item.text) ? 3 : 0) +
        (item.has_explicit_need ? 1 : 0) +
        (item.has_dependency ? 1 : 0) +
        (freshnessScore >= 8 ? 2 : freshnessScore >= 6 ? 1 : 0),
    );

    const needStrength = clampScore(
        (item.has_explicit_need ? 4 : 0) +
        (item.has_question ? 2 : 0) +
        (item.row.contribution_hint ? 2 : 0) +
        (item.need_type !== "none" ? 1.5 : 0) +
        (item.has_self_mention ? 1 : 0),
    );

    const agingBase =
      hoursOld < 12
        ? 1
        : hoursOld < 24
          ? 3
          : hoursOld < 72
            ? 6
            : hoursOld < 168
              ? 8
              : hoursOld < 336
                ? 9
                : 7;
    const agingRisk = clampScore(
      agingBase + (needStrength >= 7 ? 1 : 0) + (item.has_dependency ? 1 : 0),
    );

    const leverage = clampScore(
      1 +
        Math.min(4, Math.log2(themeSignal + 1) * 1.8) +
        Math.min(2, Math.log2(topicSignal + 1) * 1.2) +
        (GROUP_IMPACT_RE.test(item.text) ? 1 : 0) +
        (item.themes.length > 1 ? 1 : 0) +
        (channelSignal >= Math.max(6, channelMax * 0.2) ? 1 : 0),
    );

    const strategicFit = clampScore(
      (item.row.relevance_score ?? 0) * 0.65 +
        ((item.row.contribution_flag || 0) > 0 ? 2 : 0) +
        (item.row.contribution_hint ? 1 : 0) +
        (hasValueMatch ? 2 : 0),
    );

    const comparativeAdvantage = clampScore(
      (item.has_self_mention ? 3 : 0) +
        (item.row.contribution_hint ? 2 : 0) +
        (hasValueMatch ? 2 : 0) +
        ((item.row.relevance_score ?? 0) >= 8 ? 1.5 : 0) +
        (item.themes.length > 0 ? 1 : 0) +
        (item.entities.length > 0 ? 0.5 : 0),
    );

    const effortPenalty =
      (HIGH_EFFORT_RE.test(item.text) ? 3 : 0) +
      (item.body.length > 500 ? 1 : 0) +
      (item.body.length > 1000 ? 1 : 0) +
      (item.body.includes("\n") ? 0.5 : 0);
    const valuePotential = urgency * 0.35 + needStrength * 0.3 + strategicFit * 0.35;
    const effortToValue = clampScore(
      valuePotential * 0.85 - effortPenalty + (QUICK_WIN_RE.test(item.text) ? 2 : 0),
    );

    const dependencyBlocker = clampScore(
      (item.has_dependency ? 5 : 0) +
        (item.need_type === "coordination" ? 2 : 0) +
        (item.has_explicit_need ? 1.5 : 0) +
        (urgency >= 7 ? 1.5 : 0),
    );

    const relationshipStakes = clampScore(
      2 +
        Math.min(3, Math.log2(senderSignal + 1) * 1.1) +
        (item.has_self_mention ? 2 : 0) +
        (senderSignal >= Math.max(4, senderMax * 0.15) ? 2 : 0) +
        (item.row.room_name.toLowerCase().includes("vibez") ? 0.5 : 0),
    );

    const riskIfIgnored = clampScore(
      urgency * 0.35 +
        needStrength * 0.2 +
        dependencyBlocker * 0.25 +
        (RISK_RE.test(item.text) ? 2 : 0) +
        (item.row.alert_level === "hot" ? 1.5 : 0),
    );

    const recurrenceSignal = clampScore(
      Math.min(4, Math.log2(themeSignal + 1) * 1.7) +
        Math.min(3, Math.log2(topicSignal + 1) * 1.4) +
        (item.themes.length > 1 ? 1 : 0) +
        (themeSignal >= 3 ? 1 : 0),
    );

    const confidence = clampScore(
      3 +
        (item.row.contribution_hint ? 2 : 0) +
        (item.row.relevance_score !== null ? 1 : 0) +
        (item.themes.length > 0 ? 1 : 0) +
        (item.topics.length > 0 ? 1 : 0) +
        (item.need_type !== "none" ? 1 : 0) -
        (item.body.length < 20 ? 1 : 0),
    );

    const axes: ContributionAxes = {
      urgency: Number(urgency.toFixed(2)),
      need_strength: Number(needStrength.toFixed(2)),
      aging_risk: Number(agingRisk.toFixed(2)),
      leverage: Number(leverage.toFixed(2)),
      strategic_fit: Number(strategicFit.toFixed(2)),
      comparative_advantage: Number(comparativeAdvantage.toFixed(2)),
      effort_to_value: Number(effortToValue.toFixed(2)),
      dependency_blocker: Number(dependencyBlocker.toFixed(2)),
      relationship_stakes: Number(relationshipStakes.toFixed(2)),
      risk_if_ignored: Number(riskIfIgnored.toFixed(2)),
      recurrence_signal: Number(recurrenceSignal.toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
    };

    const priorityRaw =
      axes.urgency * 0.16 +
      axes.need_strength * 0.14 +
      axes.aging_risk * 0.08 +
      axes.leverage * 0.11 +
      axes.strategic_fit * 0.11 +
      axes.comparative_advantage * 0.09 +
      axes.effort_to_value * 0.08 +
      axes.dependency_blocker * 0.08 +
      axes.relationship_stakes * 0.05 +
      axes.risk_if_ignored * 0.06 +
      axes.recurrence_signal * 0.08 +
      axes.confidence * 0.06;
    const priorityScore = Number((priorityRaw * 10).toFixed(1));

    const reasons: string[] = [];
    if (axes.urgency >= 7) reasons.push("Time-sensitive signal");
    if (axes.need_strength >= 7) reasons.push("Explicit ask or strong need");
    if (axes.dependency_blocker >= 7) reasons.push("Potential blocker if unanswered");
    if (axes.leverage >= 7 || axes.recurrence_signal >= 7) {
      reasons.push("Recurring pattern with broader leverage");
    }
    if (axes.strategic_fit >= 7 || axes.comparative_advantage >= 7) {
      reasons.push("Strong fit with your current focus and edge");
    }
    if (axes.aging_risk >= 7) reasons.push("Aging thread may lose value soon");
    if (axes.risk_if_ignored >= 7) reasons.push("Higher downside if ignored");

    return {
      id: item.row.id,
      room_name: item.row.room_name,
      sender_name: item.sender_name,
      body: item.body,
      timestamp: item.row.timestamp,
      relevance_score: item.row.relevance_score,
      alert_level: item.row.alert_level,
      topics: item.topics,
      contribution_themes: item.themes,
      entities: item.entities,
      contribution_hint: item.row.contribution_hint,
      need_type: item.need_type,
      hours_old: Number(hoursOld.toFixed(1)),
      priority_score: priorityScore,
      axes,
      reasons: reasons.slice(0, 4),
    };
  });

  opportunities.sort((a, b) => {
    if (b.priority_score !== a.priority_score) {
      return b.priority_score - a.priority_score;
    }
    return b.timestamp - a.timestamp;
  });

  const needSummary = new Map<ContributionNeedType, number>();
  for (const opp of opportunities) {
    needSummary.set(opp.need_type, (needSummary.get(opp.need_type) || 0) + 1);
  }
  const need_summary: ContributionNeedSummary[] = Array.from(needSummary.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([need_type, count]) => ({ need_type, count }));

  const recurringThemeMap = new Map<
    string,
    {
      messages: number;
      priorityTotal: number;
      latestTs: number;
      channels: Set<string>;
      needTypeCounts: Map<ContributionNeedType, number>;
    }
  >();

  for (const opp of opportunities) {
    const themes = opp.contribution_themes.length > 0 ? opp.contribution_themes : ["uncategorized"];
    for (const theme of themes) {
      const prev = recurringThemeMap.get(theme) || {
        messages: 0,
        priorityTotal: 0,
        latestTs: 0,
        channels: new Set<string>(),
        needTypeCounts: new Map<ContributionNeedType, number>(),
      };
      prev.messages += 1;
      prev.priorityTotal += opp.priority_score;
      prev.latestTs = Math.max(prev.latestTs, opp.timestamp);
      prev.channels.add(opp.room_name);
      prev.needTypeCounts.set(
        opp.need_type,
        (prev.needTypeCounts.get(opp.need_type) || 0) + 1,
      );
      recurringThemeMap.set(theme, prev);
    }
  }

  const recurring_themes: RecurringContributionTheme[] = Array.from(recurringThemeMap.entries())
    .map(([theme, value]) => ({
      theme,
      messages: value.messages,
      avg_priority: Number((value.priorityTotal / Math.max(1, value.messages)).toFixed(1)),
      latest_seen: dateKeyFromTs(value.latestTs),
      channels: Array.from(value.channels).slice(0, 5),
      dominant_need_type: dominantNeedType(value.needTypeCounts),
    }))
    .filter((item) => item.messages >= 2)
    .sort((a, b) => {
      if (b.messages !== a.messages) return b.messages - a.messages;
      return b.avg_priority - a.avg_priority;
    })
    .slice(0, 15);

  const actNowItems = opportunities
    .filter(
      (item) =>
        item.priority_score >= 68 &&
        (item.axes.urgency >= 6 ||
          item.axes.dependency_blocker >= 6 ||
          item.axes.risk_if_ignored >= 6 ||
          item.axes.need_strength >= 7),
    )
    .slice(0, 20);
  const highLeverageItems = opportunities
    .filter((item) => item.axes.leverage >= 7 || item.axes.recurrence_signal >= 7)
    .slice(0, 20);
  const agingItems = opportunities
    .filter((item) => item.axes.aging_risk >= 7 && item.axes.need_strength >= 5)
    .sort((a, b) => b.axes.aging_risk - a.axes.aging_risk || b.priority_score - a.priority_score)
    .slice(0, 20);
  const blockedItems = opportunities
    .filter((item) => item.axes.dependency_blocker >= 7)
    .sort(
      (a, b) =>
        b.axes.dependency_blocker - a.axes.dependency_blocker ||
        b.priority_score - a.priority_score,
    )
    .slice(0, 20);
  const relationshipItems = opportunities
    .filter((item) => item.axes.relationship_stakes >= 7 && item.axes.need_strength >= 5)
    .slice(0, 20);
  const quickWinItems = opportunities
    .filter((item) => item.axes.effort_to_value >= 7 && item.axes.need_strength >= 5)
    .slice(0, 20);

  const sections: ContributionSection[] = [
    {
      key: "act_now",
      label: "Act Now",
      description: "Time-sensitive threads with high downside if delayed.",
      items: actNowItems,
    },
    {
      key: "high_leverage",
      label: "High Leverage",
      description: "Responses likely to help multiple people or recurring conversations.",
      items: highLeverageItems,
    },
    {
      key: "aging_risk",
      label: "Aging Risk",
      description: "Opportunities where value decays as threads age.",
      items: agingItems,
    },
    {
      key: "blocked",
      label: "Blocked / Waiting",
      description: "Threads signaling dependencies, waiting, or execution blockers.",
      items: blockedItems,
    },
    {
      key: "relationship",
      label: "Relationship Stakes",
      description: "Conversations where responsiveness affects key collaborators.",
      items: relationshipItems,
    },
    {
      key: "quick_wins",
      label: "Quick Wins",
      description: "Good effort-to-value opportunities to keep momentum high.",
      items: quickWinItems,
    },
  ];

  const axis_summary: ContributionAxisSummary[] = (
    Object.keys(CONTRIBUTION_AXIS_LABELS) as ContributionAxisKey[]
  ).map((axis) => {
    const values = opportunities.map((item) => item.axes[axis]);
    const average =
      values.length > 0
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : 0;
    const high_count = values.filter((value) => value >= 7).length;
    return {
      axis,
      label: CONTRIBUTION_AXIS_LABELS[axis],
      average,
      high_count,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    lookback_days: resolvedWindow,
    totals: {
      messages: totalRow?.count || 0,
      opportunities: opportunities.length,
      act_now: actNowItems.length,
      high_leverage: highLeverageItems.length,
      aging_risk: agingItems.length,
      blocked: blockedItems.length,
    },
    axis_summary,
    need_summary,
    recurring_themes,
    opportunities,
    sections,
  };
}

export async function getLatestReport(): Promise<DailyReport | null> {
  const { rows } = await pool.query(
    "SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1",
  );
  return (rows[0] as DailyReport | undefined) || null;
}

export async function getReport(date: string): Promise<DailyReport | null> {
  const { rows } = await pool.query(
    "SELECT * FROM daily_reports WHERE report_date = $1",
    [date],
  );
  return (rows[0] as DailyReport | undefined) || null;
}

export async function getPreviousReport(beforeDate: string): Promise<DailyReport | null> {
  const { rows } = await pool.query(
    "SELECT * FROM daily_reports WHERE report_date < $1 ORDER BY report_date DESC LIMIT 1",
    [beforeDate],
  );
  return (rows[0] as DailyReport | undefined) || null;
}

function computeRecentUpdateWindow(now: Date): {
  windowStart: Date;
  windowEnd: Date;
  nextRefresh: Date;
} {
  const morning = new Date(now);
  morning.setHours(4, 30, 0, 0);
  const evening = new Date(now);
  evening.setHours(16, 30, 0, 0);

  if (now.getTime() >= evening.getTime()) {
    return {
      windowStart: evening,
      windowEnd: now,
      nextRefresh: new Date(evening.getTime() + 12 * 60 * 60 * 1000),
    };
  }
  if (now.getTime() >= morning.getTime()) {
    return {
      windowStart: morning,
      windowEnd: now,
      nextRefresh: evening,
    };
  }

  const previousEvening = new Date(evening);
  previousEvening.setDate(previousEvening.getDate() - 1);
  return {
    windowStart: previousEvening,
    windowEnd: now,
    nextRefresh: morning,
  };
}

function formatRecentUpdateWindowLabel(windowStart: Date, now: Date): string {
  const sameDay = windowStart.toDateString() === now.toDateString();
  if (sameDay) {
    return `Since ${windowStart.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return `Since ${windowStart.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function formatRecentUpdateNextRefreshLabel(nextRefresh: Date): string {
  return nextRefresh.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface RecentUpdateRow {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
}

function pickRecentQuotes(rows: RecentUpdateRow[], userAliases: UserAliasMap): RecentUpdateQuote[] {
  const senderCounts = new Map<string, number>();
  return rows
    .filter((row) => {
      const body = (row.body || "").trim();
      if (body.length < 70) return false;
      if (/^https?:\/\//i.test(body)) return false;
      const sender = normalizeSenderName(row.sender_name || "Unknown", userAliases).toLowerCase();
      if (sender.includes("whatsappbot")) return false;
      return true;
    })
    .map((row) => {
      const hoursOld = Math.max(0, (Date.now() - row.timestamp) / (1000 * 60 * 60));
      const recencyBonus = Math.max(0, 12 - hoursOld) * 0.18;
      const relevance = row.relevance_score ?? 0;
      const score = relevance * 2 + recencyBonus;
      return { row, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ row }) => {
      const senderName = normalizeSenderName(row.sender_name || "Unknown", userAliases);
      const count = senderCounts.get(senderName) || 0;
      if (count >= 1) return false;
      senderCounts.set(senderName, count + 1);
      return true;
    })
    .slice(0, 3)
    .map(({ row }) => ({
      id: row.id,
      room_name: row.room_name,
      sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
      body: row.body || "",
      timestamp: row.timestamp,
      relevance_score: row.relevance_score,
    }));
}

export async function getRecentUpdateSnapshot(): Promise<RecentUpdateSnapshot> {
  const now = new Date();
  const { windowStart, windowEnd, nextRefresh } = computeRecentUpdateWindow(now);
  const windowStartTs = windowStart.getTime();
  const windowEndTs = windowEnd.getTime();

  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 1);
  const userAliases = loadUserAliases();

  let pi = roomScope.nextIndex;
  const whereParts = [`m.timestamp >= $${pi++}`, `m.timestamp <= $${pi++}`];
  const whereParams: unknown[] = [];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    whereParams.push(...roomScope.params);
  }
  whereParams.push(windowStartTs, windowEndTs);
  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  const { rows } = await pool.query(
    `SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
            c.relevance_score, c.topics
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     ${whereClause}
     ORDER BY m.timestamp DESC
     LIMIT 2500`,
    whereParams,
  );
  const rowsData = rows as RecentUpdateRow[];

  const uniqueSenders = new Set<string>();
  const channelCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const row of rowsData) {
    uniqueSenders.add(normalizeSenderName(row.sender_name || "Unknown", userAliases));
    channelCounts.set(row.room_name, (channelCounts.get(row.room_name) || 0) + 1);
    for (const topic of new Set(parseTopics(row.topics))) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }

  const top_topics = Array.from(topicCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([topic, count]) => ({ topic, count }));

  const top_channels = Array.from(channelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => ({ name, count }));

  const quotes = pickRecentQuotes(rowsData, userAliases);
  const messageCount = rowsData.length;
  const topTopicLabels = top_topics.slice(0, 3).map((item) => item.topic);
  const topChannelLabels = top_channels.slice(0, 2).map((item) => item.name);
  let summary = "";
  if (messageCount === 0) {
    summary = `${formatRecentUpdateWindowLabel(windowStart, now)}: no new messages yet in this refresh window.`;
  } else {
    const summaryParts = [
      `${messageCount} messages`,
      `from ${uniqueSenders.size} people`,
      `across ${channelCounts.size} channel${channelCounts.size === 1 ? "" : "s"}`,
    ];
    summary = `${formatRecentUpdateWindowLabel(windowStart, now)}: ${summaryParts.join(" ")}.`;
    if (topTopicLabels.length > 0) {
      summary += ` Top topics: ${topTopicLabels.join(", ")}.`;
    }
    if (topChannelLabels.length > 0) {
      summary += ` Most active: ${topChannelLabels.join(", ")}.`;
    }
  }

  return {
    window_start_iso: windowStart.toISOString(),
    window_end_iso: windowEnd.toISOString(),
    window_label: formatRecentUpdateWindowLabel(windowStart, now),
    next_refresh_iso: nextRefresh.toISOString(),
    next_refresh_label: formatRecentUpdateNextRefreshLabel(nextRefresh),
    refresh_cadence: "4:30 AM / 4:30 PM",
    message_count: messageCount,
    active_users: uniqueSenders.size,
    active_channels: channelCounts.size,
    top_topics,
    top_channels,
    quotes,
    summary,
  };
}

interface AtlasPeopleWindowRow {
  id: string;
  room_id: string | null;
  room_name: string | null;
  sender_id: string | null;
  sender_name: string | null;
  body: string | null;
  timestamp: number;
  raw_event: string | null;
}

interface AtlasPersonFirstSeenRow {
  person_key: string | null;
  first_ts: number | string | null;
}

const PHONE_LIKE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/;

function pushLimitedUnique<T>(items: T[], item: T, limit: number): void {
  if (items.includes(item)) return;
  if (items.length >= limit) return;
  items.push(item);
}

function atlasPersonKeys(row: AtlasPeopleWindowRow, aliases: UserAliasMap): string[] {
  const keys = new Set<string>();
  const senderId = String(row.sender_id || "").trim();
  const rawName = String(row.sender_name || "").trim();
  const normalizedName = normalizeSenderName(rawName || "Unknown", aliases);
  if (senderId) keys.add(senderId);
  if (rawName) keys.add(rawName.toLowerCase());
  if (normalizedName) keys.add(normalizedName.toLowerCase());
  return Array.from(keys);
}

function atlasPrimaryPersonKey(row: AtlasPeopleWindowRow, aliases: UserAliasMap): string {
  const senderId = String(row.sender_id || "").trim();
  if (senderId) return senderId;
  return normalizeSenderName(String(row.sender_name || "Unknown"), aliases).toLowerCase();
}

function rawEventHasMemberSignal(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as {
      type?: unknown;
      content?: { membership?: unknown; displayname?: unknown };
      unsigned?: { prev_content?: { displayname?: unknown; membership?: unknown } };
    };
    if (parsed.type === "m.room.member") return true;
    const membership = String(parsed.content?.membership || "");
    if (["join", "invite"].includes(membership)) return true;
    if (parsed.content?.displayname || parsed.unsigned?.prev_content?.displayname) return true;
  } catch {
    return /\bm\.room\.member\b|\b(joined|invited|added)\b/i.test(raw);
  }
  return false;
}

function detectAtlasPersonReasons(row: AtlasPeopleWindowRow): AtlasNewFaceReason[] {
  const reasons: AtlasNewFaceReason[] = [];
  const room = String(row.room_name || "");
  const senderId = String(row.sender_id || "");
  const senderName = String(row.sender_name || "");
  if (/\bintro(s|ductions)?\b/i.test(room)) reasons.push("intros_channel");
  if (rawEventHasMemberSignal(row.raw_event)) reasons.push("member_event");
  if (PHONE_LIKE_RE.test(senderId) || PHONE_LIKE_RE.test(senderName)) {
    reasons.push("phone_or_name_addition");
  }
  return reasons;
}

function buildAtlasPeopleInsightsFromRows(input: {
  generatedAt: string;
  rows: AtlasPeopleWindowRow[];
  firstSeenRows: AtlasPersonFirstSeenRow[];
  aliases: UserAliasMap;
}): AtlasPeopleInsights {
  const recentStartTs = Date.parse(input.generatedAt) - 7 * 24 * 60 * 60 * 1000;
  const firstSeenByKey = new Map<string, number>();
  for (const row of input.firstSeenRows) {
    const key = String(row.person_key || "").trim();
    const firstTs = Number(row.first_ts);
    if (!key || !Number.isFinite(firstTs)) continue;
    firstSeenByKey.set(key, firstTs);
  }

  const people = new Map<string, {
    name: string;
    senderId: string | null;
    count: number;
    activeDays: Set<string>;
    channels: Set<string>;
    firstRecentTs: number;
    firstRecentChannel: string;
    latestTs: number;
    citationRefs: string[];
    introRefs: string[];
    reasons: Set<AtlasNewFaceReason>;
    firstEverTs: number;
  }>();

  for (const row of input.rows) {
    const ts = Number(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    const key = atlasPrimaryPersonKey(row, input.aliases);
    const name = normalizeSenderName(String(row.sender_name || "Unknown"), input.aliases);
    const channel = String(row.room_name || "Unknown");
    const personKeys = atlasPersonKeys(row, input.aliases);
    const knownFirstTimes = personKeys
      .map((personKey) => firstSeenByKey.get(personKey))
      .filter((value): value is number => value !== undefined);
    const firstEverTs = Math.min(...knownFirstTimes, ts);
    const entry = people.get(key) || {
      name,
      senderId: row.sender_id || null,
      count: 0,
      activeDays: new Set<string>(),
      channels: new Set<string>(),
      firstRecentTs: ts,
      firstRecentChannel: channel,
      latestTs: ts,
      citationRefs: [],
      introRefs: [],
      reasons: new Set<AtlasNewFaceReason>(),
      firstEverTs,
    };
    entry.count += 1;
    entry.activeDays.add(dateKeyFromTs(ts));
    entry.channels.add(channel);
    if (ts < entry.firstRecentTs) {
      entry.firstRecentTs = ts;
      entry.firstRecentChannel = channel;
    }
    entry.latestTs = Math.max(entry.latestTs, ts);
    entry.firstEverTs = Math.min(entry.firstEverTs, firstEverTs);
    pushLimitedUnique(entry.citationRefs, `vibez:message:${row.id}`, 4);
    const reasons = detectAtlasPersonReasons(row);
    for (const reason of reasons) entry.reasons.add(reason);
    if (reasons.includes("intros_channel")) {
      pushLimitedUnique(entry.introRefs, `vibez:message:${row.id}`, 3);
    }
    people.set(key, entry);
  }

  const topContributors = Array.from(people.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((entry) => ({
      name: entry.name,
      sender_id: entry.senderId,
      message_count_7d: entry.count,
      active_days_7d: entry.activeDays.size,
      channels: Array.from(entry.channels).sort(),
      latest_seen: new Date(entry.latestTs).toISOString(),
      latest_seen_ts: entry.latestTs,
      citation_refs: entry.citationRefs,
    }));

  const newFaces = Array.from(people.values())
    .map((entry) => {
      const reasons = new Set(entry.reasons);
      if (entry.firstEverTs >= recentStartTs) reasons.add("first_seen");
      return { entry, reasons: Array.from(reasons) };
    })
    .filter(({ reasons }) => reasons.length > 0)
    .sort((a, b) => b.entry.firstEverTs - a.entry.firstEverTs)
    .slice(0, 12)
    .map(({ entry, reasons }) => ({
      name: entry.name,
      sender_id: entry.senderId,
      first_seen: new Date(entry.firstEverTs).toISOString(),
      first_seen_ts: entry.firstEverTs,
      first_channel: entry.firstRecentChannel,
      message_count_7d: entry.count,
      channels: Array.from(entry.channels).sort(),
      intro_refs: entry.introRefs,
      detection_reasons: reasons.sort(),
    }));

  return {
    window_days: 7,
    generated_at: input.generatedAt,
    new_faces: newFaces,
    top_contributors: topContributors,
  };
}

function getAtlasPeopleInsightsFromSqlite(
  db: Database.Database,
  scope: RoomScope,
  aliases: UserAliasMap,
  now: Date,
): AtlasPeopleInsights {
  const cutoffTs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const roomScope = buildSqliteRoomScopeWhere("m", scope);
  const whereParts = ["m.timestamp >= ?"];
  const params: unknown[] = [cutoffTs];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    params.push(...roomScope.params);
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body,
              m.timestamp, m.raw_event
       FROM messages m
       WHERE ${whereParts.join(" AND ")}
       ORDER BY m.timestamp ASC`,
    )
    .all(...params) as AtlasPeopleWindowRow[];

  const firstScope = buildSqliteRoomScopeWhere("m", scope);
  const firstRows = db
    .prepare(
      `SELECT COALESCE(NULLIF(m.sender_id, ''), LOWER(COALESCE(m.sender_name, ''))) AS person_key,
              MIN(m.timestamp) AS first_ts
       FROM messages m
       ${firstScope.clause ? `WHERE ${firstScope.clause}` : ""}
       GROUP BY person_key`,
    )
    .all(...firstScope.params) as AtlasPersonFirstSeenRow[];

  return buildAtlasPeopleInsightsFromRows({
    generatedAt: now.toISOString(),
    rows,
    firstSeenRows: firstRows,
    aliases,
  });
}

async function getAtlasPeopleInsights(
  scope: RoomScope,
  aliases: UserAliasMap,
  now: Date,
): Promise<AtlasPeopleInsights> {
  const cutoffTs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const roomScope = buildRoomScopeWhere("m", scope, 2);
  const whereParts = ["m.timestamp >= $1"];
  const params: unknown[] = [cutoffTs];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    params.push(...roomScope.params);
  }
  const { rows } = await pool.query(
    `SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body,
            m.timestamp, m.raw_event
     FROM messages m
     WHERE ${whereParts.join(" AND ")}
     ORDER BY m.timestamp ASC`,
    params,
  );

  const firstScope = buildRoomScopeWhere("m", scope, 1);
  const { rows: firstRows } = await pool.query(
    `SELECT COALESCE(NULLIF(m.sender_id, ''), LOWER(COALESCE(m.sender_name, ''))) AS person_key,
            MIN(m.timestamp) AS first_ts
     FROM messages m
     ${firstScope.clause ? `WHERE ${firstScope.clause}` : ""}
     GROUP BY person_key`,
    firstScope.params,
  );

  return buildAtlasPeopleInsightsFromRows({
    generatedAt: now.toISOString(),
    rows: rows as AtlasPeopleWindowRow[],
    firstSeenRows: firstRows as AtlasPersonFirstSeenRow[],
    aliases,
  });
}

function getAtlasSnapshotFromSqlite(windowHours: number): AtlasSnapshot {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const db = new Database(SQLITE_DB_PATH, { readonly: true });
  const userAliases = loadUserAliases();

  try {
    const scope = loadSqliteRoomScope(db);
    const roomScope = buildSqliteRoomScopeWhere("m", scope);
    const whereParts = ["m.timestamp >= ?"];
    const params: unknown[] = [windowStart.getTime()];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }

    const messageRows = db
      .prepare(
        `SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body,
                m.timestamp, m.raw_event,
                c.relevance_score, c.topics, c.alert_level
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         WHERE ${whereParts.join(" AND ")}
         ORDER BY m.timestamp DESC
         LIMIT 3000`,
      )
      .all(...params) as AtlasMessageRow[];

    const linkScope = buildSqliteLinkScopeWhere(scope);
    const linkWhereParts = ["last_seen >= ?"];
    const linkParams: unknown[] = [windowStart.toISOString()];
    if (linkScope.clause) {
      linkWhereParts.push(linkScope.clause);
      linkParams.push(...linkScope.params);
    }
    const linkRows = db
      .prepare(
        `SELECT id, url, title, category, relevance, shared_by,
                source_group, last_seen, value_score
         FROM links
         WHERE ${linkWhereParts.join(" AND ")}
         ORDER BY value_score DESC, last_seen DESC
         LIMIT 80`,
      )
      .all(...linkParams) as AtlasLinkRow[];
    const people = getAtlasPeopleInsightsFromSqlite(db, scope, userAliases, now);

    return buildAtlasSnapshotFromRows({
      generatedAt: now.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      messages: messageRows.map((row) => ({
        ...row,
        sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
      })),
      links: linkRows,
      people,
    });
  } finally {
    db.close();
  }
}

export async function getAtlasSnapshot(opts: { windowHours?: number } = {}): Promise<AtlasSnapshot> {
  const windowHours = Math.min(Math.max(opts.windowHours || 48, 6), 168);
  if (shouldUseSqliteAtlas()) {
    return getAtlasSnapshotFromSqlite(windowHours);
  }
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 2);
  const userAliases = loadUserAliases();

  const whereParts = ["m.timestamp >= $1"];
  const params: unknown[] = [windowStart.getTime()];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    params.push(...roomScope.params);
  }

  const { rows: messageRows } = await pool.query(
    `SELECT m.id, m.room_id, m.room_name, m.sender_id, m.sender_name, m.body,
            m.timestamp, m.raw_event,
            c.relevance_score, c.topics, c.alert_level
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     WHERE ${whereParts.join(" AND ")}
     ORDER BY m.timestamp DESC
     LIMIT 3000`,
    params,
  );

  const linkCutoff = windowStart.toISOString();
  const { rows: linkRows } = await pool.query(
    `SELECT id, url, title, category, relevance, shared_by,
            source_group, last_seen, value_score
     FROM links
     WHERE last_seen >= $1
     ORDER BY value_score DESC, last_seen DESC
     LIMIT 80`,
    [linkCutoff],
  );
  const people = await getAtlasPeopleInsights(scope, userAliases, now);

  return buildAtlasSnapshotFromRows({
    generatedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    messages: (messageRows as AtlasMessageRow[]).map((row) => ({
      ...row,
      sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
    })),
    links: linkRows as AtlasLinkRow[],
    people,
  });
}

export async function getRooms(): Promise<string[]> {
  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 1);
  const { rows } = await pool.query(
    `SELECT DISTINCT m.room_name
     FROM messages m
     ${roomScope.clause ? `WHERE ${roomScope.clause}` : ""}
     ORDER BY m.room_name`,
    roomScope.params,
  );
  return (rows as { room_name: string }[]).map((r) => r.room_name);
}

export async function getValueConfig(): Promise<Record<string, unknown>> {
  const { rows } = await pool.query("SELECT key, value FROM value_config");
  const config: Record<string, unknown> = {};
  for (const row of rows) {
    config[(row as { key: string }).key] = JSON.parse((row as { value: string }).value);
  }
  return config;
}

async function searchMessagesKeyword(opts: {
  query: string;
  lookbackDays?: number;
  limit?: number;
}): Promise<Message[]> {
  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 1);
  const userAliases = loadUserAliases();
  const cutoffTs = Date.now() - (opts.lookbackDays || 7) * 24 * 60 * 60 * 1000;
  const keywords = opts.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const limit = opts.limit || 50;

  let rows: Message[];
  if (keywords.length === 0) {
    let pi = roomScope.nextIndex;
    const whereParts = [`m.timestamp >= $${pi++}`];
    const params: unknown[] = [];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }
    params.push(cutoffTs);

    const { rows: pgRows } = await pool.query(
      `SELECT m.*, c.relevance_score, c.topics, c.entities,
              c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY c.relevance_score DESC
       LIMIT $${pi++}`,
      [...params, limit],
    );
    rows = pgRows as Message[];
  } else {
    let pi = roomScope.nextIndex;
    const whereParts = [`m.timestamp >= $${pi++}`];
    const params: unknown[] = [];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }
    params.push(cutoffTs);
    const keywordParts = keywords.slice(0, 5).map(() => `LOWER(m.body) LIKE $${pi++}`);
    const keywordParams = keywords.slice(0, 5).map((kw) => `%${kw}%`);
    const allParams = [...params, ...keywordParams, limit];

    const { rows: pgRows } = await pool.query(
      `SELECT m.*, c.relevance_score, c.topics, c.entities,
              c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${whereParts.join(" AND ")} AND (${keywordParts.join(" OR ")})
       ORDER BY m.timestamp DESC
       LIMIT $${pi + keywordParams.length}`,
      allParams,
    );
    rows = pgRows as Message[];
  }

  return rows.map((row) => ({
    ...row,
    sender_name: normalizeSenderName(row.sender_name, userAliases),
  }));
}

export async function searchMessages(opts: {
  query: string;
  lookbackDays?: number;
  limit?: number;
  semanticOnly?: boolean;
}): Promise<Message[]> {
  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();

  const semanticRows = await searchHybridMessages({
    query: opts.query,
    lookbackDays: opts.lookbackDays,
    limit: opts.limit,
    roomScope: scope,
  });
  if (semanticRows && semanticRows.length > 0) {
    return semanticRows.map((row) => ({
      ...row,
      sender_name: normalizeSenderName(row.sender_name, userAliases),
    }));
  }
  if (opts.semanticOnly) {
    if (semanticRows === null) {
      throw new Error("semantic message retrieval is unavailable");
    }
    return [];
  }

  return searchMessagesKeyword(opts);
}

export async function getLatestBriefingMd(): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT briefing_md FROM daily_reports ORDER BY report_date DESC LIMIT 1",
  );
  return (rows[0] as { briefing_md: string } | undefined)?.briefing_md || null;
}

interface StatBaseAccumulator {
  messages: number;
  activeDays: Set<string>;
  firstTs: number;
  lastTs: number;
  relevanceTotal: number;
  relevanceCount: number;
}

interface TopicAccumulator extends StatBaseAccumulator {
  daily: Map<string, number>;
  weekdayCounts: number[];
  hourCounts: number[];
}

interface PairAccumulator {
  topic_a: string;
  topic_b: string;
  co_messages: number;
  lastTs: number;
  daily: Map<string, number>;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface RankedStat {
  name: string;
  messages: number;
  active_days: number;
  first_seen: string;
  last_seen: string;
  avg_relevance: number | null;
}

export interface PersonChannelMembership {
  name: string;
  messages: number;
  first_seen: string;
  last_seen: string;
}

export interface PersonDirectoryEntry {
  name: string;
  sender_id: string | null;
  messages: number;
  active_days: number;
  first_seen: string;
  last_seen: string;
  channels: PersonChannelMembership[];
  top_topics: string[];
  possible_phone: boolean;
}

export interface TopicStat {
  topic: string;
  started_on: string;
  started_in_window: string;
  last_seen: string;
  message_count: number;
  active_days: number;
  span_days: number;
  recurrence_ratio: number;
  recurrence_label: "high" | "medium" | "low";
  last_7d: number;
  prev_7d: number;
  trend: "up" | "flat" | "down";
  peak_weekday: string;
  peak_hour: number;
  daily: DailyCount[];
}

export interface TopicCooccurrence {
  topic_a: string;
  topic_b: string;
  co_messages: number;
  overlap_ratio: number;
  jaccard: number;
  last_seen: string;
  trend: "up" | "flat" | "down";
}

export interface SeasonalityStats {
  by_weekday: { weekday: string; count: number }[];
  by_hour: { hour: number; count: number }[];
  topic_peaks: {
    topic: string;
    messages: number;
    peak_weekday: string;
    peak_hour: number;
  }[];
}

export interface RelationshipNode {
  id: string;
  messages: number;
  channels: number;
  replies_out: number;
  replies_in: number;
  dm_signals: number;
  top_topics: string[];
}

export interface RelationshipEdge {
  source: string;
  target: string;
  weight: number;
  replies: number;
  mentions: number;
  dm_signals: number;
  turns: number;
}

export interface TopicAlignmentEdge {
  source: string;
  target: string;
  similarity: number;
  overlap_count: number;
  shared_topics: string[];
}

export interface RelationshipNetworkStats {
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  summaries: {
    included_nodes: number;
    total_users_in_window: number;
    total_messages: number;
    directed_edges: number;
    dm_signal_messages: number;
  };
}

export interface TopicAlignmentNetworkStats {
  nodes: RelationshipNode[];
  edges: TopicAlignmentEdge[];
  summaries: {
    included_nodes: number;
    compared_nodes: number;
    alignment_edges: number;
  };
}

export interface StatsDashboard {
  window_days: number;
  generated_at: string;
    scope: {
      mode: "active_groups" | "excluded_groups" | "all";
      active_group_count: number;
    excluded_groups: string[];
  };
  totals: {
    messages: number;
    users: number;
    channels: number;
    topics: number;
    avg_relevance: number | null;
  };
  history: {
    first_seen: string | null;
    last_seen: string | null;
    messages: number;
    members_observed: number;
  };
  timeline: DailyCount[];
  coverage: {
    classified: DailyCount[];
    with_topics: DailyCount[];
    avg_topic_coverage: number;
  };
  users: RankedStat[];
  channels: RankedStat[];
  people_directory: PersonDirectoryEntry[];
  topics: TopicStat[];
  cooccurrence: TopicCooccurrence[];
  seasonality: SeasonalityStats;
  network: {
    relationships: RelationshipNetworkStats;
    topic_alignment: TopicAlignmentNetworkStats;
  };
  semantic: SemanticAnalytics;
}

export interface TopicDrilldownMessage {
  id: string;
  timestamp: number;
  date: string;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
}

export interface TopicDrilldown {
  topic: string;
  window_days: number;
  generated_at: string;
  scope: {
    mode: "active_groups" | "excluded_groups" | "all";
    active_group_count: number;
    excluded_groups: string[];
  };
  summary: {
    first_seen: string;
    last_seen: string;
    message_count: number;
    active_days: number;
    recurrence_ratio: number;
    recurrence_label: "high" | "medium" | "low";
    trend: "up" | "flat" | "down";
    last_7d: number;
    prev_7d: number;
  };
  timeline: DailyCount[];
  top_users: { name: string; messages: number }[];
  top_channels: { name: string; messages: number }[];
  related_topics: TopicCooccurrence[];
  recent_messages: TopicDrilldownMessage[];
}

function coerceTimestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
}

function dateKeyFromTs(ts: number | string): string {
  const timestamp = coerceTimestampMs(ts);
  if (timestamp === null) return "";
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function summarizeStatsHistoryRows(
  rows: Array<{ timestamp: unknown; sender_id?: unknown; sender_name?: unknown }>,
  userAliases: UserAliasMap,
): StatsDashboard["history"] {
  const members = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const row of rows) {
    const ts = coerceTimestampMs(row.timestamp);
    if (ts === null) continue;
    firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
    lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    const rawName = String(row.sender_name || "").trim();
    const rawId = String(row.sender_id || "").trim();
    members.add(rawName ? normalizeSenderName(rawName, userAliases) : rawId || "Unknown");
  }

  return {
    first_seen: firstTs === null ? null : dateKeyFromTs(firstTs),
    last_seen: lastTs === null ? null : dateKeyFromTs(lastTs),
    messages: rows.length,
    members_observed: members.size,
  };
}

function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function enumerateDays(windowDays: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    days.push(`${year}-${month}-${day}`);
  }
  return days;
}

function enumerateDaysFromTs(startTs: number, endTs: number): string[] {
  const start = new Date(startTs);
  const end = new Date(endTs);
  const days: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const final = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor.getTime() <= final.getTime()) {
    const year = cursor.getFullYear();
    const month = String(cursor.getMonth() + 1).padStart(2, "0");
    const day = String(cursor.getDate()).padStart(2, "0");
    days.push(`${year}-${month}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function resolveWindowDays(windowDays: number | null | undefined): number | null {
  if (windowDays === null || windowDays === undefined) return null;
  if (!Number.isFinite(windowDays)) return 90;
  if (windowDays <= 0) return null;
  return Math.max(7, Math.min(Math.floor(windowDays), 3650));
}

function finalizeRanked(name: string, acc: StatBaseAccumulator): RankedStat {
  return {
    name,
    messages: acc.messages,
    active_days: acc.activeDays.size,
    first_seen: dateKeyFromTs(acc.firstTs),
    last_seen: dateKeyFromTs(acc.lastTs),
    avg_relevance:
      acc.relevanceCount > 0
        ? Number((acc.relevanceTotal / acc.relevanceCount).toFixed(2))
        : null,
  };
}

function recurrenceLabel(ratio: number, activeDays: number): "high" | "medium" | "low" {
  if (activeDays >= 8 && ratio >= 0.4) return "high";
  if (activeDays >= 4 && ratio >= 0.2) return "medium";
  return "low";
}

function peakIndex(values: number[]): number {
  let idx = 0;
  let max = values[0] || 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > max) {
      max = values[i];
      idx = i;
    }
  }
  return idx;
}

const DM_SIGNAL_RE =
  /\b(dm|direct message|offline|off line|take (this )?offline|message me|ping me)\b/i;
const REPLY_SIGNAL_RE =
  /\b(reply|respond|agree|good point|great point|thanks|thank you|yes\b|no\b|\+1|exactly|makes sense)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function participantMentionRegex(name: string): RegExp {
  const escaped = escapeRegex(name.trim());
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

function topTopicsForUser(topicCounts: Map<string, number>, limit = 4): string[] {
  return Array.from(topicCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([topic]) => topic);
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) {
    normA += value * value;
  }
  for (const value of b.values()) {
    normB += value * value;
  }
  if (normA === 0 || normB === 0) return 0;
  for (const [topic, value] of a.entries()) {
    const other = b.get(topic);
    if (!other) continue;
    dot += value * other;
  }
  return dot / Math.sqrt(normA * normB);
}

const RADAR_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "being",
  "between",
  "could",
  "from",
  "have",
  "https",
  "just",
  "more",
  "only",
  "over",
  "really",
  "should",
  "that",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

interface BriefingThreadShape {
  title: string;
  insights: string;
}

interface VibezRadarRawRow {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
}

interface VibezRadarPreparedRow {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  raw_topics: string | null;
  topics: string[];
  body_tokens: Set<string>;
  fingerprint: string;
}

interface VibezRadarClusterAccumulator {
  topic: string;
  rows: VibezRadarPreparedRow[];
  people: Set<string>;
  channels: Set<string>;
  first_ts: number;
  last_ts: number;
  relevance_total: number;
  relevance_count: number;
  unclassified: boolean;
  covered: boolean;
}

function parseBriefingThreads(raw: string | null): BriefingThreadShape[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const title = String(record.title || "").trim();
        const insights = String(record.insights || "").trim();
        if (!title && !insights) return null;
        return { title, insights };
      })
      .filter((entry): entry is BriefingThreadShape => entry !== null);
  } catch {
    return [];
  }
}

function normalizeRadarBody(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_>#~\[\]()]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function radarTokens(text: string): string[] {
  return normalizeRadarBody(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !RADAR_STOPWORDS.has(token));
}

function intersectionCount(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const token of small) {
    if (large.has(token)) count += 1;
  }
  return count;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = intersectionCount(a, b);
  if (overlap === 0) return 0;
  return overlap / (a.size + b.size - overlap);
}

function topicMatchesThread(topic: string, threadText: string, threadTokens: Set<string>): boolean {
  const normalizedTopic = topic.toLowerCase().trim();
  if (!normalizedTopic) return false;
  if (threadText.includes(normalizedTopic)) return true;
  const topicTokenSet = new Set(radarTokens(normalizedTopic));
  if (topicTokenSet.size === 0) return false;
  const overlap = intersectionCount(topicTokenSet, threadTokens);
  return overlap >= Math.min(2, topicTokenSet.size);
}

function tsLabel(ts: number): string {
  return new Date(ts).toLocaleString();
}

export async function getVibezRadarSnapshot(
  report: DailyReport | null,
  windowHours = 48,
): Promise<VibezRadarSnapshot | null> {
  if (!report) return null;

  const threads = parseBriefingThreads(report.briefing_json);
  const resolvedWindowHours = Math.max(24, Math.min(Math.floor(windowHours), 168));
  const nowTs = Date.now();
  const windowStartTs = nowTs - resolvedWindowHours * 60 * 60 * 1000;

  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope, 1);

  let pi = roomScope.nextIndex;
  const whereParts = [`m.timestamp >= $${pi++}`];
  const whereParams: unknown[] = [];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    whereParams.push(...roomScope.params);
  }
  whereParams.push(windowStartTs);
  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  const { rows } = await pool.query(
    `SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp, c.relevance_score, c.topics
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     ${whereClause}
     ORDER BY m.timestamp ASC
     LIMIT 5000`,
    whereParams,
  );
  const rowsData = rows as VibezRadarRawRow[];

  const preparedRows: VibezRadarPreparedRow[] = rowsData.map((row) => ({
    id: row.id,
    room_name: row.room_name || "Unknown",
    sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
    body: row.body || "",
    timestamp: row.timestamp,
    relevance_score: row.relevance_score,
    raw_topics: row.topics,
    topics: parseTopics(row.topics),
    body_tokens: new Set(radarTokens(row.body || "")),
    fingerprint: normalizeRadarBody(row.body || ""),
  }));

  const threadFeatures = threads.map((thread, index) => {
    const text = `${thread.title} ${thread.insights}`.toLowerCase();
    return {
      key: `thread-${index}`,
      title: thread.title || "Untitled thread",
      text,
      tokens: new Set(radarTokens(text)),
    };
  });

  const semanticThreadEvidence = await searchThreadEvidence({
    threads: threadFeatures.map((thread) => ({ key: thread.key, text: thread.text })),
    cutoffTs: windowStartTs,
    perThreadLimit: 26,
    roomScope: scope,
  });

  const uniquePeople = new Set<string>();
  const uniqueChannels = new Set<string>();
  const topicCounts = new Map<string, number>();
  const fingerprintCounts = new Map<string, number>();
  let withTopicsCount = 0;

  for (const row of preparedRows) {
    uniquePeople.add(row.sender_name);
    uniqueChannels.add(row.room_name);
    if (row.topics.length > 0) {
      withTopicsCount += 1;
      for (const topic of new Set(row.topics)) {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      }
    }
    if (row.fingerprint.length >= 48) {
      fingerprintCounts.set(row.fingerprint, (fingerprintCounts.get(row.fingerprint) || 0) + 1);
    }
  }

  const clusters = new Map<string, VibezRadarClusterAccumulator>();
  for (const row of preparedRows) {
    const topics = Array.from(new Set(row.topics));
    const primaryTopic =
      topics.length > 0
        ? [...topics].sort((a, b) => {
            const countA = topicCounts.get(a) || 0;
            const countB = topicCounts.get(b) || 0;
            if (countA !== countB) return countB - countA;
            return a.localeCompare(b);
          })[0]
        : "Unclassified signal";
    const existing = clusters.get(primaryTopic) || {
      topic: primaryTopic,
      rows: [],
      people: new Set<string>(),
      channels: new Set<string>(),
      first_ts: row.timestamp,
      last_ts: row.timestamp,
      relevance_total: 0,
      relevance_count: 0,
      unclassified: topics.length === 0,
      covered: false,
    };
    existing.rows.push(row);
    existing.people.add(row.sender_name);
    existing.channels.add(row.room_name);
    existing.first_ts = Math.min(existing.first_ts, row.timestamp);
    existing.last_ts = Math.max(existing.last_ts, row.timestamp);
    if (row.relevance_score !== null && row.relevance_score !== undefined) {
      existing.relevance_total += row.relevance_score;
      existing.relevance_count += 1;
    }
    clusters.set(primaryTopic, existing);
  }

  for (const cluster of clusters.values()) {
    if (cluster.unclassified) continue;
    const directTopicMatch = threadFeatures.some((thread) =>
      topicMatchesThread(cluster.topic, thread.text, thread.tokens),
    );
    if (directTopicMatch) {
      cluster.covered = true;
      continue;
    }

    const clusterTokenCounts = new Map<string, number>();
    for (const row of cluster.rows) {
      for (const token of row.body_tokens) {
        clusterTokenCounts.set(token, (clusterTokenCounts.get(token) || 0) + 1);
      }
    }
    const clusterTopTokens = new Set(
      Array.from(clusterTokenCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([token]) => token),
    );
    cluster.covered = threadFeatures.some(
      (thread) => intersectionCount(clusterTopTokens, thread.tokens) >= 2,
    );
  }

  const duplicateMessages = Array.from(fingerprintCounts.values()).reduce(
    (sum, count) => sum + (count > 1 ? count - 1 : 0),
    0,
  );

  const topicalVolume = Array.from(clusters.values())
    .filter((cluster) => !cluster.unclassified)
    .reduce((sum, cluster) => sum + cluster.rows.length, 0);
  const topicalCoveredVolume = Array.from(clusters.values())
    .filter((cluster) => !cluster.unclassified && cluster.covered)
    .reduce((sum, cluster) => sum + cluster.rows.length, 0);

  const topicCoveragePct =
    topicalVolume > 0 ? Number(((topicalCoveredVolume / topicalVolume) * 100).toFixed(1)) : 0;
  const classificationCoveragePct =
    preparedRows.length > 0 ? Number(((withTopicsCount / preparedRows.length) * 100).toFixed(1)) : 0;
  const duplicatePressurePct =
    preparedRows.length > 0 ? Number(((duplicateMessages / preparedRows.length) * 100).toFixed(1)) : 0;

  const reportGeneratedTs = report.generated_at ? new Date(report.generated_at).getTime() : NaN;
  const gapThreshold = Math.max(5, Math.floor(preparedRows.length * 0.03));
  const uncoveredGaps: VibezRadarGap[] = Array.from(clusters.values())
    .filter((cluster) => !cluster.unclassified && !cluster.covered)
    .filter((cluster) => cluster.rows.length >= gapThreshold && cluster.people.size >= 2)
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, 6)
    .map((cluster) => {
      const quoteCandidates = cluster.rows.filter((row) => row.body.trim().length >= 40);
      const sampleRow = [...(quoteCandidates.length > 0 ? quoteCandidates : cluster.rows)].sort(
        (a, b) =>
          (b.relevance_score ?? Number.NEGATIVE_INFINITY) -
            (a.relevance_score ?? Number.NEGATIVE_INFINITY) || b.timestamp - a.timestamp,
      )[0];

      const reasons: string[] = [];
      if (!Number.isNaN(reportGeneratedTs) && cluster.last_ts > reportGeneratedTs) {
        reasons.push("Signal rose after the latest briefing timestamp.");
      }
      if (classificationCoveragePct < 65) {
        reasons.push("Topic coverage in classifications is currently thin.");
      }
      if (cluster.channels.size === 1 && cluster.people.size <= 3) {
        reasons.push("Discussion is concentrated in one channel and may have looked narrow.");
      }
      if (reasons.length === 0) {
        reasons.push("High recent volume is not represented in current briefing priorities.");
      }

      return {
        topic: cluster.topic,
        message_count: cluster.rows.length,
        people: cluster.people.size,
        channels: cluster.channels.size,
        first_seen: tsLabel(cluster.first_ts),
        last_seen: tsLabel(cluster.last_ts),
        avg_relevance:
          cluster.relevance_count > 0
            ? Number((cluster.relevance_total / cluster.relevance_count).toFixed(2))
            : null,
        reason: reasons.join(" "),
        sample_quote: sampleRow
          ? {
              id: sampleRow.id,
              timestamp: sampleRow.timestamp,
              room_name: sampleRow.room_name,
              sender_name: sampleRow.sender_name,
              body: sampleRow.body,
              relevance_score: sampleRow.relevance_score,
            }
        : null,
      };
    });

  const lateBreakingGaps: VibezRadarGap[] = Number.isNaN(reportGeneratedTs)
    ? []
    : Array.from(clusters.values())
        .filter((cluster) => !cluster.unclassified && cluster.covered)
        .filter((cluster) => cluster.last_ts > reportGeneratedTs)
        .filter((cluster) => cluster.rows.length >= gapThreshold * 2 && cluster.people.size >= 3)
        .sort((a, b) => b.rows.length - a.rows.length)
        .slice(0, 3)
        .map((cluster) => {
          const sampleRow = [...cluster.rows]
            .sort((a, b) => b.timestamp - a.timestamp)
            .find((row) => row.body.trim().length >= 40);
          return {
            topic: cluster.topic,
            message_count: cluster.rows.length,
            people: cluster.people.size,
            channels: cluster.channels.size,
            first_seen: tsLabel(cluster.first_ts),
            last_seen: tsLabel(cluster.last_ts),
            avg_relevance:
              cluster.relevance_count > 0
                ? Number((cluster.relevance_total / cluster.relevance_count).toFixed(2))
                : null,
            reason:
              "Volume accelerated after briefing cutoff; monitor for stale summary framing.",
            sample_quote: sampleRow
              ? {
                  id: sampleRow.id,
                  timestamp: sampleRow.timestamp,
                  room_name: sampleRow.room_name,
                  sender_name: sampleRow.sender_name,
                  body: sampleRow.body,
                  relevance_score: sampleRow.relevance_score,
                }
              : null,
          };
        });

  const gapByTopic = new Map<string, VibezRadarGap>();
  for (const gap of uncoveredGaps) {
    gapByTopic.set(gap.topic, gap);
  }
  for (const gap of lateBreakingGaps) {
    if (!gapByTopic.has(gap.topic)) {
      gapByTopic.set(gap.topic, gap);
    }
  }
  const gaps = Array.from(gapByTopic.values())
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 6);

  const unclassifiedCluster = clusters.get("Unclassified signal");
  if (
    unclassifiedCluster &&
    unclassifiedCluster.rows.length >= gapThreshold &&
    classificationCoveragePct < 70
  ) {
    const sample = unclassifiedCluster.rows[unclassifiedCluster.rows.length - 1];
    gaps.push({
      topic: "Unclassified signal",
      message_count: unclassifiedCluster.rows.length,
      people: unclassifiedCluster.people.size,
      channels: unclassifiedCluster.channels.size,
      first_seen: tsLabel(unclassifiedCluster.first_ts),
      last_seen: tsLabel(unclassifiedCluster.last_ts),
      avg_relevance:
        unclassifiedCluster.relevance_count > 0
          ? Number((unclassifiedCluster.relevance_total / unclassifiedCluster.relevance_count).toFixed(2))
          : null,
      reason:
        "Large message volume without extracted topics suggests classification drift or vocabulary changes.",
      sample_quote: sample
        ? {
            id: sample.id,
            timestamp: sample.timestamp,
            room_name: sample.room_name,
            sender_name: sample.sender_name,
            body: sample.body,
            relevance_score: sample.relevance_score,
          }
        : null,
    });
  }

  const redundancies: VibezRadarRedundancy[] = [];
  for (let i = 0; i < threadFeatures.length; i += 1) {
    for (let j = i + 1; j < threadFeatures.length; j += 1) {
      const left = threadFeatures[i];
      const right = threadFeatures[j];
      const similarity = jaccardSimilarity(left.tokens, right.tokens);
      if (similarity < 0.4) continue;
      const scorePct = Number((similarity * 100).toFixed(1));
      redundancies.push({
        type: "thread_overlap",
        score_pct: scorePct,
        title: `${left.title} ↔ ${right.title}`,
        detail: `${scorePct}% lexical overlap between thread summaries; consider sharper differentiation.`,
      });
    }
  }
  if (duplicatePressurePct >= 12) {
    redundancies.push({
      type: "message_duplication",
      score_pct: duplicatePressurePct,
      title: "Repeated source messages",
      detail: `${duplicatePressurePct}% of recent messages are near-duplicates, which can inflate perceived importance.`,
    });
  }

  const preparedById = new Map(preparedRows.map((row) => [row.id, row]));
  const thread_quality: VibezRadarThreadQuality[] = threadFeatures
    .map((thread) => {
      const lexicalRows = preparedRows.filter((row) => {
        const topicHit = row.topics.some((topic) =>
          topicMatchesThread(topic, thread.text, thread.tokens),
        );
        if (topicHit) return true;
        return intersectionCount(row.body_tokens, thread.tokens) >= 3;
      });
      const semantic = semanticThreadEvidence.get(thread.key);

      const evidenceById = new Map<string, VibezRadarPreparedRow>();
      for (const row of lexicalRows) {
        evidenceById.set(row.id, row);
      }
      for (const id of semantic?.message_ids || []) {
        const matched = preparedById.get(id);
        if (matched) {
          evidenceById.set(id, matched);
        }
      }
      const evidenceRows = Array.from(evidenceById.values());
      const evidencePeople = new Set(evidenceRows.map((row) => row.sender_name));
      for (const senderName of semantic?.sender_names || []) {
        evidencePeople.add(senderName);
      }

      let newestEvidenceTs: number | null =
        evidenceRows.length > 0
          ? evidenceRows.reduce(
              (max, row) => Math.max(max, row.timestamp),
              evidenceRows[0].timestamp,
            )
          : null;
      if (semantic?.newest_timestamp) {
        newestEvidenceTs =
          newestEvidenceTs === null
            ? semantic.newest_timestamp
            : Math.max(newestEvidenceTs, semantic.newest_timestamp);
      }

      let quality: "strong" | "mixed" | "thin" = "thin";
      if (evidenceRows.length >= 8 && evidencePeople.size >= 4) quality = "strong";
      else if (evidenceRows.length >= 3 && evidencePeople.size >= 2) quality = "mixed";

      const notes: string[] = [];
      const semanticOnlyCount = Math.max(0, (semantic?.message_ids.length || 0) - lexicalRows.length);
      if (quality === "strong") {
        notes.push("Backed by broad, recent message evidence.");
      } else if (quality === "mixed") {
        notes.push("Moderate evidence; validate before acting.");
      } else {
        notes.push("Thin supporting evidence in the current window.");
      }
      if (semanticOnlyCount > 0) {
        notes.push(
          `Semantic retrieval surfaced ${semanticOnlyCount} additional related messages outside strict lexical overlap.`,
        );
      }
      if (evidenceRows.length > 0 && evidencePeople.size === 1) {
        notes.push("Signal is concentrated in one voice.");
      }
      if (newestEvidenceTs !== null && nowTs - newestEvidenceTs > 24 * 60 * 60 * 1000) {
        notes.push("No fresh evidence in the last 24h.");
      }

      return {
        thread_title: thread.title,
        evidence_messages: evidenceRows.length,
        evidence_people: evidencePeople.size,
        newest_evidence: newestEvidenceTs === null ? null : tsLabel(newestEvidenceTs),
        quality,
        notes,
      };
    })
    .sort((a, b) => b.evidence_messages - a.evidence_messages)
    .slice(0, 8);

  return {
    generated_at: new Date().toISOString(),
    window_hours: resolvedWindowHours,
    window_start_iso: new Date(windowStartTs).toISOString(),
    coverage: {
      topic_coverage_pct: topicCoveragePct,
      classification_coverage_pct: classificationCoveragePct,
      duplicate_pressure_pct: duplicatePressurePct,
    },
    totals: {
      messages: preparedRows.length,
      people: uniquePeople.size,
      channels: uniqueChannels.size,
      briefing_threads: threads.length,
    },
    gaps: gaps.slice(0, 6),
    redundancies: redundancies.sort((a, b) => b.score_pct - a.score_pct).slice(0, 6),
    thread_quality,
  };
}

function disabledSemanticAnalytics(): SemanticAnalytics {
  return {
    enabled: false,
    coverage_pct: 0,
    orphan_pct: 0,
    avg_coherence: 0,
    drift_risk: "low",
    checks: ["semantic analytics require Postgres/pgvector; SQLite stats use tabular aggregates."],
    arcs: [],
    trends: [],
  };
}

function getStatsDashboardFromSqlite(windowDays: number | null = 90): StatsDashboard {
  const resolvedWindow = resolveWindowDays(windowDays);
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const db = new Database(SQLITE_DB_PATH, { readonly: true });
  const userAliases = loadUserAliases();

  try {
    const scope = loadSqliteRoomScope(db);
    const roomScope = buildSqliteRoomScopeWhere("m", scope);
    const whereParts: string[] = [];
    const params: unknown[] = [];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }
    if (cutoffTs !== null) {
      whereParts.push("m.timestamp >= ?");
      params.push(cutoffTs);
    }
    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const rowsData = db
      .prepare(
        `SELECT m.timestamp, m.sender_id, m.sender_name, m.room_name, m.body,
                c.topics, c.relevance_score
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         ${where}
         ORDER BY m.timestamp ASC`,
      )
      .all(...params) as Array<{
        timestamp: number;
        sender_id: string | null;
        sender_name: string;
        room_name: string;
        body: string;
        topics: string | null;
        relevance_score: number | null;
      }>;

    const historyWhere = roomScope.clause ? `WHERE ${roomScope.clause}` : "";
    const historyRows = db
      .prepare(
        `SELECT m.timestamp, m.sender_id, m.sender_name
         FROM messages m
         ${historyWhere}`,
      )
      .all(...roomScope.params) as Array<{
        timestamp: unknown;
        sender_id: string | null;
        sender_name: string | null;
      }>;
    const history = summarizeStatsHistoryRows(historyRows, userAliases);

    const timelineDays =
      resolvedWindow === null
        ? rowsData.length > 0
          ? enumerateDaysFromTs(rowsData[0].timestamp, Date.now())
          : enumerateDays(30)
        : enumerateDays(resolvedWindow);
    const windowDaysValue = timelineDays.length;
    const timelineMap = new Map<string, number>(timelineDays.map((day) => [day, 0]));
    const classifiedMap = new Map<string, number>(timelineDays.map((day) => [day, 0]));
    const withTopicsMap = new Map<string, number>(timelineDays.map((day) => [day, 0]));
    const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekdayCounts = Array.from({ length: 7 }, () => 0);
    const hourCounts = Array.from({ length: 24 }, () => 0);

    const users = new Map<string, StatBaseAccumulator>();
    const channels = new Map<string, StatBaseAccumulator>();
    const topics = new Map<string, TopicAccumulator>();
    const userIds = new Map<string, Set<string>>();
    const userTopicCounts = new Map<string, Map<string, number>>();
    const userChannels = new Map<string, Set<string>>();
    const userChannelStats = new Map<string, Map<string, StatBaseAccumulator>>();
    const userPossiblePhone = new Map<string, boolean>();
    let relevanceTotal = 0;
    let relevanceCount = 0;

    for (const row of rowsData) {
      const ts = Number(row.timestamp);
      if (!Number.isFinite(ts)) continue;
      const dateKey = dateKeyFromTs(ts);
      timelineMap.set(dateKey, (timelineMap.get(dateKey) || 0) + 1);
      const parsedTopics = parseTopics(row.topics);
      if (row.topics !== null) classifiedMap.set(dateKey, (classifiedMap.get(dateKey) || 0) + 1);
      if (parsedTopics.length > 0) withTopicsMap.set(dateKey, (withTopicsMap.get(dateKey) || 0) + 1);
      const d = new Date(ts);
      weekdayCounts[d.getDay()] += 1;
      hourCounts[d.getHours()] += 1;

      if (row.relevance_score !== null && row.relevance_score !== undefined) {
        relevanceTotal += row.relevance_score;
        relevanceCount += 1;
      }

      const sender = normalizeSenderName(row.sender_name || "Unknown", userAliases);
      const senderId = String(row.sender_id || "").trim();
      const userAcc = users.get(sender) || {
        messages: 0,
        activeDays: new Set<string>(),
        firstTs: ts,
        lastTs: ts,
        relevanceTotal: 0,
        relevanceCount: 0,
      };
      userAcc.messages += 1;
      userAcc.activeDays.add(dateKey);
      userAcc.firstTs = Math.min(userAcc.firstTs, ts);
      userAcc.lastTs = Math.max(userAcc.lastTs, ts);
      if (row.relevance_score !== null && row.relevance_score !== undefined) {
        userAcc.relevanceTotal += row.relevance_score;
        userAcc.relevanceCount += 1;
      }
      users.set(sender, userAcc);

      if (senderId) {
        const ids = userIds.get(sender) || new Set<string>();
        ids.add(senderId);
        userIds.set(sender, ids);
      }
      if (PHONE_LIKE_RE.test(senderId) || PHONE_LIKE_RE.test(row.sender_name || "")) {
        userPossiblePhone.set(sender, true);
      }

      const channel = row.room_name || "Unknown";
      const channelAcc = channels.get(channel) || {
        messages: 0,
        activeDays: new Set<string>(),
        firstTs: ts,
        lastTs: ts,
        relevanceTotal: 0,
        relevanceCount: 0,
      };
      channelAcc.messages += 1;
      channelAcc.activeDays.add(dateKey);
      channelAcc.firstTs = Math.min(channelAcc.firstTs, ts);
      channelAcc.lastTs = Math.max(channelAcc.lastTs, ts);
      if (row.relevance_score !== null && row.relevance_score !== undefined) {
        channelAcc.relevanceTotal += row.relevance_score;
        channelAcc.relevanceCount += 1;
      }
      channels.set(channel, channelAcc);

      const userTopicMap = userTopicCounts.get(sender) || new Map<string, number>();
      const userChannelSet = userChannels.get(sender) || new Set<string>();
      userChannelSet.add(channel);
      userChannels.set(sender, userChannelSet);
      const channelMap = userChannelStats.get(sender) || new Map<string, StatBaseAccumulator>();
      const personChannelAcc = channelMap.get(channel) || {
        messages: 0,
        activeDays: new Set<string>(),
        firstTs: ts,
        lastTs: ts,
        relevanceTotal: 0,
        relevanceCount: 0,
      };
      personChannelAcc.messages += 1;
      personChannelAcc.activeDays.add(dateKey);
      personChannelAcc.firstTs = Math.min(personChannelAcc.firstTs, ts);
      personChannelAcc.lastTs = Math.max(personChannelAcc.lastTs, ts);
      channelMap.set(channel, personChannelAcc);
      userChannelStats.set(sender, channelMap);

      for (const topic of parsedTopics) {
        userTopicMap.set(topic, (userTopicMap.get(topic) || 0) + 1);
        const topicAcc = topics.get(topic) || {
          messages: 0,
          activeDays: new Set<string>(),
          firstTs: ts,
          lastTs: ts,
          relevanceTotal: 0,
          relevanceCount: 0,
          daily: new Map<string, number>(),
          weekdayCounts: Array.from({ length: 7 }, () => 0),
          hourCounts: Array.from({ length: 24 }, () => 0),
        };
        topicAcc.messages += 1;
        topicAcc.activeDays.add(dateKey);
        topicAcc.firstTs = Math.min(topicAcc.firstTs, ts);
        topicAcc.lastTs = Math.max(topicAcc.lastTs, ts);
        topicAcc.daily.set(dateKey, (topicAcc.daily.get(dateKey) || 0) + 1);
        topicAcc.weekdayCounts[d.getDay()] += 1;
        topicAcc.hourCounts[d.getHours()] += 1;
        if (row.relevance_score !== null && row.relevance_score !== undefined) {
          topicAcc.relevanceTotal += row.relevance_score;
          topicAcc.relevanceCount += 1;
        }
        topics.set(topic, topicAcc);
      }
      userTopicCounts.set(sender, userTopicMap);
    }

    const timeline = timelineDays.map((date) => ({ date, count: timelineMap.get(date) || 0 }));
    const classified = timelineDays.map((date) => ({ date, count: classifiedMap.get(date) || 0 }));
    const with_topics = timelineDays.map((date) => ({ date, count: withTopicsMap.get(date) || 0 }));
    const avgTopicCoverage =
      rowsData.length > 0
        ? Number((with_topics.reduce((sum, day) => sum + day.count, 0) / rowsData.length).toFixed(3))
        : 0;

    const peopleDirectory: PersonDirectoryEntry[] = Array.from(users.entries())
      .map(([name, acc]) => {
        const ranked = finalizeRanked(name, acc);
        const ids = Array.from(userIds.get(name) || []);
        const channelMap = userChannelStats.get(name) || new Map<string, StatBaseAccumulator>();
        return {
          ...ranked,
          sender_id: ids[0] || null,
          channels: Array.from(channelMap.entries())
            .map(([channelName, channelAcc]) => ({
              name: channelName,
              messages: channelAcc.messages,
              first_seen: dateKeyFromTs(channelAcc.firstTs),
              last_seen: dateKeyFromTs(channelAcc.lastTs),
            }))
            .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name)),
          top_topics: topTopicsForUser(userTopicCounts.get(name) || new Map<string, number>(), 6),
          possible_phone: userPossiblePhone.get(name) || false,
        };
      })
      .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));

    const topicStats: TopicStat[] = Array.from(topics.entries())
      .map(([topic, acc]) => {
        const spanDays = Math.max(1, Math.floor((acc.lastTs - acc.firstTs) / (24 * 60 * 60 * 1000)) + 1);
        const activeDays = acc.activeDays.size;
        const ratio = activeDays / spanDays;
        return {
          topic,
          started_on: dateKeyFromTs(acc.firstTs),
          started_in_window: dateKeyFromTs(acc.firstTs),
          last_seen: dateKeyFromTs(acc.lastTs),
          message_count: acc.messages,
          active_days: activeDays,
          span_days: spanDays,
          recurrence_ratio: Number(ratio.toFixed(3)),
          recurrence_label: recurrenceLabel(ratio, activeDays),
          last_7d: 0,
          prev_7d: 0,
          trend: "flat" as const,
          peak_weekday: weekdayLabels[peakIndex(acc.weekdayCounts)],
          peak_hour: peakIndex(acc.hourCounts),
          daily: timelineDays.map((date) => ({ date, count: acc.daily.get(date) || 0 })),
        };
      })
      .sort((a, b) => b.message_count - a.message_count)
      .slice(0, 40);

    const relationshipNodes: RelationshipNode[] = Array.from(users.entries())
      .map(([name, acc]) => ({
        id: name,
        messages: acc.messages,
        channels: userChannels.get(name)?.size || 0,
        replies_out: 0,
        replies_in: 0,
        dm_signals: 0,
        top_topics: topTopicsForUser(userTopicCounts.get(name) || new Map<string, number>(), 4),
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 220);

    return {
      window_days: windowDaysValue,
      generated_at: new Date().toISOString(),
      scope: {
        mode: scope.mode,
        active_group_count: Math.max(scope.activeGroupIds.length, scope.activeGroupNames.length),
        excluded_groups: scope.excludedGroups,
      },
      totals: {
        messages: rowsData.length,
        users: users.size,
        channels: channels.size,
        topics: topics.size,
        avg_relevance: relevanceCount > 0 ? Number((relevanceTotal / relevanceCount).toFixed(2)) : null,
      },
      history,
      timeline,
      coverage: { classified, with_topics, avg_topic_coverage: avgTopicCoverage },
      users: Array.from(users.entries())
        .map(([name, acc]) => finalizeRanked(name, acc))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 25),
      channels: Array.from(channels.entries())
        .map(([name, acc]) => finalizeRanked(name, acc))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 25),
      people_directory: peopleDirectory,
      topics: topicStats,
      cooccurrence: [],
      seasonality: {
        by_weekday: weekdayLabels.map((weekday, i) => ({ weekday, count: weekdayCounts[i] })),
        by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourCounts[hour] })),
        topic_peaks: topicStats.slice(0, 20).map((topic) => ({
          topic: topic.topic,
          messages: topic.message_count,
          peak_weekday: topic.peak_weekday,
          peak_hour: topic.peak_hour,
        })),
      },
      network: {
        relationships: {
          nodes: relationshipNodes,
          edges: [],
          summaries: {
            included_nodes: relationshipNodes.length,
            total_users_in_window: users.size,
            total_messages: rowsData.length,
            directed_edges: 0,
            dm_signal_messages: 0,
          },
        },
        topic_alignment: {
          nodes: relationshipNodes.slice(0, 120),
          edges: [],
          summaries: {
            included_nodes: Math.min(relationshipNodes.length, 120),
            compared_nodes: Math.min(relationshipNodes.length, 120),
            alignment_edges: 0,
          },
        },
      },
      semantic: disabledSemanticAnalytics(),
    };
  } finally {
    db.close();
  }
}

export async function getStatsDashboard(
  windowDays: number | null = 90,
): Promise<StatsDashboard> {
  if (shouldUseSqliteAtlas()) {
    return getStatsDashboardFromSqlite(windowDays);
  }
  const resolvedWindow = resolveWindowDays(windowDays);
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope, 1);

  let scopedWhere = "";
  let scopedParams: unknown[] = [];
  if (roomScope.clause) {
    scopedWhere = `WHERE ${roomScope.clause}`;
    scopedParams = [...roomScope.params];
  }

  let pi = roomScope.nextIndex;
  const windowWhereParts: string[] = [];
  const windowParams: unknown[] = [];
  if (roomScope.clause) {
    windowWhereParts.push(roomScope.clause);
    windowParams.push(...roomScope.params);
  }
  if (cutoffTs !== null) {
    windowWhereParts.push(`m.timestamp >= $${pi++}`);
    windowParams.push(cutoffTs);
  }
  const windowWhere = windowWhereParts.length > 0 ? `WHERE ${windowWhereParts.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT m.timestamp, m.sender_id, m.sender_name, m.room_name, m.body, c.topics, c.relevance_score
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     ${windowWhere}
     ORDER BY m.timestamp ASC`,
    windowParams,
  );
  const rowsData = (rows as {
    timestamp: unknown;
    sender_id: string | null;
    sender_name: string;
    room_name: string;
    body: string;
    topics: string | null;
    relevance_score: number | null;
  }[])
    .map((row) => ({
      ...row,
      timestamp: coerceTimestampMs(row.timestamp),
    }))
    .filter((row): row is {
      timestamp: number;
      sender_id: string | null;
      sender_name: string;
      room_name: string;
      body: string;
      topics: string | null;
      relevance_score: number | null;
    } => row.timestamp !== null);

  const allTopicQuery = scopedWhere
    ? `SELECT m.timestamp, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       ${scopedWhere} AND c.topics IS NOT NULL`
    : `SELECT m.timestamp, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE c.topics IS NOT NULL`;
  const { rows: allTopicRows } = await pool.query(allTopicQuery, scopedParams);
  const { rows: historyRows } = await pool.query(
    `SELECT m.timestamp, m.sender_id, m.sender_name
     FROM messages m
     ${scopedWhere}`,
    scopedParams,
  );
  const history = summarizeStatsHistoryRows(
    historyRows as Array<{ timestamp: unknown; sender_id?: unknown; sender_name?: unknown }>,
    userAliases,
  );

  const timelineDays =
    resolvedWindow === null
      ? rowsData.length > 0
        ? enumerateDaysFromTs(rowsData[0].timestamp, Date.now())
        : enumerateDays(30)
      : enumerateDays(resolvedWindow);
  const windowDaysValue = timelineDays.length;
  const timelineMap = new Map<string, number>(timelineDays.map((d) => [d, 0]));
  const classifiedMap = new Map<string, number>(timelineDays.map((d) => [d, 0]));
  const withTopicsMap = new Map<string, number>(timelineDays.map((d) => [d, 0]));
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayCounts = Array.from({ length: 7 }, () => 0);
  const hourCounts = Array.from({ length: 24 }, () => 0);

  const users = new Map<string, StatBaseAccumulator>();
  const channels = new Map<string, StatBaseAccumulator>();
  const topics = new Map<string, TopicAccumulator>();
  const topicFirstSeenEver = new Map<string, number>();
  const cooccurrence = new Map<string, PairAccumulator>();
  const userTopicCounts = new Map<string, Map<string, number>>();
  const userChannels = new Map<string, Set<string>>();
  const userIds = new Map<string, Set<string>>();
  const userChannelStats = new Map<string, Map<string, StatBaseAccumulator>>();
  const userPossiblePhone = new Map<string, boolean>();
  const relationshipEdges = new Map<string, RelationshipEdge>();
  const relationshipInbound = new Map<string, number>();
  const relationshipOutbound = new Map<string, number>();
  const dmSignalsByUser = new Map<string, number>();
  const roomHistory = new Map<string, Array<{ sender: string; ts: number; body: string }>>();
  const mentionRegexByName = new Map<string, RegExp>();
  let dmSignalMessages = 0;

  let relevanceTotal = 0;
  let relevanceCount = 0;

  function addRelationshipEdge(
    source: string,
    target: string,
    delta: { replies?: number; mentions?: number; dm_signals?: number; turns?: number },
  ): void {
    if (!source || !target || source === target) return;
    const key = `${source}=>${target}`;
    const existing = relationshipEdges.get(key) || {
      source,
      target,
      weight: 0,
      replies: 0,
      mentions: 0,
      dm_signals: 0,
      turns: 0,
    };
    existing.replies += delta.replies ?? 0;
    existing.mentions += delta.mentions ?? 0;
    existing.dm_signals += delta.dm_signals ?? 0;
    existing.turns += delta.turns ?? 0;
    existing.weight = Number(
      (
        existing.replies * 1.8 +
        existing.mentions * 1.3 +
        existing.dm_signals * 2.4 +
        existing.turns * 0.8
      ).toFixed(3),
    );
    relationshipEdges.set(key, existing);
    relationshipOutbound.set(source, (relationshipOutbound.get(source) || 0) + 1);
    relationshipInbound.set(target, (relationshipInbound.get(target) || 0) + 1);
  }

  for (const row of allTopicRows) {
    const ts = coerceTimestampMs(row.timestamp);
    if (ts === null) continue;
    for (const topic of new Set(parseTopics(row.topics))) {
      const prev = topicFirstSeenEver.get(topic);
      if (prev === undefined || ts < prev) {
        topicFirstSeenEver.set(topic, ts);
      }
    }
  }

  for (const row of rowsData) {
    const ts = row.timestamp;
    const dateKey = dateKeyFromTs(ts);
    timelineMap.set(dateKey, (timelineMap.get(dateKey) || 0) + 1);
    const parsedTopics = parseTopics(row.topics);
    if (row.topics !== null) {
      classifiedMap.set(dateKey, (classifiedMap.get(dateKey) || 0) + 1);
    }
    if (parsedTopics.length > 0) {
      withTopicsMap.set(dateKey, (withTopicsMap.get(dateKey) || 0) + 1);
    }
    const d = new Date(ts);
    weekdayCounts[d.getDay()] += 1;
    hourCounts[d.getHours()] += 1;

    if (row.relevance_score !== null && row.relevance_score !== undefined) {
      relevanceTotal += row.relevance_score;
      relevanceCount += 1;
    }

    const sender = normalizeSenderName(row.sender_name || "Unknown", userAliases);
    const senderId = String(row.sender_id || "").trim();
    const userAcc = users.get(sender) || {
      messages: 0,
      activeDays: new Set<string>(),
      firstTs: ts,
      lastTs: ts,
      relevanceTotal: 0,
      relevanceCount: 0,
    };
    userAcc.messages += 1;
    userAcc.activeDays.add(dateKey);
    userAcc.firstTs = Math.min(userAcc.firstTs, ts);
    userAcc.lastTs = Math.max(userAcc.lastTs, ts);
    if (row.relevance_score !== null && row.relevance_score !== undefined) {
      userAcc.relevanceTotal += row.relevance_score;
      userAcc.relevanceCount += 1;
    }
    users.set(sender, userAcc);
    if (senderId) {
      const ids = userIds.get(sender) || new Set<string>();
      ids.add(senderId);
      userIds.set(sender, ids);
    }
    if (PHONE_LIKE_RE.test(senderId) || PHONE_LIKE_RE.test(row.sender_name || "")) {
      userPossiblePhone.set(sender, true);
    }

    const channel = row.room_name || "Unknown";
    const channelAcc = channels.get(channel) || {
      messages: 0,
      activeDays: new Set<string>(),
      firstTs: ts,
      lastTs: ts,
      relevanceTotal: 0,
      relevanceCount: 0,
    };
    channelAcc.messages += 1;
    channelAcc.activeDays.add(dateKey);
    channelAcc.firstTs = Math.min(channelAcc.firstTs, ts);
    channelAcc.lastTs = Math.max(channelAcc.lastTs, ts);
    if (row.relevance_score !== null && row.relevance_score !== undefined) {
      channelAcc.relevanceTotal += row.relevance_score;
      channelAcc.relevanceCount += 1;
    }
    channels.set(channel, channelAcc);

    const userTopicMap = userTopicCounts.get(sender) || new Map<string, number>();
    const userChannelSet = userChannels.get(sender) || new Set<string>();
    userChannelSet.add(channel);
    userChannels.set(sender, userChannelSet);
    const channelMap = userChannelStats.get(sender) || new Map<string, StatBaseAccumulator>();
    const personChannelAcc = channelMap.get(channel) || {
      messages: 0,
      activeDays: new Set<string>(),
      firstTs: ts,
      lastTs: ts,
      relevanceTotal: 0,
      relevanceCount: 0,
    };
    personChannelAcc.messages += 1;
    personChannelAcc.activeDays.add(dateKey);
    personChannelAcc.firstTs = Math.min(personChannelAcc.firstTs, ts);
    personChannelAcc.lastTs = Math.max(personChannelAcc.lastTs, ts);
    channelMap.set(channel, personChannelAcc);
    userChannelStats.set(sender, channelMap);

    const body = String(row.body || "");
    const bodyLower = body.toLowerCase();
    const history = roomHistory.get(channel) || [];
    const recentHistory = history.filter((item) => ts - item.ts <= 2 * 60 * 60 * 1000);
    const recentParticipants = Array.from(
      new Set(recentHistory.map((item) => item.sender).filter((name) => name !== sender)),
    ).slice(-12);

    const mentionedTargets = new Set<string>();
    for (const participant of recentParticipants) {
      const regex =
        mentionRegexByName.get(participant) || participantMentionRegex(participant.toLowerCase());
      mentionRegexByName.set(participant, regex);
      if (regex.test(bodyLower)) {
        mentionedTargets.add(participant);
      }
    }

    const lastDifferent = [...recentHistory]
      .reverse()
      .find((item) => item.sender !== sender && ts - item.ts <= 45 * 60 * 1000);

    if (mentionedTargets.size > 0) {
      for (const target of mentionedTargets) {
        addRelationshipEdge(sender, target, { mentions: 1 });
      }
    }

    if (lastDifferent) {
      const lastAskedQuestion = lastDifferent.body.includes("?");
      const currentIsReplyLike =
        body.includes("?") || REPLY_SIGNAL_RE.test(bodyLower) || lastAskedQuestion;
      if (currentIsReplyLike) {
        addRelationshipEdge(sender, lastDifferent.sender, { replies: 1 });
      } else {
        addRelationshipEdge(sender, lastDifferent.sender, { turns: 1 });
      }
    }

    const hasDmSignal = DM_SIGNAL_RE.test(bodyLower);
    if (hasDmSignal) {
      dmSignalMessages += 1;
      dmSignalsByUser.set(sender, (dmSignalsByUser.get(sender) || 0) + 1);
      const dmTargets =
        mentionedTargets.size > 0
          ? Array.from(mentionedTargets)
          : lastDifferent
            ? [lastDifferent.sender]
            : [];
      for (const target of dmTargets) {
        addRelationshipEdge(sender, target, { dm_signals: 1 });
      }
    }

    for (const topic of parsedTopics) {
      userTopicMap.set(topic, (userTopicMap.get(topic) || 0) + 1);
      const topicAcc = topics.get(topic) || {
        messages: 0,
        activeDays: new Set<string>(),
        firstTs: ts,
        lastTs: ts,
        relevanceTotal: 0,
        relevanceCount: 0,
        daily: new Map<string, number>(),
        weekdayCounts: Array.from({ length: 7 }, () => 0),
        hourCounts: Array.from({ length: 24 }, () => 0),
      };
      topicAcc.messages += 1;
      topicAcc.activeDays.add(dateKey);
      topicAcc.firstTs = Math.min(topicAcc.firstTs, ts);
      topicAcc.lastTs = Math.max(topicAcc.lastTs, ts);
      if (row.relevance_score !== null && row.relevance_score !== undefined) {
        topicAcc.relevanceTotal += row.relevance_score;
        topicAcc.relevanceCount += 1;
      }
      topicAcc.daily.set(dateKey, (topicAcc.daily.get(dateKey) || 0) + 1);
      topicAcc.weekdayCounts[d.getDay()] += 1;
      topicAcc.hourCounts[d.getHours()] += 1;
      topics.set(topic, topicAcc);
    }
    userTopicCounts.set(sender, userTopicMap);

    const messageTopics = Array.from(new Set(parsedTopics)).sort((a, b) =>
      a.localeCompare(b),
    );
    if (messageTopics.length > 1) {
      for (let i = 0; i < messageTopics.length; i += 1) {
        for (let j = i + 1; j < messageTopics.length; j += 1) {
          const topic_a = messageTopics[i];
          const topic_b = messageTopics[j];
          const key = `${topic_a}||${topic_b}`;
          const pairAcc = cooccurrence.get(key) || {
            topic_a,
            topic_b,
            co_messages: 0,
            lastTs: ts,
            daily: new Map<string, number>(),
          };
          pairAcc.co_messages += 1;
          pairAcc.lastTs = Math.max(pairAcc.lastTs, ts);
          pairAcc.daily.set(dateKey, (pairAcc.daily.get(dateKey) || 0) + 1);
          cooccurrence.set(key, pairAcc);
        }
      }
    }

    recentHistory.push({ sender, ts, body: bodyLower });
    roomHistory.set(channel, recentHistory.slice(-40));
  }

  const timeline: DailyCount[] = timelineDays.map((date) => ({
    date,
    count: timelineMap.get(date) || 0,
  }));
  const classified: DailyCount[] = timelineDays.map((date) => ({
    date,
    count: classifiedMap.get(date) || 0,
  }));
  const with_topics: DailyCount[] = timelineDays.map((date) => ({
    date,
    count: withTopicsMap.get(date) || 0,
  }));
  const avgTopicCoverage =
    rowsData.length > 0
      ? Number((with_topics.reduce((sum, day) => sum + day.count, 0) / rowsData.length).toFixed(3))
      : 0;

  const userStats = Array.from(users.entries())
    .map(([name, acc]) => finalizeRanked(name, acc))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25);

  const peopleDirectory: PersonDirectoryEntry[] = Array.from(users.entries())
    .map(([name, acc]) => {
      const ranked = finalizeRanked(name, acc);
      const ids = Array.from(userIds.get(name) || []);
      const channelMap = userChannelStats.get(name) || new Map<string, StatBaseAccumulator>();
      return {
        ...ranked,
        sender_id: ids[0] || null,
        channels: Array.from(channelMap.entries())
          .map(([channelName, channelAcc]) => ({
            name: channelName,
            messages: channelAcc.messages,
            first_seen: dateKeyFromTs(channelAcc.firstTs),
            last_seen: dateKeyFromTs(channelAcc.lastTs),
          }))
          .sort((a, b) => {
            if (b.messages !== a.messages) return b.messages - a.messages;
            return a.name.localeCompare(b.name);
          }),
        top_topics: topTopicsForUser(userTopicCounts.get(name) || new Map<string, number>(), 6),
        possible_phone: userPossiblePhone.get(name) || false,
      };
    })
    .sort((a, b) => {
      if (b.messages !== a.messages) return b.messages - a.messages;
      return a.name.localeCompare(b.name);
    });

  const channelStats = Array.from(channels.entries())
    .map(([name, acc]) => finalizeRanked(name, acc))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25);

  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(now.getDate() - 13);

  const last7Start = dateKeyFromTs(sevenDaysAgo.getTime());
  const prev7Start = dateKeyFromTs(fourteenDaysAgo.getTime());

  const topicStats: TopicStat[] = Array.from(topics.entries())
    .map(([topic, acc]) => {
      const firstSeenWindow = dateKeyFromTs(acc.firstTs);
      const firstSeenEver = dateKeyFromTs(topicFirstSeenEver.get(topic) ?? acc.firstTs);
      const lastSeen = dateKeyFromTs(acc.lastTs);
      const spanDays = Math.max(
        1,
        Math.floor((acc.lastTs - acc.firstTs) / (24 * 60 * 60 * 1000)) + 1,
      );
      const activeDays = acc.activeDays.size;
      const ratio = activeDays / spanDays;

      let last7 = 0;
      let prev7 = 0;
      const daily = timelineDays.map((date) => {
        const count = acc.daily.get(date) || 0;
        if (date >= last7Start) {
          last7 += count;
        } else if (date >= prev7Start && date < last7Start) {
          prev7 += count;
        }
        return { date, count };
      });

      let trend: "up" | "flat" | "down" = "flat";
      if (last7 >= prev7 + 3) trend = "up";
      else if (prev7 >= last7 + 3) trend = "down";

      const peakWeekday = weekdayLabels[peakIndex(acc.weekdayCounts)];
      const peakHour = peakIndex(acc.hourCounts);

      return {
        topic,
        started_on: firstSeenEver,
        started_in_window: firstSeenWindow,
        last_seen: lastSeen,
        message_count: acc.messages,
        active_days: activeDays,
        span_days: spanDays,
        recurrence_ratio: Number(ratio.toFixed(3)),
        recurrence_label: recurrenceLabel(ratio, activeDays),
        last_7d: last7,
        prev_7d: prev7,
        trend,
        peak_weekday: peakWeekday,
        peak_hour: peakHour,
        daily,
      };
    })
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 40);

  const cooccurrenceStats: TopicCooccurrence[] = Array.from(cooccurrence.values())
    .map((pair) => {
      const topicA = topics.get(pair.topic_a);
      const topicB = topics.get(pair.topic_b);
      const aCount = topicA?.messages || 0;
      const bCount = topicB?.messages || 0;
      const overlapBase = Math.max(1, Math.min(aCount, bCount));
      const union = Math.max(1, aCount + bCount - pair.co_messages);

      let last7 = 0;
      let prev7 = 0;
      for (const [date, count] of pair.daily.entries()) {
        if (date >= last7Start) {
          last7 += count;
        } else if (date >= prev7Start && date < last7Start) {
          prev7 += count;
        }
      }
      let trend: "up" | "flat" | "down" = "flat";
      if (last7 >= prev7 + 2) trend = "up";
      else if (prev7 >= last7 + 2) trend = "down";

      return {
        topic_a: pair.topic_a,
        topic_b: pair.topic_b,
        co_messages: pair.co_messages,
        overlap_ratio: Number((pair.co_messages / overlapBase).toFixed(3)),
        jaccard: Number((pair.co_messages / union).toFixed(3)),
        last_seen: dateKeyFromTs(pair.lastTs),
        trend,
      };
    })
    .sort((a, b) => b.co_messages - a.co_messages)
    .slice(0, 40);

  const seasonality: SeasonalityStats = {
    by_weekday: weekdayLabels.map((weekday, i) => ({
      weekday,
      count: weekdayCounts[i],
    })),
    by_hour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hourCounts[hour],
    })),
    topic_peaks: topicStats.slice(0, 20).map((topic) => ({
      topic: topic.topic,
      messages: topic.message_count,
      peak_weekday: topic.peak_weekday,
      peak_hour: topic.peak_hour,
    })),
  };

  const relationshipNodes: RelationshipNode[] = Array.from(users.entries())
    .map(([name, acc]) => ({
      id: name,
      messages: acc.messages,
      channels: userChannels.get(name)?.size || 0,
      replies_out: relationshipOutbound.get(name) || 0,
      replies_in: relationshipInbound.get(name) || 0,
      dm_signals: dmSignalsByUser.get(name) || 0,
      top_topics: topTopicsForUser(userTopicCounts.get(name) || new Map<string, number>(), 4),
    }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 220);

  const relationshipNodeSet = new Set(relationshipNodes.map((node) => node.id));
  const relationshipEdgeStats: RelationshipEdge[] = Array.from(relationshipEdges.values())
    .filter(
      (edge) =>
        relationshipNodeSet.has(edge.source) &&
        relationshipNodeSet.has(edge.target) &&
        edge.weight >= 1,
    )
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 1800);

  const alignmentNodes = relationshipNodes.slice(0, 120);
  const alignmentEdges: TopicAlignmentEdge[] = [];
  for (let i = 0; i < alignmentNodes.length; i += 1) {
    for (let j = i + 1; j < alignmentNodes.length; j += 1) {
      const left = alignmentNodes[i];
      const right = alignmentNodes[j];
      const leftTopics = userTopicCounts.get(left.id) || new Map<string, number>();
      const rightTopics = userTopicCounts.get(right.id) || new Map<string, number>();
      if (leftTopics.size === 0 || rightTopics.size === 0) continue;

      const similarity = cosineSimilarity(leftTopics, rightTopics);
      if (similarity < 0.18) continue;

      const shared = Array.from(leftTopics.keys())
        .filter((topic) => rightTopics.has(topic))
        .map((topic) => ({
          topic,
          score: Math.min(leftTopics.get(topic) || 0, rightTopics.get(topic) || 0),
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.topic.localeCompare(b.topic);
        });
      if (shared.length < 2) continue;

      alignmentEdges.push({
        source: left.id,
        target: right.id,
        similarity: Number(similarity.toFixed(3)),
        overlap_count: shared.length,
        shared_topics: shared.slice(0, 4).map((item) => item.topic),
      });
    }
  }
  alignmentEdges.sort((a, b) => b.similarity - a.similarity);

  const semanticLookbackDays =
    resolvedWindow === null
      ? Math.min(Math.max(windowDaysValue, 30), 365)
      : Math.min(Math.max(resolvedWindow, 30), 365);
  const semanticCutoffTs =
    Date.now() - semanticLookbackDays * 24 * 60 * 60 * 1000;
  const semantic =
    (await computeSemanticAnalytics({
      roomScope: scope,
      cutoffTs: semanticCutoffTs,
      lookbackDays: semanticLookbackDays,
      maxClusters: 12,
    })) || {
      enabled: false,
      coverage_pct: 0,
      orphan_pct: 0,
      avg_coherence: 0,
      drift_risk: "low",
      checks: ["pgvector not configured; semantic analytics disabled."],
      arcs: [],
      trends: [],
    };

  return {
    window_days: windowDaysValue,
    generated_at: new Date().toISOString(),
    scope: {
      mode: scope.mode,
      active_group_count: Math.max(scope.activeGroupIds.length, scope.activeGroupNames.length),
      excluded_groups: scope.excludedGroups,
    },
    totals: {
      messages: rowsData.length,
      users: users.size,
      channels: channels.size,
      topics: topics.size,
      avg_relevance:
        relevanceCount > 0
          ? Number((relevanceTotal / relevanceCount).toFixed(2))
          : null,
    },
    history,
    timeline,
    coverage: {
      classified,
      with_topics,
      avg_topic_coverage: avgTopicCoverage,
    },
    users: userStats,
    channels: channelStats,
    people_directory: peopleDirectory,
    topics: topicStats,
    cooccurrence: cooccurrenceStats,
    seasonality,
    network: {
      relationships: {
        nodes: relationshipNodes,
        edges: relationshipEdgeStats,
        summaries: {
          included_nodes: relationshipNodes.length,
          total_users_in_window: users.size,
          total_messages: rowsData.length,
          directed_edges: relationshipEdgeStats.length,
          dm_signal_messages: dmSignalMessages,
        },
      },
      topic_alignment: {
        nodes: alignmentNodes,
        edges: alignmentEdges.slice(0, 1400),
        summaries: {
          included_nodes: alignmentNodes.length,
          compared_nodes: alignmentNodes.length,
          alignment_edges: alignmentEdges.length,
        },
      },
    },
    semantic,
  };
}

export async function getTopicDrilldown(
  topicName: string,
  windowDays: number | null = 90,
): Promise<TopicDrilldown | null> {
  const needle = topicName.trim().toLowerCase();
  if (!needle) return null;

  const resolvedWindow = resolveWindowDays(windowDays);
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope, 1);

  let pi = roomScope.nextIndex;
  const windowWhereParts: string[] = ["c.topics IS NOT NULL"];
  const windowParams: unknown[] = [];
  if (roomScope.clause) {
    windowWhereParts.push(roomScope.clause);
    windowParams.push(...roomScope.params);
  }
  if (cutoffTs !== null) {
    windowWhereParts.push(`m.timestamp >= $${pi++}`);
    windowParams.push(cutoffTs);
  }

  const scopedWhereParts: string[] = ["c.topics IS NOT NULL"];
  const scopedParams: unknown[] = [];
  if (roomScope.clause) {
    scopedWhereParts.push(roomScope.clause);
    scopedParams.push(...roomScope.params);
  }

  const { rows } = await pool.query(
    `SELECT m.id, m.timestamp, m.room_name, m.sender_name, m.body, c.relevance_score, c.topics
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     WHERE ${windowWhereParts.join(" AND ")}
     ORDER BY m.timestamp ASC`,
    windowParams,
  );
  const rowsData = (rows as {
    id: string;
    timestamp: unknown;
    room_name: string;
    sender_name: string;
    body: string;
    relevance_score: number | null;
    topics: string | null;
  }[])
    .map((row) => ({
      ...row,
      timestamp: coerceTimestampMs(row.timestamp),
    }))
    .filter((row): row is {
      id: string;
      timestamp: number;
      room_name: string;
      sender_name: string;
      body: string;
      relevance_score: number | null;
      topics: string | null;
    } => row.timestamp !== null);

  const { rows: allScopedRows } = await pool.query(
    `SELECT m.timestamp, c.topics
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     WHERE ${scopedWhereParts.join(" AND ")}`,
    scopedParams,
  );

  let canonicalTopic = topicName.trim();
  const topicRows = rowsData.filter((row) => {
    const messageTopics = parseTopics(row.topics);
    for (const topic of messageTopics) {
      if (topic.toLowerCase() === needle) {
        canonicalTopic = topic;
        return true;
      }
    }
    return false;
  });

  if (topicRows.length === 0) {
    return null;
  }

  const timelineDays =
    resolvedWindow === null
      ? enumerateDaysFromTs(topicRows[0].timestamp, Date.now())
      : enumerateDays(resolvedWindow);
  const windowDaysValue = timelineDays.length;
  const timelineMap = new Map<string, number>(timelineDays.map((d) => [d, 0]));
  const topicActiveDays = new Set<string>();
  const userCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();

  for (const row of topicRows) {
    const date = dateKeyFromTs(row.timestamp);
    timelineMap.set(date, (timelineMap.get(date) || 0) + 1);
    topicActiveDays.add(date);
    const user = normalizeSenderName(row.sender_name || "Unknown", userAliases);
    userCounts.set(user, (userCounts.get(user) || 0) + 1);
    const channel = row.room_name || "Unknown";
    channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);
  }

  const firstSeenWindowTs = topicRows[0].timestamp;
  const lastSeenWindowTs = topicRows[topicRows.length - 1].timestamp;
  let firstSeenEverTs = firstSeenWindowTs;
  for (const row of allScopedRows) {
    const ts = coerceTimestampMs(row.timestamp);
    if (ts === null) continue;
    for (const topic of parseTopics(row.topics)) {
      if (topic.toLowerCase() === needle) {
        if (ts < firstSeenEverTs) firstSeenEverTs = ts;
        break;
      }
    }
  }

  const spanDays = Math.max(
    1,
    Math.floor((lastSeenWindowTs - firstSeenWindowTs) / (24 * 60 * 60 * 1000)) + 1,
  );
  const recurrenceRatio = topicActiveDays.size / spanDays;

  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(now.getDate() - 13);
  const last7Start = dateKeyFromTs(sevenDaysAgo.getTime());
  const prev7Start = dateKeyFromTs(fourteenDaysAgo.getTime());
  let last7 = 0;
  let prev7 = 0;
  const timeline: DailyCount[] = timelineDays.map((date) => {
    const count = timelineMap.get(date) || 0;
    if (date >= last7Start) last7 += count;
    else if (date >= prev7Start && date < last7Start) prev7 += count;
    return { date, count };
  });
  let trend: "up" | "flat" | "down" = "flat";
  if (last7 >= prev7 + 3) trend = "up";
  else if (prev7 >= last7 + 3) trend = "down";

  const topicCounts = new Map<string, number>();
  for (const row of rowsData) {
    for (const topic of new Set(parseTopics(row.topics))) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }
  const selectedTopicCount = topicCounts.get(canonicalTopic) || topicRows.length;

  const relatedAcc = new Map<string, PairAccumulator>();
  for (const row of topicRows) {
    const date = dateKeyFromTs(row.timestamp);
    for (const topic of new Set(parseTopics(row.topics))) {
      if (topic.toLowerCase() === needle) continue;
      const key = topic;
      const prev = relatedAcc.get(key) || {
        topic_a: canonicalTopic,
        topic_b: topic,
        co_messages: 0,
        lastTs: row.timestamp,
        daily: new Map<string, number>(),
      };
      prev.co_messages += 1;
      prev.lastTs = Math.max(prev.lastTs, row.timestamp);
      prev.daily.set(date, (prev.daily.get(date) || 0) + 1);
      relatedAcc.set(key, prev);
    }
  }

  const related_topics = Array.from(relatedAcc.values())
    .map((pair) => {
      const otherCount = topicCounts.get(pair.topic_b) || pair.co_messages;
      const overlapBase = Math.max(1, Math.min(selectedTopicCount, otherCount));
      const union = Math.max(1, selectedTopicCount + otherCount - pair.co_messages);
      let pairLast7 = 0;
      let pairPrev7 = 0;
      for (const [date, count] of pair.daily.entries()) {
        if (date >= last7Start) pairLast7 += count;
        else if (date >= prev7Start && date < last7Start) pairPrev7 += count;
      }
      let pairTrend: "up" | "flat" | "down" = "flat";
      if (pairLast7 >= pairPrev7 + 2) pairTrend = "up";
      else if (pairPrev7 >= pairLast7 + 2) pairTrend = "down";

      return {
        topic_a: canonicalTopic,
        topic_b: pair.topic_b,
        co_messages: pair.co_messages,
        overlap_ratio: Number((pair.co_messages / overlapBase).toFixed(3)),
        jaccard: Number((pair.co_messages / union).toFixed(3)),
        last_seen: dateKeyFromTs(pair.lastTs),
        trend: pairTrend,
      };
    })
    .sort((a, b) => b.co_messages - a.co_messages)
    .slice(0, 20);

  const top_users = Array.from(userCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, messages]) => ({ name, messages }));

  const top_channels = Array.from(channelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, messages]) => ({ name, messages }));

  const recent_messages = topicRows
    .slice(-40)
    .reverse()
    .map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      date: new Date(row.timestamp).toLocaleString(),
      room_name: row.room_name,
      sender_name: normalizeSenderName(row.sender_name || "Unknown", userAliases),
      body: row.body,
      relevance_score: row.relevance_score,
    }));

  return {
    topic: canonicalTopic,
    window_days: windowDaysValue,
    generated_at: new Date().toISOString(),
    scope: {
      mode: scope.mode,
      active_group_count: Math.max(scope.activeGroupIds.length, scope.activeGroupNames.length),
      excluded_groups: scope.excludedGroups,
    },
    summary: {
      first_seen: dateKeyFromTs(firstSeenEverTs),
      last_seen: dateKeyFromTs(lastSeenWindowTs),
      message_count: topicRows.length,
      active_days: topicActiveDays.size,
      recurrence_ratio: Number(recurrenceRatio.toFixed(3)),
      recurrence_label: recurrenceLabel(recurrenceRatio, topicActiveDays.size),
      trend,
      last_7d: last7,
      prev_7d: prev7,
    },
    timeline,
    top_users,
    top_channels,
    related_topics,
    recent_messages,
  };
}

type SpaceSource = "beeper" | "google_groups" | "other";
const GOOGLE_GROUPS_ROOM_ID_PREFIX = "googlegroup:";
export type SpaceTriageMode = "focus" | "balanced" | "explore";

interface SpaceTriageDefaults {
  minRelevance: number;
  maxMessages: number;
}

const SPACE_TRIAGE_DEFAULTS: Record<SpaceTriageMode, SpaceTriageDefaults> = {
  focus: { minRelevance: 5, maxMessages: 32 },
  balanced: { minRelevance: 3, maxMessages: 60 },
  explore: { minRelevance: 0, maxMessages: 100 },
};

export interface SpacesDashboardOptions {
  mode?: SpaceTriageMode;
  query?: string;
  minRelevance?: number;
  maxMessages?: number;
}

export interface SourceSpaceSummary {
  source: SpaceSource;
  label: string;
  messages: number;
  rooms: number;
  people: number;
}

export interface SpaceRoomSummary {
  key: string;
  source: SpaceSource;
  source_label: string;
  room_id: string;
  room_name: string;
  messages: number;
  people: number;
  last_seen: string;
  last_seen_ts: number;
}

export interface SpaceRecentMessage {
  id: string;
  timestamp: number;
  date: string;
  room_id: string;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
  contribution_flag: number | null;
  alert_level: string | null;
  topics: string[];
  priority_score: number;
}

export interface SpacesDashboard {
  window_days: number;
  generated_at: string;
  scope: {
    mode: "active_groups" | "excluded_groups" | "all";
    active_group_count: number;
    excluded_groups: string[];
  };
  totals: {
    messages: number;
    rooms: number;
    people: number;
  };
  sources: SourceSpaceSummary[];
  spaces: SpaceRoomSummary[];
  selected_space: string | null;
  triage: {
    mode: SpaceTriageMode;
    query: string;
    min_relevance: number;
    max_messages: number;
    filtered_messages: number;
    high_signal_messages: number;
    contribution_messages: number;
    hot_alert_messages: number;
    avg_relevance: number;
  };
  top_topics: {
    topic: string;
    messages: number;
    avg_relevance: number;
  }[];
  top_people: {
    sender_name: string;
    messages: number;
    avg_relevance: number;
    contributions: number;
    hot_alerts: number;
  }[];
  recent_messages: SpaceRecentMessage[];
}

function sourceLabel(source: SpaceSource): string {
  if (source === "google_groups") return "Google Groups";
  if (source === "beeper") return "Beeper";
  return "Other";
}

export async function getSpacesDashboard(
  windowDays: number | null = 30,
  selectedSpace: string | null = null,
  options: SpacesDashboardOptions = {},
): Promise<SpacesDashboard> {
  const publicMode = isPublicModeEnabled();
  const resolvedWindow = resolveWindowDays(windowDays);
  const triageMode: SpaceTriageMode =
    options.mode && options.mode in SPACE_TRIAGE_DEFAULTS ? options.mode : "focus";
  const triageDefaults = SPACE_TRIAGE_DEFAULTS[triageMode];
  const minRelevance = Math.max(
    0,
    Math.min(9, Math.round(options.minRelevance ?? triageDefaults.minRelevance)),
  );
  const maxMessages = Math.max(
    10,
    Math.min(200, Math.round(options.maxMessages ?? triageDefaults.maxMessages)),
  );
  const query = String(options.query || "").trim();
  const queryLike = `%${query.toLowerCase()}%`;
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const scope = await loadRoomScope(pool);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope, 1);

  let pi = roomScope.nextIndex;
  const whereParts: string[] = [];
  const whereParams: unknown[] = [];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    whereParams.push(...roomScope.params);
  }
  if (cutoffTs !== null) {
    whereParts.push(`m.timestamp >= $${pi++}`);
    whereParams.push(cutoffTs);
  }
  whereParts.push(`LOWER(m.room_id) LIKE $${pi++}`);
  whereParams.push(`${GOOGLE_GROUPS_ROOM_ID_PREFIX}%`);
  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  let mpi = pi;

  const { rows } = await pool.query(
    `SELECT m.room_id, m.room_name, m.sender_name, m.timestamp
     FROM messages m
     ${whereClause}
     ORDER BY m.timestamp DESC`,
    whereParams,
  );
  const rowsData = rows as {
    room_id: string;
    room_name: string;
    sender_name: string;
    timestamp: number;
  }[];

  const roomAcc = new Map<
    string,
    {
      source: SpaceSource;
      roomId: string;
      roomName: string;
      messages: number;
      people: Set<string>;
      lastTs: number;
    }
  >();
  const allPeople = new Set<string>();
  for (const row of rowsData) {
    const roomId = String(row.room_id || "").trim();
    const roomName = String(row.room_name || "Unknown").trim() || "Unknown";
    const source: SpaceSource = "google_groups";
    const key = roomId || `${GOOGLE_GROUPS_ROOM_ID_PREFIX}${roomName.toLowerCase()}`;
    const sender = normalizeSenderName(row.sender_name || "Unknown", userAliases);
    allPeople.add(sender);
    const acc = roomAcc.get(key) || {
      source,
      roomId: roomId || key,
      roomName,
      messages: 0,
      people: new Set<string>(),
      lastTs: row.timestamp,
    };
    acc.messages += 1;
    acc.people.add(sender);
    acc.lastTs = Math.max(acc.lastTs, row.timestamp);
    roomAcc.set(key, acc);
  }

  const spaces: SpaceRoomSummary[] = Array.from(roomAcc.entries())
    .map(([key, acc]) => ({
      key,
      source: acc.source,
      source_label: sourceLabel(acc.source),
      room_id: acc.roomId,
      room_name: acc.roomName,
      messages: acc.messages,
      people: acc.people.size,
      last_seen: new Date(acc.lastTs).toLocaleString(),
      last_seen_ts: acc.lastTs,
    }))
    .sort((a, b) => {
      if (b.messages !== a.messages) return b.messages - a.messages;
      return b.last_seen_ts - a.last_seen_ts;
    });

  const sources: SourceSpaceSummary[] = [
    {
      source: "google_groups",
      label: "Google Groups",
      messages: rowsData.length,
      rooms: spaces.length,
      people: allPeople.size,
    },
  ];

  const selectedRoomId =
    selectedSpace && spaces.some((space) => space.room_id === selectedSpace)
      ? selectedSpace
      : spaces[0]?.room_id || null;

  let triageFilteredMessages = 0;
  let triageHighSignal = 0;
  let triageContributions = 0;
  let triageHotAlerts = 0;
  let triageAvgRelevance = 0;
  let top_topics: SpacesDashboard["top_topics"] = [];
  let top_people: SpacesDashboard["top_people"] = [];
  let recent_messages: SpaceRecentMessage[] = [];

  if (selectedRoomId) {
    const messageWhereParts = [...whereParts, `m.room_id = $${mpi++}`];
    const messageParams = [...whereParams, selectedRoomId];
    if (query) {
      messageWhereParts.push(`(LOWER(m.body) LIKE $${mpi++} OR LOWER(m.sender_name) LIKE $${mpi++})`);
      messageParams.push(queryLike, queryLike);
    }
    if (triageMode === "focus") {
      messageWhereParts.push(
        `(COALESCE(c.relevance_score, 0) >= $${mpi++} OR COALESCE(c.contribution_flag, 0) = 1 OR c.alert_level = 'hot')`,
      );
      messageParams.push(minRelevance);
    } else if (minRelevance > 0) {
      messageWhereParts.push(`COALESCE(c.relevance_score, 0) >= $${mpi++}`);
      messageParams.push(minRelevance);
    }

    const { rows: rankedRows } = await pool.query(
      `SELECT m.id, m.timestamp, m.room_id, m.room_name, m.sender_name, m.body,
              c.relevance_score, c.contribution_flag, c.alert_level, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${messageWhereParts.join(" AND ")}
       ORDER BY m.timestamp DESC
       LIMIT 600`,
      messageParams,
    );
    const ranked = rankedRows
      .map((row: unknown) => {
        const typed = row as {
          id: string;
          timestamp: number;
          room_id: string;
          room_name: string;
          sender_name: string;
          body: string;
          relevance_score: number | null;
          contribution_flag: number | null;
          alert_level: string | null;
          topics: string | null;
        };
        const timestamp = typed.timestamp;
        const nowTs = Date.now();
        const ageHours = Math.max(0, (nowTs - timestamp) / 3_600_000);
        const relevance = typed.relevance_score ?? 0;
        const recencyBonus = Math.max(0, 1.5 - ageHours / 24);
        const contributionBonus = !publicMode && (typed.contribution_flag || 0) > 0 ? 2 : 0;
        const alertBonus =
          typed.alert_level === "hot" ? 2.5 : typed.alert_level === "digest" ? 1 : 0;
        const queryBonus =
          query &&
          (`${typed.sender_name} ${typed.body}`.toLowerCase().includes(query.toLowerCase()) || false)
            ? 0.5
            : 0;
        const priorityScore =
          relevance * 0.8 + contributionBonus + alertBonus + recencyBonus + queryBonus;
        return {
          id: typed.id,
          timestamp,
          date: new Date(timestamp).toLocaleString(),
          room_id: typed.room_id,
          room_name: typed.room_name,
          sender_name: normalizeSenderName(typed.sender_name || "Unknown", userAliases),
          body: typed.body || "",
          relevance_score: typed.relevance_score,
          contribution_flag: typed.contribution_flag,
          alert_level: typed.alert_level,
          topics: parseTopics(typed.topics),
          priority_score: Number(priorityScore.toFixed(3)),
        };
      });

    triageFilteredMessages = ranked.length;
    if (ranked.length > 0) {
      triageHighSignal = ranked.filter(
        (item) =>
          (item.relevance_score ?? 0) >= 7 ||
          (item.contribution_flag || 0) > 0 ||
          item.alert_level === "hot",
      ).length;
      triageContributions = publicMode
        ? 0
        : ranked.filter((item) => (item.contribution_flag || 0) > 0).length;
      triageHotAlerts = ranked.filter((item) => item.alert_level === "hot").length;
      const relevanceRows = ranked.filter((item) => item.relevance_score !== null);
      triageAvgRelevance =
        relevanceRows.length > 0
          ? Number(
              (
                relevanceRows.reduce((sum, item) => sum + (item.relevance_score || 0), 0) /
                relevanceRows.length
              ).toFixed(2),
            )
          : 0;
    }

    const sortedRanked = [...ranked].sort((a, b) => {
      if (triageMode === "explore") {
        return b.timestamp - a.timestamp || b.priority_score - a.priority_score;
      }
      if (triageMode === "balanced") {
        return (
          (b.relevance_score ?? Number.NEGATIVE_INFINITY) -
            (a.relevance_score ?? Number.NEGATIVE_INFINITY) ||
          b.priority_score - a.priority_score ||
          b.timestamp - a.timestamp
        );
      }
      return b.priority_score - a.priority_score || b.timestamp - a.timestamp;
    });

    recent_messages = sortedRanked.slice(0, maxMessages);

    const topicAcc = new Map<string, { messages: number; relevanceTotal: number; relevanceRows: number }>();
    const peopleAcc = new Map<
      string,
      { messages: number; relevanceTotal: number; relevanceRows: number; contributions: number; hotAlerts: number }
    >();
    for (const item of recent_messages) {
      const person = peopleAcc.get(item.sender_name) || {
        messages: 0,
        relevanceTotal: 0,
        relevanceRows: 0,
        contributions: 0,
        hotAlerts: 0,
      };
      person.messages += 1;
      if (item.relevance_score !== null) {
        person.relevanceTotal += item.relevance_score;
        person.relevanceRows += 1;
      }
      if (!publicMode && (item.contribution_flag || 0) > 0) person.contributions += 1;
      if (item.alert_level === "hot") person.hotAlerts += 1;
      peopleAcc.set(item.sender_name, person);

      for (const topic of new Set(item.topics)) {
        const acc = topicAcc.get(topic) || { messages: 0, relevanceTotal: 0, relevanceRows: 0 };
        acc.messages += 1;
        if (item.relevance_score !== null) {
          acc.relevanceTotal += item.relevance_score;
          acc.relevanceRows += 1;
        }
        topicAcc.set(topic, acc);
      }
    }

    top_topics = Array.from(topicAcc.entries())
      .map(([topic, acc]) => ({
        topic,
        messages: acc.messages,
        avg_relevance:
          acc.relevanceRows > 0 ? Number((acc.relevanceTotal / acc.relevanceRows).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.messages - a.messages || b.avg_relevance - a.avg_relevance)
      .slice(0, 8);

    top_people = Array.from(peopleAcc.entries())
      .map(([sender_name, acc]) => ({
        sender_name,
        messages: acc.messages,
        avg_relevance:
          acc.relevanceRows > 0 ? Number((acc.relevanceTotal / acc.relevanceRows).toFixed(2)) : 0,
        contributions: acc.contributions,
        hot_alerts: acc.hotAlerts,
      }))
      .sort(
        (a, b) =>
          b.messages - a.messages ||
          b.contributions - a.contributions ||
          b.avg_relevance - a.avg_relevance,
      )
      .slice(0, 8);
  }

  return {
    window_days: resolvedWindow ?? Math.max(30, Math.ceil(rowsData.length / 200)),
    generated_at: new Date().toISOString(),
    scope: {
      mode: scope.mode,
      active_group_count: Math.max(scope.activeGroupIds.length, scope.activeGroupNames.length),
      excluded_groups: scope.excludedGroups,
    },
    totals: {
      messages: rowsData.length,
      rooms: spaces.length,
      people: allPeople.size,
    },
    sources,
    spaces,
    selected_space: selectedRoomId,
    triage: {
      mode: triageMode,
      query,
      min_relevance: minRelevance,
      max_messages: maxMessages,
      filtered_messages: triageFilteredMessages,
      high_signal_messages: triageHighSignal,
      contribution_messages: triageContributions,
      hot_alert_messages: triageHotAlerts,
      avg_relevance: triageAvgRelevance,
    },
    top_topics,
    top_people,
    recent_messages,
  };
}

export interface LinkRow {
  id: number;
  url: string;
  url_hash: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_count: number;
  value_score: number;
  report_date: string | null;
  authored_by: string | null;
  pinned: number | null;
}

export interface LinkStats {
  total: number;
  total_mentions: number;
  first_seen: string | null;
  last_seen: string | null;
  sources: { name: string; count: number }[];
  sharers: { name: string; count: number }[];
  categories: { name: string; count: number }[];
  authors: { name: string; count: number }[];
}

function sourceFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("github.com")) return "github";
    if (host.includes("x.com") || host.includes("twitter.com")) return "x";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
    if (host.includes("substack.com")) return "substack";
    if (host.includes("medium.com")) return "medium";
    if (host.includes("arxiv.org")) return "arxiv";
    if (host.includes("reddit.com")) return "reddit";
    if (host.includes("news.ycombinator.com")) return "hackernews";
    if (host.includes("linkedin.com")) return "linkedin";
    if (host.includes("notion.so")) return "notion";
    if (host.includes("docs.google.com")) return "gdocs";
    return "other";
  } catch { return "other"; }
}

const SORT_MAP: Record<string, string> = {
  trending: "CAST(mention_count AS FLOAT) / GREATEST(1, EXTRACT(EPOCH FROM (NOW() - last_seen::timestamptz)) / 86400.0 + 1) DESC NULLS LAST, last_seen DESC NULLS LAST",
  value: "value_score DESC NULLS LAST, last_seen DESC NULLS LAST",
  recent: "last_seen DESC NULLS LAST",
  shared: "mention_count DESC NULLS LAST, value_score DESC NULLS LAST",
  oldest: "first_seen ASC NULLS LAST",
};

const SQLITE_LINK_SORT_MAP: Record<string, string> = {
  trending: "CAST(mention_count AS REAL) / MAX(1.0, (julianday('now') - julianday(last_seen)) + 1.0) DESC, last_seen DESC",
  value: "value_score DESC, last_seen DESC",
  recent: "last_seen DESC",
  shared: "mention_count DESC, value_score DESC",
  oldest: "first_seen ASC",
};

function sqliteLinkWhere(opts: {
  category?: string;
  days?: number;
  source?: string;
  sharedBy?: string;
  authoredBy?: string;
  pinned?: boolean;
}): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push("last_seen >= ?");
    params.push(cutoff);
  }
  if (opts.source && opts.source !== "all") {
    const patterns: Record<string, string> = {
      github: "%github.com%",
      x: "%x.com%",
      youtube: "%youtu%",
      substack: "%substack.com%",
      medium: "%medium.com%",
      arxiv: "%arxiv.org%",
      reddit: "%reddit.com%",
      hackernews: "%news.ycombinator.com%",
      linkedin: "%linkedin.com%",
      notion: "%notion.so%",
      gdocs: "%docs.google.com%",
    };
    const pat = patterns[opts.source];
    if (pat) {
      where.push("url LIKE ?");
      params.push(pat);
    }
  }
  if (opts.sharedBy) {
    where.push("shared_by LIKE ?");
    params.push(`%${opts.sharedBy}%`);
  }
  if (opts.authoredBy === "any") {
    where.push("authored_by IS NOT NULL AND authored_by <> ''");
  } else if (opts.authoredBy) {
    where.push("authored_by LIKE ?");
    params.push(`%${opts.authoredBy}%`);
  }
  if (opts.pinned) {
    where.push("pinned = 1");
  }
  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

function getLinkStatsFromSqlite(opts: { days?: number }): LinkStats {
  const db = new Database(SQLITE_DB_PATH, { readonly: true });
  try {
    const { whereSql, params } = sqliteLinkWhere({ days: opts.days });
    const totalRow = db.prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(mention_count), 0) as mentions, MIN(first_seen) as first_seen, MAX(last_seen) as last_seen
       FROM links ${whereSql}`,
    ).get(...params) as { c: number; mentions: number; first_seen: string | null; last_seen: string | null };
    const catRows = db
      .prepare(`SELECT category, COUNT(*) as cnt FROM links ${whereSql} GROUP BY category ORDER BY cnt DESC`)
      .all(...params) as { category: string | null; cnt: number }[];
    const sharerRows = db
      .prepare(
        `SELECT shared_by, COUNT(*) as cnt FROM links ${whereSql}${whereSql ? " AND" : " WHERE"} shared_by <> '' GROUP BY shared_by ORDER BY cnt DESC LIMIT 20`,
      )
      .all(...params) as { shared_by: string; cnt: number }[];
    const urlRows = db.prepare(`SELECT url FROM links ${whereSql}`).all(...params) as { url: string }[];
    const authorRows = db
      .prepare(
        `SELECT authored_by, COUNT(*) as cnt FROM links ${whereSql}${whereSql ? " AND" : " WHERE"} authored_by <> '' AND authored_by IS NOT NULL GROUP BY authored_by ORDER BY cnt DESC`,
      )
      .all(...params) as { authored_by: string; cnt: number }[];

    const sourceCounts: Record<string, number> = {};
    for (const row of urlRows) {
      const source = sourceFromUrl(row.url);
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }

    return {
      total: Number(totalRow.c || 0),
      total_mentions: Number(totalRow.mentions || 0),
      first_seen: totalRow.first_seen,
      last_seen: totalRow.last_seen,
      sources: Object.entries(sourceCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      sharers: sharerRows.map((row) => ({ name: row.shared_by, count: Number(row.cnt || 0) })),
      categories: catRows.map((row) => ({ name: row.category || "uncategorized", count: Number(row.cnt || 0) })),
      authors: authorRows.map((row) => ({ name: row.authored_by, count: Number(row.cnt || 0) })),
    };
  } finally {
    db.close();
  }
}

function getLinksFromSqlite(opts: {
  category?: string;
  days?: number;
  limit?: number;
  sort?: string;
  source?: string;
  sharedBy?: string;
  authoredBy?: string;
  pinned?: boolean;
}): LinkRow[] {
  const db = new Database(SQLITE_DB_PATH, { readonly: true });
  try {
    const { whereSql, params } = sqliteLinkWhere(opts);
    const orderBy = SQLITE_LINK_SORT_MAP[opts.sort || "value"] || SQLITE_LINK_SORT_MAP.value;
    const limit = Math.min(Math.max(1, opts.limit || 50), 200);
    return db
      .prepare(
        `SELECT id, url, url_hash, title, category, relevance, shared_by,
                source_group, first_seen, last_seen, mention_count, value_score,
                report_date, authored_by, pinned
         FROM links ${whereSql}
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(...params, limit) as LinkRow[];
  } finally {
    db.close();
  }
}

export async function getLinkStats(opts: { days?: number }): Promise<LinkStats> {
  if (shouldUseSqliteAtlas()) {
    return getLinkStatsFromSqlite(opts);
  }
  let pi = 1;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push(`last_seen >= $${pi++}`);
    params.push(cutoff);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) as c, COALESCE(SUM(mention_count), 0) as mentions, MIN(first_seen) as first_seen, MAX(last_seen) as last_seen
     FROM links ${whereSql}`,
    params,
  );
  const totalRow = totalRows[0] as { c: unknown; mentions: unknown; first_seen: string | null; last_seen: string | null };
  const total = Number(totalRow.c || 0);

  const { rows: catRows } = await pool.query(
    `SELECT category, COUNT(*) as cnt FROM links ${whereSql} GROUP BY category ORDER BY cnt DESC`,
    params,
  );

  const sharerSql = `SELECT shared_by, COUNT(*) as cnt FROM links ${whereSql}${where.length ? " AND" : " WHERE"} shared_by <> '' GROUP BY shared_by ORDER BY cnt DESC LIMIT 20`;
  const { rows: sharerRows } = await pool.query(sharerSql, params);

  // For sources, we need to compute from URLs — do it in JS
  const { rows: urlRows } = await pool.query(
    `SELECT url FROM links ${whereSql}`,
    params,
  );

  const sourceCounts: Record<string, number> = {};
  for (const r of urlRows as { url: string }[]) {
    const s = sourceFromUrl(r.url);
    sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  }
  const sources = Object.entries(sourceCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const authorSql = `SELECT authored_by, COUNT(*) as cnt FROM links ${whereSql}${where.length ? " AND" : " WHERE"} authored_by <> '' AND authored_by IS NOT NULL GROUP BY authored_by ORDER BY cnt DESC`;
  const { rows: authorRows } = await pool.query(authorSql, params);

  return {
    total,
    total_mentions: Number(totalRow.mentions || 0),
    first_seen: totalRow.first_seen,
    last_seen: totalRow.last_seen,
    sources,
    sharers: (sharerRows as { shared_by: string; cnt: unknown }[]).map((r) => ({ name: r.shared_by, count: Number(r.cnt || 0) })),
    categories: (catRows as { category: string; cnt: unknown }[]).map((r) => ({ name: r.category || "uncategorized", count: Number(r.cnt || 0) })),
    authors: (authorRows as { authored_by: string; cnt: unknown }[]).map((r) => ({ name: r.authored_by, count: Number(r.cnt || 0) })),
  };
}

export async function getLinks(opts: {
  category?: string;
  days?: number;
  limit?: number;
  sort?: string;
  source?: string;
  sharedBy?: string;
  authoredBy?: string;
  pinned?: boolean;
}): Promise<LinkRow[]> {
  if (shouldUseSqliteAtlas()) {
    return getLinksFromSqlite(opts);
  }
  let pi = 1;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.category) {
    where.push(`category = $${pi++}`);
    params.push(opts.category);
  }
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push(`last_seen >= $${pi++}`);
    params.push(cutoff);
  }
  if (opts.source && opts.source !== "all") {
    const patterns: Record<string, string> = {
      github: "%github.com%",
      x: "%x.com%",
      youtube: "%youtu%",
      substack: "%substack.com%",
      medium: "%medium.com%",
      arxiv: "%arxiv.org%",
      reddit: "%reddit.com%",
      hackernews: "%news.ycombinator.com%",
      linkedin: "%linkedin.com%",
      notion: "%notion.so%",
      gdocs: "%docs.google.com%",
    };
    const pat = patterns[opts.source];
    if (pat) {
      where.push(`url LIKE $${pi++}`);
      params.push(pat);
    }
  }
  if (opts.sharedBy) {
    where.push(`shared_by LIKE $${pi++}`);
    params.push(`%${opts.sharedBy}%`);
  }
  if (opts.authoredBy === "any") {
    where.push("authored_by IS NOT NULL AND authored_by <> ''");
  } else if (opts.authoredBy) {
    where.push(`authored_by LIKE $${pi++}`);
    params.push(`%${opts.authoredBy}%`);
  }
  if (opts.pinned) {
    where.push("pinned = 1");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = SORT_MAP[opts.sort || "value"] || SORT_MAP.value;
  const limit = Math.min(Math.max(1, opts.limit || 50), 200);
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, url, url_hash, title, category, relevance, shared_by,
            source_group, first_seen, last_seen, mention_count, value_score,
            report_date, authored_by, pinned
     FROM links ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${pi++}`,
    params,
  );
  return rows as LinkRow[];
}

export async function searchLinksFts(
  query: string,
  opts: { category?: string; days?: number; limit?: number; sort?: string; source?: string; sharedBy?: string; authoredBy?: string }
): Promise<LinkRow[]> {
  const ftsQuery = buildLinksFtsQuery(query);
  const terms = normalizeLinkSearchTerms(query);
  if (!ftsQuery || !terms.length) return getLinks(opts);

  // Check if FTS table exists
  const { rows: ftsCheck } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = $1",
    ["links_fts"],
  );
  const ftsExists = ftsCheck.length > 0;

  if (ftsExists) {
    const matchScore = buildLinkTermMatchScore("l", terms, 1);
    let pi = matchScore.nextIndex;
    const where: string[] = [];
    const params: unknown[] = [...matchScore.params];
    const ftsTsvector = "to_tsvector('english', coalesce(l.title,'') || ' ' || coalesce(l.relevance,'') || ' ' || coalesce(l.category,'') || ' ' || coalesce(l.url,''))";
    const ftsQueryParam = `plainto_tsquery('english', $${pi++})`;
    params.push(ftsQuery);
    if (opts.category) {
      where.push(`l.category = $${pi++}`);
      params.push(opts.category);
    }
    if (opts.days) {
      const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
      where.push(`l.last_seen >= $${pi++}`);
      params.push(cutoff);
    }
    if (opts.source && opts.source !== "all") {
      const patterns: Record<string, string> = {
        github: "%github.com%", x: "%x.com%", youtube: "%youtu%",
        substack: "%substack.com%", medium: "%medium.com%", arxiv: "%arxiv.org%",
        reddit: "%reddit.com%", hackernews: "%news.ycombinator.com%",
        linkedin: "%linkedin.com%", notion: "%notion.so%", gdocs: "%docs.google.com%",
      };
      if (patterns[opts.source]) { where.push(`l.url LIKE $${pi++}`); params.push(patterns[opts.source]); }
    }
    if (opts.sharedBy) { where.push(`l.shared_by LIKE $${pi++}`); params.push(`%${opts.sharedBy}%`); }
    if (opts.authoredBy === "any") {
      where.push("l.authored_by IS NOT NULL AND l.authored_by <> ''");
    } else if (opts.authoredBy) {
      where.push(`l.authored_by LIKE $${pi++}`); params.push(`%${opts.authoredBy}%`);
    }
    const extraWhere = where.length ? `AND ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(1, opts.limit || 50), 200);
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT l.id, l.url, l.url_hash, l.title, l.category, l.relevance,
              l.shared_by, l.source_group, l.first_seen, l.last_seen,
              l.mention_count, l.value_score, l.report_date, l.authored_by, l.pinned,
              (${matchScore.sql}) AS term_match_score,
              ts_rank(${ftsTsvector}, ${ftsQueryParam}) AS rank
       FROM links l
       WHERE ${ftsTsvector} @@ ${ftsQueryParam}
       ${extraWhere}
       ORDER BY term_match_score DESC, rank DESC, l.value_score DESC
       LIMIT $${pi++}`,
      params,
    );
    return rows as LinkRow[];
  }

  // Fallback: LIKE-based search when FTS table hasn't been built yet
  let pi = 1;
  const where: string[] = [];
  const params: unknown[] = [];
  const likeClauses = terms.map(() => {
    const clause = `(title LIKE $${pi} OR relevance LIKE $${pi + 2} OR category LIKE $${pi + 1} OR url LIKE $${pi + 3})`;
    pi += 4;
    return clause;
  });
  pi = 1;
  where.push(`(${likeClauses.join(" OR ")})`);
  for (const t of terms) {
    const p = `%${t}%`;
    params.push(p, p, p, p);
    pi += 4;
  }
  if (opts.category) {
    where.push(`category = $${pi++}`);
    params.push(opts.category);
  }
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
    where.push(`last_seen >= $${pi++}`);
    params.push(cutoff);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const limit = Math.min(Math.max(1, opts.limit || 50), 200);
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, url, url_hash, title, category, relevance, shared_by,
            source_group, first_seen, last_seen, mention_count, value_score,
            report_date, authored_by, pinned
     FROM links ${whereSql}
     ORDER BY value_score DESC, last_seen DESC
     LIMIT $${pi++}`,
    params,
  );
  return rows as LinkRow[];
}

export async function searchLinks(opts: {
  query: string;
  category?: string;
  days?: number;
  limit?: number;
  sort?: string;
  source?: string;
  sharedBy?: string;
  authoredBy?: string;
  pinned?: boolean;
  semanticOnly?: boolean;
}): Promise<LinkRow[]> {
  const semanticRows = await searchHybridLinks({
    query: opts.query,
    category: opts.category,
    days: opts.days,
    limit: opts.limit,
    source: opts.source,
    sharedBy: opts.sharedBy,
    authoredBy: opts.authoredBy,
    pinned: opts.pinned,
  });
  if (semanticRows && semanticRows.length > 0) {
    return semanticRows;
  }
  if (opts.semanticOnly) {
    if (semanticRows === null) {
      throw new Error("semantic link retrieval is unavailable");
    }
    return [];
  }
  return searchLinksFts(opts.query, opts);
}

export interface WisdomTopic {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  message_count: number;
  contributor_count: number;
  last_active: string | null;
}

export interface WisdomItem {
  id: number;
  topic_id: number;
  knowledge_type: string;
  title: string;
  summary: string | null;
  source_links: string;
  source_messages: string;
  contributors: string;
  confidence: number;
}

export interface WisdomItemWithTopic extends WisdomItem {
  topic_name: string;
  topic_slug: string;
}

export interface WisdomTopicDetail extends WisdomTopic {
  items: WisdomItem[];
}

export interface WisdomRecommendation {
  id: number;
  from_topic_id: number;
  to_topic_id: number;
  strength: number;
  reason: string | null;
  topic_name: string;
  topic_slug: string;
}

export interface WisdomStats {
  total_topics: number;
  total_items: number;
  type_counts: { type: string; count: number }[];
  top_contributors: { name: string; count: number }[];
}

function getTopWisdomContributors(rows: { contributors: string }[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const contributor of new Set(parseJsonStringArray(row.contributors))) {
      counts.set(contributor, (counts.get(contributor) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 15);
}

export async function getWisdomTopics(): Promise<WisdomTopic[]> {
  const { rows } = await pool.query(
    `SELECT id, name, slug, summary, message_count, contributor_count, last_active
     FROM wisdom_topics
     ORDER BY message_count DESC, contributor_count DESC, name ASC`
  );
  return rows as WisdomTopic[];
}

export async function getWisdomItemsByType(knowledgeType?: string): Promise<Record<string, WisdomItemWithTopic[]>> {
  const normalizedType = knowledgeType?.trim();
  const where = normalizedType ? "WHERE wi.knowledge_type = $1" : "";
  const params = normalizedType ? [normalizedType] : [];
  const { rows } = await pool.query(
    `SELECT wi.*, wt.name AS topic_name, wt.slug AS topic_slug
     FROM wisdom_items wi
     JOIN wisdom_topics wt ON wi.topic_id = wt.id
     ${where}
     ORDER BY wi.confidence DESC, wi.id DESC`,
    params,
  );

  const grouped: Record<string, WisdomItemWithTopic[]> = {};
  for (const row of rows) {
    if (!grouped[row.knowledge_type]) grouped[row.knowledge_type] = [];
    grouped[row.knowledge_type].push(row);
  }
  return grouped;
}

export async function getWisdomItemsByTopic(topicSlug?: string): Promise<WisdomTopicDetail | WisdomTopic[] | null> {
  const normalizedSlug = topicSlug?.trim();
  if (!normalizedSlug) {
    const { rows } = await pool.query(
      `SELECT id, name, slug, summary, message_count, contributor_count, last_active
       FROM wisdom_topics
       ORDER BY message_count DESC, contributor_count DESC, name ASC`
    );
    return rows as WisdomTopic[];
  }

  const { rows: topicRows } = await pool.query(
    `SELECT id, name, slug, summary, message_count, contributor_count, last_active
     FROM wisdom_topics
     WHERE slug = $1`,
    [normalizedSlug],
  );
  const topic = topicRows[0] as WisdomTopic | undefined;
  if (!topic) {
    return null;
  }

  const { rows: items } = await pool.query(
    `SELECT id, topic_id, knowledge_type, title, summary, source_links, source_messages, contributors, confidence
     FROM wisdom_items
     WHERE topic_id = $1
     ORDER BY confidence DESC, id DESC`,
    [topic.id],
  );
  return { ...topic, items: items as WisdomItem[] };
}

export async function getWisdomRecommendations(topicId: number): Promise<WisdomRecommendation[]> {
  const { rows } = await pool.query(
    `SELECT wr.id, wr.from_topic_id, wr.to_topic_id, wr.strength, wr.reason,
            wt.name AS topic_name, wt.slug AS topic_slug
     FROM wisdom_recommendations wr
     JOIN wisdom_topics wt ON wt.id = CASE
       WHEN wr.from_topic_id = $1 THEN wr.to_topic_id
       ELSE wr.from_topic_id
     END
     WHERE wr.from_topic_id = $2 OR wr.to_topic_id = $3
     ORDER BY wr.strength DESC, wt.name ASC`,
    [topicId, topicId, topicId],
  );
  return rows as WisdomRecommendation[];
}

export async function getWisdomStats(): Promise<WisdomStats> {
  const { rows: tcRows } = await pool.query("SELECT COUNT(*) AS c FROM wisdom_topics");
  const total_topics = (tcRows[0] as { c: number }).c;
  const { rows: tiRows } = await pool.query("SELECT COUNT(*) AS c FROM wisdom_items");
  const total_items = (tiRows[0] as { c: number }).c;
  const { rows: typeCounts } = await pool.query(
    `SELECT knowledge_type AS type, COUNT(*) AS count
     FROM wisdom_items
     GROUP BY knowledge_type
     ORDER BY count DESC, type ASC`,
  );
  const { rows: contributorRows } = await pool.query(
    "SELECT contributors FROM wisdom_items WHERE contributors IS NOT NULL AND contributors <> ''",
  );
  return {
    total_topics,
    total_items,
    type_counts: typeCounts as { type: string; count: number }[],
    top_contributors: getTopWisdomContributors(contributorRows as { contributors: string }[]),
  };
}

export async function getMessagesByIds(
  ids: string[],
): Promise<{
  id: string;
  room_id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}[]> {
  if (ids.length === 0) return [];
  const userAliases = loadUserAliases();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await pool.query(
    `SELECT m.id, m.room_id, m.room_name, m.sender_name, m.body, m.timestamp, c.relevance_score
     FROM messages m
     LEFT JOIN classifications c ON c.message_id = m.id
     WHERE m.id IN (${placeholders})`,
    ids,
  );
  return (rows as {
    id: string;
    room_id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
  }[]).map((row) => ({
    ...row,
    sender_name: normalizeSenderName(row.sender_name, userAliases),
  }));
}

export async function getMessagesByParticipants(opts: {
  participantNames: string[];
  lookbackDays: number;
  limit: number;
  preferredRoom?: string;
}): Promise<{
  id: string;
  room_id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  entities: string | null;
  contribution_flag: number | null;
  contribution_themes: string | null;
  contribution_hint: string | null;
  alert_level: string | null;
}[]> {
  const { participantNames, lookbackDays, limit, preferredRoom } = opts;
  if (participantNames.length === 0) return [];

  const scope = await loadRoomScope(pool);
  const roomScope = buildRoomScopeWhere("m", scope, 1);
  const userAliases = loadUserAliases();
  const cutoffTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  let pi = roomScope.nextIndex;
  const whereParts = [`m.timestamp >= $${pi++}`];
  const params: unknown[] = [];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    params.push(...roomScope.params);
  }
  params.push(cutoffTs);

  whereParts.push(
    `LOWER(m.sender_name) IN (${participantNames.map(() => `$${pi++}`).join(", ")})`,
  );
  params.push(...participantNames.map((n) => n.toLowerCase()));

  if (preferredRoom) {
    whereParts.push(`LOWER(m.room_name) = $${pi++}`);
    params.push(preferredRoom.toLowerCase());
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT m.*, c.relevance_score, c.topics, c.entities,
            c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
     FROM messages m
     LEFT JOIN classifications c ON m.id = c.message_id
     WHERE ${whereParts.join(" AND ")}
     ORDER BY m.timestamp DESC
     LIMIT $${pi++}`,
    params,
  );

  return (rows as {
    id: string;
    room_id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    topics: string | null;
    entities: string | null;
    contribution_flag: number | null;
    contribution_themes: string | null;
    contribution_hint: string | null;
    alert_level: string | null;
  }[]).map((row) => ({
    ...row,
    sender_name: normalizeSenderName(row.sender_name, userAliases),
  }));
}
