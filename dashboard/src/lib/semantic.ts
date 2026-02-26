import { Pool } from "pg";

export interface SemanticRoomScope {
  mode: "active_groups" | "excluded_groups" | "all";
  activeGroupIds: string[];
  activeGroupNames: string[];
  excludedGroups: string[];
}

export interface SemanticMessageRow {
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

export interface SemanticThreadInput {
  key: string;
  text: string;
}

export interface SemanticThreadEvidence {
  message_ids: string[];
  sender_names: string[];
  newest_timestamp: number | null;
}

export interface SemanticNeighborhoodScore {
  related_messages: number;
  related_people: number;
}

export interface SemanticArcMessage {
  id: string;
  sender_name: string;
  room_name: string;
  body: string;
  timestamp: number;
}

export interface SemanticArc {
  id: string;
  title: string;
  message_count: number;
  people: number;
  channels: number;
  coherence: number;
  momentum: "rising" | "steady" | "cooling";
  first_seen: string;
  last_seen: string;
  top_people: string[];
  sample_messages: SemanticArcMessage[];
}

export interface SemanticTrendPoint {
  date: string;
  arc_count: number;
  covered_messages: number;
  avg_coherence: number;
  emerging_arcs: number;
}

export interface SemanticAnalytics {
  enabled: boolean;
  coverage_pct: number;
  orphan_pct: number;
  avg_coherence: number;
  drift_risk: "low" | "medium" | "high";
  checks: string[];
  arcs: SemanticArc[];
  trends: SemanticTrendPoint[];
}

let pool: Pool | null = null;

const TOKEN_RE = /[a-z0-9]{2,}/g;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const TITLE_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "around",
  "been",
  "being",
  "could",
  "from",
  "have",
  "just",
  "like",
  "more",
  "only",
  "over",
  "really",
  "some",
  "that",
  "them",
  "then",
  "there",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
  "into",
  "than",
  "were",
]);

function tableName(): string {
  const raw = (process.env.VIBEZ_PGVECTOR_TABLE || "vibez_message_embeddings")
    .trim()
    .toLowerCase();
  if (!IDENT_RE.test(raw)) {
    throw new Error(
      `Invalid VIBEZ_PGVECTOR_TABLE '${raw}'. Use lowercase letters, numbers, underscores.`,
    );
  }
  return raw;
}

function dimensions(): number {
  const value = Number.parseInt(process.env.VIBEZ_PGVECTOR_DIM || "256", 10);
  if (!Number.isFinite(value)) return 256;
  return Math.max(64, Math.min(value, 3072));
}

export function isPgvectorEnabled(): boolean {
  return Boolean(process.env.VIBEZ_PGVECTOR_URL?.trim());
}

function getPool(): Pool | null {
  const url = process.env.VIBEZ_PGVECTOR_URL?.trim();
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 6,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }
  return pool;
}

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  const bytes = Buffer.from(input, "utf8");
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function embedText(text: string, dims = 256): number[] {
  const vector = new Array<number>(dims).fill(0);
  const tokens = (text.toLowerCase().match(TOKEN_RE) || []).map((token) =>
    token.trim(),
  );
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const base = 1 / Math.max(1, Math.sqrt(token.length));
    const idxMain = fnv1a(token, 0x811c9dc5) % dims;
    const idxSide = fnv1a(token, 0x9e3779b1) % dims;
    vector[idxMain] += base;
    vector[idxSide] -= base * 0.35;

    if (token.length >= 5) {
      for (let i = 0; i < token.length - 2; i += 1) {
        const tri = token.slice(i, i + 3);
        const idxTri = fnv1a(tri, 0x85ebca6b) % dims;
        vector[idxTri] += 0.15;
      }
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) return vector;
  return vector.map((value) => value / norm);
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(",")}]`;
}

function pushScopeWhere(
  whereParts: string[],
  params: unknown[],
  scope: SemanticRoomScope,
): void {
  if (scope.mode === "active_groups") {
    const matchParts: string[] = [];
    if (scope.activeGroupIds.length > 0) {
      params.push(scope.activeGroupIds);
      matchParts.push(`m.room_id = ANY($${params.length}::text[])`);
    }
    if (scope.activeGroupNames.length > 0) {
      params.push(scope.activeGroupNames);
      matchParts.push(`m.room_name = ANY($${params.length}::text[])`);
    }
    if (matchParts.length > 0) {
      whereParts.push(`(${matchParts.join(" OR ")})`);
    }
    return;
  }
  if (scope.mode === "excluded_groups" && scope.excludedGroups.length > 0) {
    params.push(scope.excludedGroups);
    whereParts.push(`NOT (m.room_name = ANY($${params.length}::text[]))`);
  }
}

function parseMaybeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export async function searchHybridMessages(opts: {
  query: string;
  lookbackDays?: number;
  limit?: number;
  roomScope: SemanticRoomScope;
}): Promise<SemanticMessageRow[] | null> {
  const pg = getPool();
  if (!pg) return null;

  const lookbackDays = Math.max(1, Math.min(opts.lookbackDays || 7, 365));
  const limit = Math.max(1, Math.min(opts.limit || 50, 200));
  const cutoffTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const params: unknown[] = [cutoffTs];
  const whereParts: string[] = ["m.timestamp >= $1"];
  pushScopeWhere(whereParts, params, opts.roomScope);

  params.push(vectorLiteral(embedText(opts.query || "", dimensions())));
  const vectorParam = params.length;
  params.push((opts.query || "").trim());
  const queryParam = params.length;
  params.push(limit);
  const limitParam = params.length;

  const sql = `
