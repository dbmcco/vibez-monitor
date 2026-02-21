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

interface RoomScope {
  mode: "active_groups" | "excluded_groups" | "all";
  activeGroupIds: string[];
  excludedGroups: string[];
}

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
  const excludedGroups = loadExcludedGroups();

  if (activeGroupIds.length > 0) {
    return { mode: "active_groups", activeGroupIds, excludedGroups };
  }
  if (excludedGroups.length > 0) {
    return { mode: "excluded_groups", activeGroupIds: [], excludedGroups };
  }
  return { mode: "all", activeGroupIds: [], excludedGroups: [] };
}

function buildRoomScopeWhere(alias: string, scope: RoomScope): {
  clause: string;
  params: string[];
} {
  if (scope.activeGroupIds.length > 0) {
    return {
      clause: `${alias}.room_id IN (${scope.activeGroupIds.map(() => "?").join(", ")})`,
      params: scope.activeGroupIds,
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

export function getMessages(opts: {
  limit?: number;
  offset?: number;
  room?: string;
  minRelevance?: number;
  contributionOnly?: boolean;
}): Message[] {
  const db = getDb();
  let query = `
    SELECT m.*, c.relevance_score, c.topics, c.entities,
           c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
    FROM messages m
    LEFT JOIN classifications c ON m.id = c.message_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

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
  return rows;
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
  const cutoffTs = Date.now() - (opts.lookbackDays || 7) * 24 * 60 * 60 * 1000;
  const keywords = opts.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const limit = opts.limit || 50;

  let rows: Message[];
  if (keywords.length === 0) {
    rows = db
      .prepare(
        `SELECT m.*, c.relevance_score, c.topics, c.entities,
                c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         WHERE m.timestamp >= ?
         ORDER BY c.relevance_score DESC
         LIMIT ?`
      )
      .all(cutoffTs, limit) as Message[];
  } else {
    const whereParts = keywords.slice(0, 5).map(() => "LOWER(m.body) LIKE ?");
    const params = keywords.slice(0, 5).map((kw) => `%${kw}%`);
    rows = db
      .prepare(
        `SELECT m.*, c.relevance_score, c.topics, c.entities,
                c.contribution_flag, c.contribution_themes, c.contribution_hint, c.alert_level
         FROM messages m
         LEFT JOIN classifications c ON m.id = c.message_id
         WHERE m.timestamp >= ? AND (${whereParts.join(" OR ")})
         ORDER BY m.timestamp DESC
         LIMIT ?`
      )
      .all(cutoffTs, ...params, limit) as Message[];
  }
  db.close();
  return rows;
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
  users: RankedStat[];
  channels: RankedStat[];
  topics: TopicStat[];
  cooccurrence: TopicCooccurrence[];
  seasonality: SeasonalityStats;
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

export function getStatsDashboard(windowDays: number = 90): StatsDashboard {
  const safeWindow = Math.max(7, Math.min(windowDays, 365));
  const cutoffTs = Date.now() - safeWindow * 24 * 60 * 60 * 1000;
  const db = getDb();
  const scope = loadRoomScope(db);
  const roomScope = buildRoomScopeWhere("m", scope);

  const rows = db
    .prepare(
      `SELECT m.timestamp, m.sender_name, m.room_name, c.topics, c.relevance_score
       FROM messages m
       LEFT JOIN classifications c ON m.id = c.message_id
       WHERE m.timestamp >= ?
       ${roomScope.clause ? `AND ${roomScope.clause}` : ""}
       ORDER BY m.timestamp ASC`
    )
    .all(cutoffTs, ...roomScope.params) as {
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
       WHERE c.topics IS NOT NULL
       ${roomScope.clause ? `AND ${roomScope.clause}` : ""}`
    )
    .all(...roomScope.params) as { timestamp: number; topics: string | null }[];
  db.close();

  const timelineDays = enumerateDays(safeWindow);
  const timelineMap = new Map<string, number>(timelineDays.map((d) => [d, 0]));
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
    const d = new Date(ts);
    weekdayCounts[d.getDay()] += 1;
    hourCounts[d.getHours()] += 1;

    if (row.relevance_score !== null && row.relevance_score !== undefined) {
      relevanceTotal += row.relevance_score;
      relevanceCount += 1;
    }

    const sender = row.sender_name || "Unknown";
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

    for (const topic of parseTopics(row.topics)) {
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

    const messageTopics = Array.from(new Set(parseTopics(row.topics))).sort((a, b) =>
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
    window_days: safeWindow,
    generated_at: new Date().toISOString(),
    scope: {
      mode: scope.mode,
      active_group_count: scope.activeGroupIds.length,
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
    users: userStats,
    channels: channelStats,
    topics: topicStats,
    cooccurrence: cooccurrenceStats,
    seasonality,
  };
}
