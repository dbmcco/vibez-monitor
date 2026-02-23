import Database from "better-sqlite3";
import path from "path";

const DB_PATH =
  process.env.VIBEZ_DB_PATH || path.join(process.cwd(), "..", "vibez.db");

const DEFAULT_EXCLUDED_GROUPS = [
  "BBC News",
  "Bloomberg News",
  "MTB Rides",
  "Plum",
];

const DEFAULT_USER_ALIASES: Record<string, string> = {
  dbmcco: "Braydon",
};

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
  if (raw === undefined) return [...DEFAULT_EXCLUDED_GROUPS];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function loadRoomScope(db: Database.Database): RoomScope {
  const activeGroupsRow = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get("beeper_active_group_ids") as { value: string } | undefined;
  const activeGroupIds = parseJsonStringArray(activeGroupsRow?.value);
  const activeGroupNamesRow = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get("beeper_active_group_names") as { value: string } | undefined;
  const activeGroupNames = parseJsonStringArray(activeGroupNamesRow?.value);
  const excludedGroups = loadExcludedGroups();

  if (activeGroupIds.length > 0 || activeGroupNames.length > 0) {
    return { mode: "active_groups", activeGroupIds, activeGroupNames, excludedGroups };
  }
  if (excludedGroups.length > 0) {
    return { mode: "excluded_groups", activeGroupIds: [], activeGroupNames: [], excludedGroups };
  }
  return { mode: "all", activeGroupIds: [], activeGroupNames: [], excludedGroups: [] };
}

function buildRoomScopeWhere(alias: string, scope: RoomScope): {
  clause: string;
  params: string[];
} {
  if (scope.activeGroupIds.length > 0 || scope.activeGroupNames.length > 0) {
    const parts: string[] = [];
    const params: string[] = [];
    if (scope.activeGroupIds.length > 0) {
      parts.push(`${alias}.room_id IN (${scope.activeGroupIds.map(() => "?").join(", ")})`);
      params.push(...scope.activeGroupIds);
    }
    if (scope.activeGroupNames.length > 0) {
      parts.push(`${alias}.room_name IN (${scope.activeGroupNames.map(() => "?").join(", ")})`);
      params.push(...scope.activeGroupNames);
    }
    return {
      clause: `(${parts.join(" OR ")})`,
      params,
    };
  }
  if (scope.excludedGroups.length > 0) {
    return {
      clause: `${alias}.room_name NOT IN (${scope.excludedGroups.map(() => "?").join(", ")})`,
      params: scope.excludedGroups,
    };
  }
  return { clause: "", params: [] };
}