WITH params AS (
  SELECT $${vectorParam}::vector AS qvec, NULLIF($${queryParam}, '') AS qtext
)
SELECT
  m.message_id AS id,
  m.room_id,
  m.room_name,
  m.sender_id,
  m.sender_name,
  m.body,
  m.timestamp,
  m.relevance_score,
  m.topics,
  m.entities,
  CASE WHEN m.contribution_flag THEN 1 ELSE 0 END AS contribution_flag,
  m.contribution_themes,
  m.contribution_hint,
  m.alert_level
FROM ${tableName()} m
CROSS JOIN params p
WHERE ${whereParts.join(" AND ")}
ORDER BY
  (0.65 * (1 - (m.embedding <=> p.qvec)))
  + (
      CASE
        WHEN p.qtext IS NULL THEN 0
        ELSE 0.25 * LEAST(2, ts_rank_cd(m.body_tsv, websearch_to_tsquery('english', p.qtext)))
      END
    )
  + (0.10 * (COALESCE(m.relevance_score, 0) / 10.0)) DESC,
  m.timestamp DESC
LIMIT $${limitParam}
`;

  try {
    const result = await pg.query(sql, params);
    return result.rows.map((row) => ({
      id: String(row.id),
      room_id: String(row.room_id || ""),
      room_name: String(row.room_name || "Unknown"),
      sender_id: String(row.sender_id || ""),
      sender_name: String(row.sender_name || "Unknown"),
      body: String(row.body || ""),
      timestamp: Number(row.timestamp || 0),
      relevance_score:
        row.relevance_score === null || row.relevance_score === undefined
          ? null
          : Number(row.relevance_score),
      topics: parseMaybeJson(row.topics),
      entities: parseMaybeJson(row.entities),
      contribution_flag:
        row.contribution_flag === null || row.contribution_flag === undefined
          ? null
          : Number(row.contribution_flag),
      contribution_themes: parseMaybeJson(row.contribution_themes),
      contribution_hint:
        row.contribution_hint === null || row.contribution_hint === undefined
          ? null
          : String(row.contribution_hint),
      alert_level:
        row.alert_level === null || row.alert_level === undefined
          ? null
          : String(row.alert_level),
    }));
  } catch (error) {
    console.warn("pgvector hybrid search unavailable, using SQLite fallback:", error);
    return null;
  }
}

export async function searchThreadEvidence(opts: {
  threads: SemanticThreadInput[];
  cutoffTs: number;
  perThreadLimit?: number;
  roomScope: SemanticRoomScope;
}): Promise<Map<string, SemanticThreadEvidence>> {
  const pg = getPool();
  if (!pg || opts.threads.length === 0) return new Map();

  const limit = Math.max(4, Math.min(opts.perThreadLimit || 24, 60));
  const dims = dimensions();
  const table = tableName();
  const results = new Map<string, SemanticThreadEvidence>();

  const settled = await Promise.allSettled(
    opts.threads.map(async (thread) => {
      const params: unknown[] = [opts.cutoffTs];
      const whereParts: string[] = ["m.timestamp >= $1"];
      pushScopeWhere(whereParts, params, opts.roomScope);
      params.push(vectorLiteral(embedText(thread.text, dims)));
      const vectorParam = params.length;
      params.push(limit);
      const limitParam = params.length;

      const sql = `
SELECT m.message_id, m.sender_name, m.timestamp
FROM ${table} m
WHERE ${whereParts.join(" AND ")}
ORDER BY m.embedding <=> $${vectorParam}::vector
LIMIT $${limitParam}
`;
      const query = await pg.query(sql, params);
      const messageIds = query.rows.map((row) => String(row.message_id));
      const senders = Array.from(
        new Set(query.rows.map((row) => String(row.sender_name || "Unknown"))),
      );
      const newestTs =
        query.rows.length > 0
          ? query.rows.reduce(
              (max, row) => Math.max(max, Number(row.timestamp || 0)),
              Number(query.rows[0].timestamp || 0),
            )
          : null;
      return [thread.key, { message_ids: messageIds, sender_names: senders, newest_timestamp: newestTs }] as const;
    }),
  );

  for (const item of settled) {
    if (item.status === "fulfilled") {
      results.set(item.value[0], item.value[1]);
    }
  }
  return results;
}

export async function scoreSemanticNeighborhood(opts: {
  messageIds: string[];
  cutoffTs: number;
  roomScope: SemanticRoomScope;
  neighborLimit?: number;
}): Promise<Map<string, SemanticNeighborhoodScore>> {
  const pg = getPool();
  if (!pg || opts.messageIds.length === 0) return new Map();

  const table = tableName();
  const messageIds = Array.from(new Set(opts.messageIds)).slice(0, 120);
  const neighborLimit = Math.max(4, Math.min(opts.neighborLimit || 16, 40));
  const params: unknown[] = [opts.cutoffTs, messageIds];
  const whereParts: string[] = ["m.timestamp >= $1"];
  pushScopeWhere(whereParts, params, opts.roomScope);
  params.push(neighborLimit);
  const limitParam = params.length;

  const sql = `
SELECT
  anchor.message_id AS anchor_id,
  cand.message_id AS related_id,
  cand.sender_name AS related_sender