function loadUserAliases(): UserAliasMap {
  const aliases: UserAliasMap = {};
  for (const [raw, canonical] of Object.entries(DEFAULT_USER_ALIASES)) {
    aliases[raw.toLowerCase()] = canonical;
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

export function getDb() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
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
  stats: string | null;
  generated_at: string | null;
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

export function getMessages(opts: {
  limit?: number;
  offset?: number;
  room?: string;
  minRelevance?: number;
  contributionOnly?: boolean;
}): Message[] {
  const db = getDb();
  const scope = loadRoomScope(db);
  const roomScope = buildRoomScopeWhere("m", scope);
  const userAliases = loadUserAliases();
  let query = `
    SELECT m.*, c.relevance_score, c.topics, c.entities,
           c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
    FROM messages m
    LEFT JOIN classifications c ON m.id = c.message_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (roomScope.clause) {
    query += ` AND ${roomScope.clause}`;
    params.push(...roomScope.params);
  }
  if (opts.room) {
    query += " AND m.room_name = ?";
    params.push(opts.room);
  }
  if (opts.minRelevance) {
    query += " AND c.relevance_score >= ?";
    params.push(opts.minRelevance);
  }
  if (opts.contributionOnly) {
    query += " AND c.contribution_flag = 1";
  }

  query += " ORDER BY m.timestamp DESC LIMIT ? OFFSET ?";
  params.push(opts.limit || 50, opts.offset || 0);

  const rows = db.prepare(query).all(...params) as Message[];
  db.close();
  return rows.map((row) => ({
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
const BRAYDON_RE = /\b(braydon|dbmcco)\b/i;

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
  has_braydon_mention: boolean;
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

export function getContributionDashboard(
  opts: ContributionDashboardOpts = {},
): ContributionDashboard {
  const resolvedWindow = resolveWindowDays(opts.lookbackDays ?? 45) ?? 45;
  const limit = Math.max(50, Math.min(opts.limit ?? 600, 2000));
  const cutoffTs = Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;

  const db = getDb();
  const scope = loadRoomScope(db);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope);

  const whereParts = ["m.timestamp >= ?"];
  const whereParams: unknown[] = [cutoffTs];
  if (roomScope.clause) {
    whereParts.push(roomScope.clause);
    whereParams.push(...roomScope.params);
  }
  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  const rows = db
    .prepare(
      `SELECT m.id, m.room_name, m.sender_name, m.body, m.timestamp,
              c.relevance_score, c.topics, c.entities, c.contribution_flag,
              c.contribution_themes, c.contribution_hint, c.alert_level
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       ${whereClause}
       AND (c.contribution_flag = 1 OR c.alert_level = 'hot' OR (c.contribution_hint IS NOT NULL AND trim(c.contribution_hint) != ''))
       ORDER BY m.timestamp DESC
       LIMIT ?`
    )
    .all(...whereParams, limit) as ContributionRawRow[];

  const totalRow = db
    .prepare(`SELECT count(*) as count FROM messages m ${whereClause}`)
    .get(...whereParams) as { count: number } | undefined;

  const valueRows = db
    .prepare("SELECT key, value FROM value_config WHERE key IN ('topics', 'projects')")
    .all() as { key: string; value: string }[];
  db.close();

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

  const prepped: ContributionPrep[] = rows.map((row) => {
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
      has_braydon_mention: BRAYDON_RE.test(text),
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
        (item.has_braydon_mention ? 1 : 0),
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
      (item.has_braydon_mention ? 3 : 0) +
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
        (item.has_braydon_mention ? 2 : 0) +
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

export function getLatestReport(): DailyReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1")
    .get() as DailyReport | undefined;
  db.close();
  return row || null;
}

export function getReport(date: string): DailyReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM daily_reports WHERE report_date = ?")
    .get(date) as DailyReport | undefined;
  db.close();
  return row || null;
}

export function getRooms(): string[] {
  const db = getDb();
  const scope = loadRoomScope(db);
  const roomScope = buildRoomScopeWhere("m", scope);
  const rows = db
    .prepare(
      `SELECT DISTINCT m.room_name
       FROM messages m
       ${roomScope.clause ? `WHERE ${roomScope.clause}` : ""}
       ORDER BY m.room_name`
    )
    .all(...roomScope.params) as { room_name: string }[];
  db.close();
  return rows.map((r) => r.room_name);
}

export function getValueConfig(): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM value_config").all() as {
    key: string;
    value: string;
  }[];
  db.close();
  const config: Record<string, unknown> = {};
  for (const row of rows) {
    config[row.key] = JSON.parse(row.value);
  }
  return config;
}

export function searchMessages(opts: {
  query: string;
  lookbackDays?: number;
  limit?: number;
}): Message[] {
  const db = getDb();
  const scope = loadRoomScope(db);
  const roomScope = buildRoomScopeWhere("m", scope);
  const userAliases = loadUserAliases();
  const cutoffTs = Date.now() - (opts.lookbackDays || 7) * 24 * 60 * 60 * 1000;
  const keywords = opts.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const limit = opts.limit || 50;

  let rows: Message[];
  if (keywords.length === 0) {
    const whereParts = ["m.timestamp >= ?"];
    const params: unknown[] = [cutoffTs];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }
    rows = db
      .prepare(
        `SELECT m.*, c.relevance_score, c.topics, c.entities,
                c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         WHERE ${whereParts.join(" AND ")}
         ORDER BY c.relevance_score DESC
         LIMIT ?`
      )
      .all(...params, limit) as Message[];
  } else {
    const whereParts = ["m.timestamp >= ?"];
    const params: unknown[] = [cutoffTs];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }
    const keywordParts = keywords.slice(0, 5).map(() => "LOWER(m.body) LIKE ?");
    const keywordParams = keywords.slice(0, 5).map((kw) => `%${kw}%`);
    rows = db
      .prepare(
        `SELECT m.*, c.relevance_score, c.topics, c.entities,
                c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         WHERE ${whereParts.join(" AND ")} AND (${keywordParts.join(" OR ")})
         ORDER BY m.timestamp DESC
         LIMIT ?`
      )
      .all(...params, ...keywordParams, limit) as Message[];
  }
  db.close();
  return rows.map((row) => ({
    ...row,
    sender_name: normalizeSenderName(row.sender_name, userAliases),
  }));
}

export function getLatestBriefingMd(): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT briefing_md FROM daily_reports ORDER BY report_date DESC LIMIT 1")
    .get() as { briefing_md: string } | undefined;
  db.close();
  return row?.briefing_md || null;
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
  timeline: DailyCount[];
  coverage: {
    classified: DailyCount[];
    with_topics: DailyCount[];
    avg_topic_coverage: number;
  };
  users: RankedStat[];
  channels: RankedStat[];
  topics: TopicStat[];
  cooccurrence: TopicCooccurrence[];
  seasonality: SeasonalityStats;
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

function dateKeyFromTs(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

export function getStatsDashboard(windowDays: number | null = 90): StatsDashboard {
  const resolvedWindow = resolveWindowDays(windowDays);
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const db = getDb();
  const scope = loadRoomScope(db);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope);

  const scopedWhereParts: string[] = [];
  const scopedParams: unknown[] = [];
  if (roomScope.clause) {
    scopedWhereParts.push(roomScope.clause);
    scopedParams.push(...roomScope.params);
  }
  const scopedWhere = scopedWhereParts.length > 0 ? `WHERE ${scopedWhereParts.join(" AND ")}` : "";

  const windowWhereParts: string[] = [];
  const windowParams: unknown[] = [];
  if (cutoffTs !== null) {
    windowWhereParts.push("m.timestamp >= ?");
    windowParams.push(cutoffTs);
  }
  if (roomScope.clause) {
    windowWhereParts.push(roomScope.clause);
    windowParams.push(...roomScope.params);
  }
  const windowWhere = windowWhereParts.length > 0 ? `WHERE ${windowWhereParts.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT m.timestamp, m.sender_name, m.room_name, c.topics, c.relevance_score
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       ${windowWhere}
       ORDER BY m.timestamp ASC`
    )
    .all(...windowParams) as {
    timestamp: number;
    sender_name: string;
    room_name: string;
    topics: string | null;
    relevance_score: number | null;
  }[];

  const allTopicRows = db
    .prepare(
      `SELECT m.timestamp, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       ${scopedWhere ? `${scopedWhere} AND c.topics IS NOT NULL` : "WHERE c.topics IS NOT NULL"}`
    )
    .all(...scopedParams) as { timestamp: number; topics: string | null }[];
  db.close();

  const timelineDays =
    resolvedWindow === null
      ? rows.length > 0
        ? enumerateDaysFromTs(rows[0].timestamp, Date.now())
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

  let relevanceTotal = 0;
  let relevanceCount = 0;

  for (const row of allTopicRows) {
    const ts = row.timestamp;
    for (const topic of new Set(parseTopics(row.topics))) {
      const prev = topicFirstSeenEver.get(topic);
      if (prev === undefined || ts < prev) {
        topicFirstSeenEver.set(topic, ts);
      }
    }
  }

  for (const row of rows) {
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

    for (const topic of parsedTopics) {
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
    rows.length > 0
      ? Number((with_topics.reduce((sum, day) => sum + day.count, 0) / rows.length).toFixed(3))
      : 0;

  const userStats = Array.from(users.entries())
    .map(([name, acc]) => finalizeRanked(name, acc))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25);

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

  return {
    window_days: windowDaysValue,
    generated_at: new Date().toISOString(),
    scope: {
      mode: scope.mode,
      active_group_count: Math.max(scope.activeGroupIds.length, scope.activeGroupNames.length),
      excluded_groups: scope.excludedGroups,
    },
    totals: {
      messages: rows.length,
      users: users.size,
      channels: channels.size,
      topics: topics.size,
      avg_relevance:
        relevanceCount > 0
          ? Number((relevanceTotal / relevanceCount).toFixed(2))
          : null,
    },
    timeline,
    coverage: {
      classified,
      with_topics,
      avg_topic_coverage: avgTopicCoverage,
    },
    users: userStats,
    channels: channelStats,
    topics: topicStats,
    cooccurrence: cooccurrenceStats,
    seasonality,
  };
}

export function getTopicDrilldown(
  topicName: string,
  windowDays: number | null = 90,
): TopicDrilldown | null {
  const needle = topicName.trim().toLowerCase();
  if (!needle) return null;

  const resolvedWindow = resolveWindowDays(windowDays);
  const cutoffTs =
    resolvedWindow === null ? null : Date.now() - resolvedWindow * 24 * 60 * 60 * 1000;
  const db = getDb();
  const scope = loadRoomScope(db);
  const userAliases = loadUserAliases();
  const roomScope = buildRoomScopeWhere("m", scope);

  const windowWhereParts: string[] = ["c.topics IS NOT NULL"];
  const windowParams: unknown[] = [];
  if (cutoffTs !== null) {
    windowWhereParts.push("m.timestamp >= ?");
    windowParams.push(cutoffTs);
  }
  if (roomScope.clause) {
    windowWhereParts.push(roomScope.clause);
    windowParams.push(...roomScope.params);
  }

  const scopedWhereParts: string[] = ["c.topics IS NOT NULL"];
  const scopedParams: unknown[] = [];
  if (roomScope.clause) {
    scopedWhereParts.push(roomScope.clause);
    scopedParams.push(...roomScope.params);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.timestamp, m.room_name, m.sender_name, m.body, c.relevance_score, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${windowWhereParts.join(" AND ")}
       ORDER BY m.timestamp ASC`
    )
    .all(...windowParams) as {
    id: string;
    timestamp: number;
    room_name: string;
    sender_name: string;
    body: string;
    relevance_score: number | null;
    topics: string | null;
  }[];

  const allScopedRows = db
    .prepare(
      `SELECT m.timestamp, c.topics
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE ${scopedWhereParts.join(" AND ")}`
    )
    .all(...scopedParams) as { timestamp: number; topics: string | null }[];
  db.close();

  let canonicalTopic = topicName.trim();
  const topicRows = rows.filter((row) => {
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
    for (const topic of parseTopics(row.topics)) {
      if (topic.toLowerCase() === needle) {
        if (row.timestamp < firstSeenEverTs) firstSeenEverTs = row.timestamp;
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
  for (const row of rows) {
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