FROM ${table} anchor
JOIN LATERAL (
  SELECT m.message_id, m.sender_name
  FROM ${table} m
  WHERE m.message_id <> anchor.message_id
    AND ${whereParts.join(" AND ")}
  ORDER BY m.embedding <=> anchor.embedding
  LIMIT $${limitParam}
) cand ON true
WHERE anchor.message_id = ANY($2::text[])
`;

  try {
    const query = await pg.query(sql, params);
    const relatedByAnchor = new Map<
      string,
      { messages: Set<string>; senders: Set<string> }
    >();
    for (const row of query.rows) {
      const anchorId = String(row.anchor_id);
      const record = relatedByAnchor.get(anchorId) || {
        messages: new Set<string>(),
        senders: new Set<string>(),
      };
      const relatedId = String(row.related_id || "");
      if (relatedId) record.messages.add(relatedId);
      const sender = String(row.related_sender || "Unknown");
      if (sender) record.senders.add(sender);
      relatedByAnchor.set(anchorId, record);
    }
    const output = new Map<string, SemanticNeighborhoodScore>();
    for (const [anchorId, record] of relatedByAnchor.entries()) {
      output.set(anchorId, {
        related_messages: record.messages.size,
        related_people: record.senders.size,
      });
    }
    return output;
  } catch (error) {
    console.warn("pgvector neighborhood scoring unavailable:", error);
    return new Map();
  }
}

interface SemanticCandidateRow {
  message_id: string;
  sender_name: string;
  room_name: string;
  body: string;
  timestamp: number;
  relevance_score: number;
}

interface SemanticNeighborRow {
  anchor_id: string;
  message_id: string;
  sender_name: string;
  room_name: string;
  body: string;
  timestamp: number;
  distance: number;
}

function toDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function enumerateDaysFromTs(startTs: number, endTs: number): string[] {
  const start = new Date(startTs);
  const end = new Date(endTs);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const days: string[] = [];
  while (cursor.getTime() <= last.getTime()) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const day = String(cursor.getDate()).padStart(2, "0");
    days.push(`${y}-${m}-${day}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function titleFromMessages(messages: SemanticArcMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const tokens = (message.body.toLowerCase().match(TOKEN_RE) || []).slice(0, 80);
    for (const token of tokens) {
      if (token.length < 4) continue;
      if (TITLE_STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 3)
    .map(([token]) => token);
  if (top.length >= 2) {
    return `${top[0]} / ${top[1]}`;
  }
  if (top.length === 1) {
    return top[0];
  }
  const fallback = messages[0]?.body?.trim() || "semantic thread";
  return fallback.slice(0, 44);
}

export async function computeSemanticAnalytics(opts: {
  roomScope: SemanticRoomScope;
  cutoffTs: number;
  lookbackDays: number;
  maxClusters?: number;
}): Promise<SemanticAnalytics | null> {
  const pg = getPool();
  if (!pg) return null;

  const table = tableName();
  const lookbackDays = Math.max(7, Math.min(opts.lookbackDays, 365));
  const cutoffTs = opts.cutoffTs;
  const maxClustersDisplay = Math.max(4, Math.min(opts.maxClusters || 12, 20));
  const clusterBuildLimit = Math.max(maxClustersDisplay * 10, 80);
  const candidateLimit = Math.max(1000, Math.min(lookbackDays * 110, 3600));
  const seedLimit = Math.max(180, Math.min(lookbackDays * 12, 900));
  const neighborLimit = 42;
  const distanceThreshold =
    lookbackDays <= 30 ? 0.29 : lookbackDays <= 90 ? 0.32 : 0.34;
  const minClusterSize = 3;

  const candidateParams: unknown[] = [cutoffTs];
  const candidateWhere = ["m.timestamp >= $1", "length(trim(m.body)) >= 24"];
  pushScopeWhere(candidateWhere, candidateParams, opts.roomScope);
  candidateParams.push(candidateLimit);
  const candidateLimitParam = candidateParams.length;
  const candidateSql = `
SELECT
  m.message_id,
  m.sender_name,
  m.room_name,
  m.body,
  m.timestamp,
  COALESCE(m.relevance_score, 0) AS relevance_score
FROM ${table} m
WHERE ${candidateWhere.join(" AND ")}
ORDER BY COALESCE(m.relevance_score, 0) DESC, m.timestamp DESC
LIMIT $${candidateLimitParam}
`;

  let candidateRows: SemanticCandidateRow[] = [];
  try {
    const result = await pg.query(candidateSql, candidateParams);
    candidateRows = result.rows.map((row) => ({
      message_id: String(row.message_id),
      sender_name: String(row.sender_name || "Unknown"),
      room_name: String(row.room_name || "Unknown"),
      body: String(row.body || ""),
      timestamp: Number(row.timestamp || 0),
      relevance_score: Number(row.relevance_score || 0),
    }));
  } catch (error) {
    console.warn("pgvector semantic candidate scan unavailable:", error);
    return null;
  }

  if (candidateRows.length === 0) {
    return {
      enabled: true,
      coverage_pct: 0,
      orphan_pct: 0,
      avg_coherence: 0,
      drift_risk: "low",
      checks: ["No semantic candidates in the selected window."],
      arcs: [],
      trends: [],
    };
  }

  const seedRows = candidateRows.slice(0, seedLimit);
  const seedIds = seedRows.map((row) => row.message_id);
  const candidateById = new Map(candidateRows.map((row) => [row.message_id, row]));

  const neighborParams: unknown[] = [cutoffTs, seedIds];
  const neighborWhere = ["m.timestamp >= $1"];
  pushScopeWhere(neighborWhere, neighborParams, opts.roomScope);
  neighborParams.push(neighborLimit);
  const neighborLimitParam = neighborParams.length;
  const neighborSql = `
WITH anchors AS (
  SELECT m.message_id, m.embedding
  FROM ${table} m
  WHERE m.message_id = ANY($2::text[])
)
SELECT
  a.message_id AS anchor_id,
  n.message_id,
  n.sender_name,
  n.room_name,
  n.body,
  n.timestamp,
  n.distance
FROM anchors a
JOIN LATERAL (
  SELECT
    m.message_id,
    m.sender_name,
    m.room_name,
    m.body,
    m.timestamp,
    (m.embedding <=> a.embedding) AS distance
  FROM ${table} m
  WHERE m.message_id <> a.message_id
    AND ${neighborWhere.join(" AND ")}
  ORDER BY m.embedding <=> a.embedding
  LIMIT $${neighborLimitParam}
) n ON true
`;

  let neighborRows: SemanticNeighborRow[] = [];
  try {
    const result = await pg.query(neighborSql, neighborParams);
    neighborRows = result.rows.map((row) => ({
      anchor_id: String(row.anchor_id),
      message_id: String(row.message_id),
      sender_name: String(row.sender_name || "Unknown"),
      room_name: String(row.room_name || "Unknown"),
      body: String(row.body || ""),
      timestamp: Number(row.timestamp || 0),
      distance: Number(row.distance || 1),
    }));
  } catch (error) {
    console.warn("pgvector semantic neighborhood scan unavailable:", error);
    return null;
  }

  const neighborsByAnchor = new Map<string, SemanticNeighborRow[]>();
  for (const row of neighborRows) {
    const items = neighborsByAnchor.get(row.anchor_id) || [];
    items.push(row);
    neighborsByAnchor.set(row.anchor_id, items);
  }
  for (const items of neighborsByAnchor.values()) {
    items.sort((a, b) => a.distance - b.distance);
  }

  const used = new Set<string>();
  const arcs: SemanticArc[] = [];
  const clusterDayMap = new Map<
    string,
    { arcIds: Set<string>; messages: number; coherenceTotal: number; coherenceCount: number; emerging: number }
  >();
  const nowTs = Date.now();

  for (const anchor of seedRows) {
    if (arcs.length >= clusterBuildLimit) break;
    if (used.has(anchor.message_id)) continue;
    const neighbors = neighborsByAnchor.get(anchor.message_id) || [];

    const members: Array<{ row: SemanticCandidateRow; distance: number }> = [
      { row: anchor, distance: 0 },
    ];
    const seen = new Set<string>([anchor.message_id]);

    for (const neighbor of neighbors) {
      if (neighbor.distance > distanceThreshold) break;
      if (seen.has(neighbor.message_id)) continue;
      const row = candidateById.get(neighbor.message_id) || {
        message_id: neighbor.message_id,
        sender_name: neighbor.sender_name,
        room_name: neighbor.room_name,
        body: neighbor.body,
        timestamp: neighbor.timestamp,
        relevance_score: 0,
      };
      if (used.has(row.message_id)) continue;
      members.push({ row, distance: neighbor.distance });
      seen.add(row.message_id);
    }

    if (members.length < minClusterSize) continue;
    for (const member of members) {
      used.add(member.row.message_id);
    }

    members.sort((a, b) => b.row.timestamp - a.row.timestamp);
    const messageRows: SemanticArcMessage[] = members.map((member) => ({
      id: member.row.message_id,
      sender_name: member.row.sender_name,
      room_name: member.row.room_name,
      body: member.row.body,
      timestamp: member.row.timestamp,
    }));
    const firstTs = members.reduce(
      (min, member) => Math.min(min, member.row.timestamp),
      members[0].row.timestamp,
    );
    const lastTs = members[0].row.timestamp;

    const peopleCounts = new Map<string, number>();
    const channelSet = new Set<string>();
    let coherence = 0;
    for (const member of members) {
      peopleCounts.set(
        member.row.sender_name,
        (peopleCounts.get(member.row.sender_name) || 0) + 1,
      );
      channelSet.add(member.row.room_name);
      coherence += Math.max(0, 1 - member.distance);
    }
    coherence = Number((coherence / members.length).toFixed(3));

    const recentCutoff = nowTs - 24 * 60 * 60 * 1000;
    const previousCutoff = nowTs - 48 * 60 * 60 * 1000;
    const last24 = members.filter((member) => member.row.timestamp >= recentCutoff).length;
    const prev24 = members.filter(
      (member) =>
        member.row.timestamp >= previousCutoff && member.row.timestamp < recentCutoff,
    ).length;
    let momentum: "rising" | "steady" | "cooling" = "steady";
    if (last24 >= prev24 + 2) momentum = "rising";
    else if (prev24 >= last24 + 2) momentum = "cooling";

    const arcId = `arc-${arcs.length + 1}`;
    const topPeople = Array.from(peopleCounts.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 4)
      .map(([name]) => name);

    const arc: SemanticArc = {
      id: arcId,
      title: titleFromMessages(messageRows),
      message_count: members.length,
      people: peopleCounts.size,
      channels: channelSet.size,
      coherence,
      momentum,
      first_seen: toDayKey(firstTs),
      last_seen: toDayKey(lastTs),
      top_people: topPeople,
      sample_messages: messageRows.slice(0, 4),
    };
    arcs.push(arc);

    for (const member of members) {
      const day = toDayKey(member.row.timestamp);
      const dayAcc = clusterDayMap.get(day) || {
        arcIds: new Set<string>(),
        messages: 0,
        coherenceTotal: 0,
        coherenceCount: 0,
        emerging: 0,
      };
      dayAcc.arcIds.add(arc.id);
      dayAcc.messages += 1;
      dayAcc.coherenceTotal += arc.coherence;
      dayAcc.coherenceCount += 1;
      clusterDayMap.set(day, dayAcc);
    }
    const firstDay = arc.first_seen;
    const firstDayAcc = clusterDayMap.get(firstDay) || {
      arcIds: new Set<string>(),
      messages: 0,
      coherenceTotal: 0,
      coherenceCount: 0,
      emerging: 0,
    };
    firstDayAcc.emerging += 1;
    clusterDayMap.set(firstDay, firstDayAcc);
  }

  arcs.sort((a, b) => {
    if (b.message_count !== a.message_count) return b.message_count - a.message_count;
    if (b.coherence !== a.coherence) return b.coherence - a.coherence;
    return b.last_seen.localeCompare(a.last_seen);
  });

  const coveredMessages = used.size;
  const coveragePct = Number(
    ((coveredMessages / Math.max(1, candidateRows.length)) * 100).toFixed(1),
  );
  const orphanPct = Number((100 - coveragePct).toFixed(1));
  const avgCoherence =
    arcs.length > 0
      ? Number(
          (
            arcs.reduce((sum, arc) => sum + arc.coherence, 0) / Math.max(1, arcs.length)
          ).toFixed(3),
        )
      : 0;
  let driftRisk: "low" | "medium" | "high" = "low";
  if (orphanPct >= 90 || avgCoherence < 0.42) driftRisk = "high";
  else if (orphanPct >= 75 || avgCoherence < 0.56) driftRisk = "medium";

  const checks: string[] = [];
  if (candidateRows.length < 120) {
    checks.push("Low semantic sample size in this window; treat arc trends as directional.");
  }
  if (orphanPct >= 78) {
    checks.push(
      "Many messages remain semantically unclustered. Consider classifier vocabulary updates or a wider retrieval radius.",
    );
  }
  if (avgCoherence < 0.55) {
    checks.push(
      "Average semantic coherence is soft; arcs may mix adjacent topics rather than single threads.",
    );
  }
  if (arcs.filter((arc) => arc.momentum === "rising").length === 0 && arcs.length > 0) {
    checks.push("No arcs are accelerating right now; most semantic threads are steady or cooling.");
  }
  if (checks.length === 0) {
    checks.push("Semantic clustering quality is stable for this window.");
  }

  const firstCandidateTs = candidateRows.reduce(
    (min, row) => Math.min(min, row.timestamp),
    candidateRows[0].timestamp,
  );
  const trendDays = enumerateDaysFromTs(firstCandidateTs, Date.now());
  const trends: SemanticTrendPoint[] = trendDays.map((day) => {
    const dayAcc = clusterDayMap.get(day);
    return {
      date: day,
      arc_count: dayAcc ? dayAcc.arcIds.size : 0,
      covered_messages: dayAcc ? dayAcc.messages : 0,
      avg_coherence:
        dayAcc && dayAcc.coherenceCount > 0
          ? Number((dayAcc.coherenceTotal / dayAcc.coherenceCount).toFixed(3))
          : 0,
      emerging_arcs: dayAcc ? dayAcc.emerging : 0,
    };
  });

  return {
    enabled: true,
    coverage_pct: coveragePct,
    orphan_pct: orphanPct,
    avg_coherence: avgCoherence,
    drift_risk: driftRisk,
    checks,
    arcs: arcs.slice(0, maxClustersDisplay),
    trends,
  };
}
