import Link from "next/link";
import {
  getCurrentRoomScope,
  getDb,
  getLatestReport,
  getPreviousReport,
  getRecentUpdateSnapshot,
  getReport,
  getVibezRadarSnapshot,
  type RecentUpdateSnapshot,
  type VibezRadarSnapshot,
} from "@/lib/db";
import {
  computeSemanticAnalytics,
  searchThreadEvidence,
  type SemanticAnalytics,
  type SemanticArc,
} from "@/lib/semantic";

interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface TrendData {
  emerging?: string[];
  fading?: string[];
  shifts?: string;
}

interface StoredConversationArc {
  title?: string;
  participants?: string[];
  core_exchange?: string;
  why_it_matters?: string;
  likely_next?: string;
  how_to_add_value?: string;
}

interface ConversationArcCard {
  title: string;
  participants: string[];
  coreExchange: string;
  whyItMatters: string;
  likelyNext: string;
  howToAddValue: string;
}

interface EvidenceCard {
  key: string;
  title: string;
  body: string;
  meta: string;
  tone: "neutral" | "info" | "warn";
}

type SearchParams = Record<string, string | string[] | undefined>;
type RoomScope = ReturnType<typeof getCurrentRoomScope>;

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "around",
  "being",
  "because",
  "between",
  "could",
  "daily",
  "from",
  "have",
  "into",
  "just",
  "more",
  "over",
  "their",
  "there",
  "these",
  "they",
  "this",
  "today",
  "using",
  "with",
]);

const SEMANTIC_LOOKBACK_DAYS = 14;
const SEMANTIC_LOOKBACK_MS = SEMANTIC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const EVIDENCE_MIN_BODY_LENGTH = 60;

interface ThreadEvidenceMessage {
  id: string;
  room_id?: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface FocusThreadRecord {
  key: string;
  thread: Thread;
  keywords: string[];
}

interface FocusThreadEvidence {
  key: string;
  thread: Thread;
  quotes: ThreadEvidenceMessage[];
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function excerpt(text: string, maxLength = 220): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function buildKeywords(values: string[]): string[] {
  return values
    .flatMap((value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/),
    )
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function keywordScore(text: string, keywords: string[]): number {
  const normalized = text.toLowerCase();
  return keywords.reduce((score, keyword) => (normalized.includes(keyword) ? score + 1 : score), 0);
}

function buildTrendKeywords(trendData: TrendData, threads: Thread[]): string[] {
  const values = [
    ...(trendData.emerging || []),
    ...(trendData.fading || []),
    trendData.shifts || "",
    ...threads.slice(0, 4).map((thread) => thread.title || ""),
  ].filter(Boolean);
  return Array.from(new Set(buildKeywords(values))).slice(0, 18);
}

function buildThreadKeywords(thread: Thread): string[] {
  return Array.from(
    new Set(buildKeywords([thread.title, thread.insights, ...thread.participants])),
  ).slice(0, 8);
}

function normalizeConversationArcs(
  storedArcs: StoredConversationArc[],
  threads: Thread[],
): ConversationArcCard[] {
  const normalizedStored = storedArcs
    .map((arc) => ({
      title: (arc.title || "Untitled conversation").trim(),
      participants: Array.isArray(arc.participants) ? arc.participants.slice(0, 5) : [],
      coreExchange: excerpt(arc.core_exchange || "", 180),
      whyItMatters: excerpt(arc.why_it_matters || "", 180),
      likelyNext: excerpt(arc.likely_next || "", 150),
      howToAddValue: excerpt(arc.how_to_add_value || "", 150),
    }))
    .filter(
      (arc) =>
        arc.title.length > 0 &&
        (arc.coreExchange.length > 0 ||
          arc.whyItMatters.length > 0 ||
          arc.howToAddValue.length > 0),
    );

  if (normalizedStored.length > 0) {
    return normalizedStored.slice(0, 4);
  }

  return threads.slice(0, 4).map((thread) => ({
    title: thread.title || "Untitled thread",
    participants: thread.participants.slice(0, 5),
    coreExchange: excerpt(thread.insights || "No detailed insight captured yet.", 180),
    whyItMatters:
      "This thread is part of the synthesis behind the trend summary and is shaping current community framing.",
    likelyNext: "Expect follow-up around implementation details, tool choices, or coordination.",
    howToAddValue: "Add a concrete example, implementation note, or decision-making constraint.",
  }));
}

function pickFocusThreads(threads: Thread[], keywords: string[]): Thread[] {
  return [...threads]
    .sort((a, b) => {
      const aScore = keywordScore(`${a.title} ${a.insights}`, keywords);
      const bScore = keywordScore(`${b.title} ${b.insights}`, keywords);
      if (bScore !== aScore) return bScore - aScore;
      return (b.insights || "").length - (a.insights || "").length;
    })
    .slice(0, 4);
}

function pickRelevantSemanticArcs(
  semanticBriefing: SemanticAnalytics | null,
  keywords: string[],
): SemanticArc[] {
  if (!semanticBriefing?.enabled) return [];
  return [...semanticBriefing.arcs]
    .sort((a, b) => {
      const aText = `${a.title} ${a.sample_messages.map((message) => message.body).join(" ")}`;
      const bText = `${b.title} ${b.sample_messages.map((message) => message.body).join(" ")}`;
      const aScore = keywordScore(aText, keywords);
      const bScore = keywordScore(bText, keywords);
      if (bScore !== aScore) return bScore - aScore;
      if (b.message_count !== a.message_count) return b.message_count - a.message_count;
      return b.coherence - a.coherence;
    })
    .slice(0, 4);
}

function buildEvidenceCards(
  recentUpdate: RecentUpdateSnapshot | null,
  radar: VibezRadarSnapshot | null,
  semanticArcs: SemanticArc[],
): EvidenceCard[] {
  const cards: EvidenceCard[] = [];

  for (const quote of recentUpdate?.quotes.slice(0, 3) || []) {
    cards.push({
      key: `recent-${quote.id}`,
      title: "Recent update quote",
      body: excerpt(quote.body, 220),
      meta: `${quote.sender_name} · ${quote.room_name}`,
      tone: "info",
    });
  }

  for (const gap of radar?.gaps.slice(0, 2) || []) {
    if (!gap.sample_quote) continue;
    cards.push({
      key: `gap-${gap.topic}-${gap.sample_quote.id}`,
      title: `Coverage gap: ${gap.topic}`,
      body: excerpt(gap.sample_quote.body, 220),
      meta: `${gap.sample_quote.sender_name} · ${gap.sample_quote.room_name}`,
      tone: "warn",
    });
  }

  for (const arc of semanticArcs.slice(0, 2)) {
    const sample = arc.sample_messages[0];
    if (!sample) continue;
    cards.push({
      key: `semantic-${arc.id}-${sample.id}`,
      title: `Semantic arc: ${arc.title}`,
      body: excerpt(sample.body, 220),
      meta: `${sample.sender_name} · ${sample.room_name}`,
      tone: "neutral",
    });
  }

  const seenBodies = new Set<string>();
  return cards.filter((card) => {
    const key = card.body.toLowerCase();
    if (seenBodies.has(key)) return false;
    seenBodies.add(key);
    return true;
  });
}

function toneClass(tone: EvidenceCard["tone"]): string {
  if (tone === "warn") return "border-rose-500/25 bg-rose-500/6";
  if (tone === "info") return "border-cyan-400/25 bg-cyan-400/8";
  return "border-slate-700/70 bg-slate-900/45";
}

function metricValue(value: number | null | undefined, suffix = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Unavailable";
  return `${value}${suffix}`;
}

function comparisonText(previous: TrendData, previousDate: string | null): string {
  if (!previousDate) return "No prior briefing is available for comparison.";
  const parts = [
    previous.shifts || "",
    previous.emerging?.length ? `Emerging then: ${previous.emerging.join(", ")}` : "",
    previous.fading?.length ? `Cooling then: ${previous.fading.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(". ")
    .trim();
  if (!parts) {
    return `Prior briefing exists for ${previousDate}, but it did not include a structured trend summary.`;
  }
  return `Compared with ${previousDate}: ${parts}`;
}

function resolveDateParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  return undefined;
}

function semanticCutoffTs(reportDate: string): number {
  const endOfReportDay = Date.parse(`${reportDate}T23:59:59`);
  if (Number.isFinite(endOfReportDay)) {
    return endOfReportDay - SEMANTIC_LOOKBACK_MS;
  }
  return 0;
}

function formatTs(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return "";
  }
}

function buildRoomScopeWhere(scope: RoomScope, alias: string): { clause: string; params: string[] } {
  if (scope.activeGroupIds.length > 0 || scope.activeGroupNames.length > 0) {
    const parts: string[] = [];
    const params: string[] = [];
    if (scope.activeGroupIds.length > 0) {
      parts.push(`${alias}.room_id IN (${scope.activeGroupIds.map(() => "?").join(", ")})`);
      params.push(...scope.activeGroupIds);
    }
    if (scope.activeGroupNames.length > 0) {
      parts.push(`LOWER(${alias}.room_name) IN (${scope.activeGroupNames.map(() => "?").join(", ")})`);
      params.push(...scope.activeGroupNames.map((name) => name.toLowerCase()));
    }
    return {
      clause: `(${parts.join(" OR ")})`,
      params,
    };
  }
  if (scope.excludedGroups.length > 0) {
    return {
      clause: `LOWER(${alias}.room_name) NOT IN (${scope.excludedGroups.map(() => "?").join(", ")})`,
      params: scope.excludedGroups,
    };
  }
  return { clause: "", params: [] };
}

function loadMessagesByIds(ids: string[]): Map<string, ThreadEvidenceMessage> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT m.id, m.room_id, m.room_name, m.sender_name, m.body, m.timestamp, c.relevance_score
         FROM messages m
         LEFT JOIN classifications c ON c.message_id = m.id
         WHERE m.id IN (${placeholders})`,
      )
      .all(...ids) as ThreadEvidenceMessage[];
    return new Map(rows.map((row) => [row.id, row]));
  } finally {
    db.close();
  }
}

function scoreThreadEvidence(
  message: ThreadEvidenceMessage,
  record: FocusThreadRecord,
): number {
  const text = `${message.body} ${message.room_name} ${message.sender_name}`.toLowerCase();
  const keywordHits = record.keywords.reduce(
    (score, keyword) => (text.includes(keyword) ? score + 1 : score),
    0,
  );
  const participantHits = record.thread.participants.reduce((score, participant) => {
    const normalized = participant.trim().toLowerCase();
    if (!normalized) return score;
    return text.includes(normalized) ? score + 2 : score;
  }, 0);
  const relevance = message.relevance_score ?? 0;
  return keywordHits * 2 + participantHits + relevance;
}

function selectEvidenceQuotes(
  candidates: ThreadEvidenceMessage[],
  record: FocusThreadRecord,
): ThreadEvidenceMessage[] {
  const seen = new Set<string>();
  return [...candidates]
    .filter((message) => (message.body || "").trim().length >= EVIDENCE_MIN_BODY_LENGTH)
    .map((message) => ({
      message,
      score: scoreThreadEvidence(message, record),
    }))
    .filter(({ score, message }) => score >= 3 || (message.relevance_score ?? 0) >= 7)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.message.timestamp - a.message.timestamp;
    })
    .map(({ message }) => message)
    .filter((message) => {
      const fingerprint = message.body.trim().toLowerCase();
      if (!fingerprint || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    })
    .slice(0, 3);
}

function findKeywordEvidence(
  record: FocusThreadRecord,
  cutoffTs: number,
  scope: RoomScope,
): ThreadEvidenceMessage[] {
  if (record.keywords.length === 0) return [];

  const db = getDb();
  try {
    const roomScope = buildRoomScopeWhere(scope, "m");
    const whereParts = ["m.timestamp >= ?"];
    const params: unknown[] = [cutoffTs];
    if (roomScope.clause) {
      whereParts.push(roomScope.clause);
      params.push(...roomScope.params);
    }

    const keywordParts = record.keywords
      .slice(0, 6)
      .map(
        () =>
          "(LOWER(m.body) LIKE ? OR LOWER(COALESCE(c.topics, '')) LIKE ? OR LOWER(COALESCE(c.entities, '')) LIKE ?)",
      );
    for (const keyword of record.keywords.slice(0, 6)) {
      const likeValue = `%${keyword}%`;
      params.push(likeValue, likeValue, likeValue);
    }
    params.push(160);

    const rows = db
      .prepare(
        `SELECT m.id, m.room_id, m.room_name, m.sender_name, m.body, m.timestamp, c.relevance_score
         FROM messages m
         LEFT JOIN classifications c ON c.message_id = m.id
         WHERE ${whereParts.join(" AND ")} AND (${keywordParts.join(" OR ")})
         ORDER BY COALESCE(c.relevance_score, 0) DESC, m.timestamp DESC
         LIMIT ?`,
      )
      .all(...params) as ThreadEvidenceMessage[];

    return selectEvidenceQuotes(rows, record);
  } finally {
    db.close();
  }
}

async function buildFocusThreadEvidence(
  focusThreads: Thread[],
  reportDate: string,
): Promise<FocusThreadEvidence[]> {
  const scope = getCurrentRoomScope();
  const cutoffTs = semanticCutoffTs(reportDate);
  const records: FocusThreadRecord[] = focusThreads.map((thread, index) => ({
    key: `thread-${index}`,
    thread,
    keywords: buildThreadKeywords(thread),
  }));

  const semanticMatches = await searchThreadEvidence({
    threads: records.map((record) => ({
      key: record.key,
      text: `${record.thread.title}. ${record.thread.insights}`,
    })),
    cutoffTs,
    perThreadLimit: 12,
    roomScope: scope,
  });
  const semanticIds = Array.from(
    new Set(
      Array.from(semanticMatches.values()).flatMap((result) => result.message_ids),
    ),
  );
  const messagesById = loadMessagesByIds(semanticIds);

  return records.map((record) => {
    const semanticQuotes =
      semanticMatches
        .get(record.key)
        ?.message_ids.map((id) => messagesById.get(id))
        .filter((message): message is ThreadEvidenceMessage => Boolean(message)) || [];
    const keywordQuotes = findKeywordEvidence(record, cutoffTs, scope);
    const quotes = selectEvidenceQuotes([...semanticQuotes, ...keywordQuotes], record);
    return {
      key: record.key,
      thread: record.thread,
      quotes,
    };
  });
}

export default async function TrendCoveragePage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const resolvedSearchParams = (searchParams ? await searchParams : {}) as SearchParams;
  const date = resolveDateParam(resolvedSearchParams.date);
  const report = date ? getReport(date) : getLatestReport();
  const latestReport = date ? getLatestReport() : report;
  const isLatestReport = Boolean(latestReport && report && latestReport.report_date === report.report_date);
  const previousReport = report ? getPreviousReport(report.report_date) : null;
  const recentUpdate = isLatestReport ? getRecentUpdateSnapshot() : null;
  const radar = await getVibezRadarSnapshot(report, 48);
  const semanticBriefing =
    isLatestReport && report
      ? await computeSemanticAnalytics({
          roomScope: getCurrentRoomScope(),
          cutoffTs: semanticCutoffTs(report.report_date),
          lookbackDays: SEMANTIC_LOOKBACK_DAYS,
          maxClusters: 8,
        })
      : null;

  if (!report) {
    return (
      <section className="vibe-panel rounded-xl p-6">
        <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
          Trend Coverage
        </p>
        <h1 className="vibe-title mt-2 text-2xl text-slate-100">No report available</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          The trend coverage page needs a generated briefing report first. Once the daily synthesis
          has run, this page will unpack the trend narrative in more depth.
        </p>
        <Link
          href="/briefing"
          className="mt-5 inline-flex items-center rounded-md border border-cyan-400/35 bg-cyan-400/10 px-3 py-2 text-sm font-medium text-cyan-100 transition hover:border-cyan-300/55 hover:bg-cyan-400/15"
        >
          Back to briefing
        </Link>
      </section>
    );
  }

  const threads = parseJson<Thread[]>(report.briefing_json, []);
  const trendData = parseJson<TrendData>(report.trends, {});
  const previousTrendData = parseJson<TrendData>(previousReport?.trends, {});
  const storedConversationArcs = parseJson<StoredConversationArc[]>(report.conversation_arcs, []);
  const conversationArcs = normalizeConversationArcs(storedConversationArcs, threads);
  const trendKeywords = buildTrendKeywords(trendData, threads);
  const focusThreads = pickFocusThreads(threads, trendKeywords);
  const focusThreadEvidence = await buildFocusThreadEvidence(focusThreads, report.report_date);
  const semanticArcs = pickRelevantSemanticArcs(semanticBriefing, trendKeywords);
  const evidenceCards = buildEvidenceCards(recentUpdate, radar, semanticArcs);
  const comparison = comparisonText(previousTrendData, previousReport?.report_date || null);
  const hasTrendNarrative =
    Boolean(trendData.shifts) ||
    Boolean(trendData.emerging?.length) ||
    Boolean(trendData.fading?.length);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Link
          href="/briefing"
          className="inline-flex items-center rounded-md border border-slate-700/80 bg-slate-900/55 px-3 py-1.5 text-sm text-slate-200 transition hover:border-slate-500/80 hover:text-slate-100"
        >
          Back to briefing
        </Link>
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
            Trend Coverage
          </p>
          <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
            Deeper read of the trend summary <span className="text-cyan-200/90">— {report.report_date}</span>
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-slate-300">
            This page expands the briefing trend paragraph into the supporting signals: what is
            rising, what is cooling, which conversation arcs are carrying it, and how complete the
            current coverage looks.
          </p>
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[1.25fr_0.95fr]">
        <article className="vibe-panel rounded-xl p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-cyan-400/35 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200">
              Trend narrative
            </span>
            {previousReport?.report_date && (
              <span className="rounded border border-slate-700/70 bg-slate-900/55 px-2 py-0.5 text-xs text-slate-300">
                Baseline: {previousReport.report_date}
              </span>
            )}
          </div>
          <p className="mt-3 text-base leading-relaxed text-slate-100 sm:text-lg">
            {hasTrendNarrative
              ? trendData.shifts || "Structured trend bullets are available below even though the narrative paragraph is empty."
              : "No structured trend narrative is available for this report yet."}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">{comparison}</p>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/7 p-3">
              <p className="text-xs font-semibold tracking-wide text-emerald-300 uppercase">
                Emerging
              </p>
              <p className="mt-2 text-sm leading-relaxed text-emerald-100">
                {trendData.emerging?.length
                  ? trendData.emerging.join(", ")
                  : "No emerging themes were called out in this run."}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Cooling / fading
              </p>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">
                {trendData.fading?.length
                  ? trendData.fading.join(", ")
                  : "No fading themes were called out in this run."}
              </p>
            </div>
          </div>
        </article>

        <article className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title text-lg text-slate-100">Coverage at a glance</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Emerging themes</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {trendData.emerging?.length || 0}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Conversation arcs</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">{conversationArcs.length}</p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Radar topic coverage</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {metricValue(radar?.coverage.topic_coverage_pct, "%")}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Semantic coverage</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {semanticBriefing?.enabled
                  ? `${semanticBriefing.coverage_pct.toFixed(1)}%`
                  : "Unavailable"}
              </p>
            </div>
          </div>

          {recentUpdate && (
            <div className="mt-4 rounded-lg border border-cyan-400/18 bg-cyan-400/6 p-3">
              <p className="text-xs font-semibold tracking-wide text-cyan-200 uppercase">
                Latest activity window
              </p>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">{recentUpdate.summary}</p>
              <p className="mt-2 text-xs text-slate-400">
                {recentUpdate.message_count} messages · {recentUpdate.active_users} people ·{" "}
                {recentUpdate.active_channels} channels · {recentUpdate.window_label}
              </p>
            </div>
          )}
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title text-lg text-slate-100">Conversation arcs behind the trend</h2>
          {conversationArcs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No conversation arcs were stored for this report.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {conversationArcs.map((arc, index) => (
                <article
                  key={`${arc.title}-${index}`}
                  className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-4"
                >
                  <p className="text-sm font-semibold text-slate-100">{arc.title}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {arc.participants.join(", ") || "Participants not listed"}
                  </p>
                  <div className="mt-3 space-y-2 text-sm text-slate-300">
                    <p>
                      <span className="text-slate-500">Core exchange:</span> {arc.coreExchange}
                    </p>
                    <p>
                      <span className="text-slate-500">Why it matters:</span> {arc.whyItMatters}
                    </p>
                    <p>
                      <span className="text-slate-500">Likely next:</span> {arc.likelyNext}
                    </p>
                    <p className="text-emerald-200/95">
                      <span className="text-emerald-300/80">How you can add value:</span>{" "}
                      {arc.howToAddValue}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>

        <article className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title text-lg text-slate-100">Source evidence by thread</h2>
          {focusThreadEvidence.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No structured briefing threads are available for this report.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {focusThreadEvidence.map(({ key, thread, quotes }) => (
                <article
                  key={key}
                  className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-100">{thread.title}</p>
                    <span className="rounded border border-slate-700/70 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
                      {thread.participants.length} participants
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{thread.insights}</p>
                  {quotes.length > 0 ? (
                    <div className="mt-4 space-y-3">
                      {quotes.map((quote) => (
                        <article
                          key={quote.id}
                          className="rounded-lg border border-cyan-400/18 bg-cyan-400/6 p-3"
                        >
                          <p className="text-sm leading-relaxed text-slate-100">
                            “{excerpt(quote.body, 220)}”
                          </p>
                          <p className="mt-2 text-xs text-slate-400">
                            {quote.sender_name} · {quote.room_name}
                            {quote.timestamp ? ` · ${formatTs(quote.timestamp)}` : ""}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-4 text-sm text-slate-400">
                      No grounded quotes were recovered for this thread yet.
                    </p>
                  )}
                  {thread.links?.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {thread.links.slice(0, 4).map((link) => (
                        <a
                          key={link}
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded border border-cyan-400/25 bg-cyan-400/8 px-2 py-0.5 text-xs text-cyan-100"
                        >
                          Source link
                        </a>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <article className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title text-lg text-slate-100">Supporting evidence</h2>
          {evidenceCards.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              No evidence quotes are available yet from recent updates, radar gaps, or semantic arcs.
            </p>
          ) : (
            <div className="mt-4 grid gap-3">
              {evidenceCards.map((card) => (
                <article key={card.key} className={`rounded-lg border p-4 ${toneClass(card.tone)}`}>
                  <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                    {card.title}
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-100">“{card.body}”</p>
                  <p className="mt-2 text-xs text-slate-400">{card.meta}</p>
                </article>
              ))}
            </div>
          )}
        </article>

        <article className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title text-lg text-slate-100">Diagnostics and adjacent signals</h2>

          {recentUpdate?.top_topics?.length ? (
            <div className="mt-4">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Top topics in the latest window
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {recentUpdate.top_topics.slice(0, 6).map((topic) => (
                  <span
                    key={topic.topic}
                    className="rounded border border-cyan-400/25 bg-cyan-400/8 px-2 py-0.5 text-xs text-cyan-100"
                  >
                    {topic.topic} · {topic.count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {recentUpdate?.top_channels?.length ? (
            <div className="mt-4">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Most active channels
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {recentUpdate.top_channels.slice(0, 6).map((channel) => (
                  <span
                    key={channel.name}
                    className="rounded border border-slate-700/70 bg-slate-900/45 px-2 py-0.5 text-xs text-slate-200"
                  >
                    {channel.name} · {channel.count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {radar?.gaps?.length ? (
            <div className="mt-4">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Coverage gaps flagged by radar
              </p>
              <div className="mt-3 space-y-3">
                {radar.gaps.slice(0, 3).map((gap) => (
                  <article
                    key={`${gap.topic}-${gap.last_seen}`}
                    className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-100">{gap.topic}</p>
                      <span className="rounded border border-rose-300/35 bg-rose-300/10 px-2 py-0.5 text-xs text-rose-200">
                        {gap.message_count} msgs
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">{gap.reason}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {semanticArcs.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Relevant semantic arcs
              </p>
              <div className="mt-3 space-y-3">
                {semanticArcs.map((arc) => (
                  <article
                    key={arc.id}
                    className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-100">{arc.title}</p>
                      <span className="rounded border border-slate-700/70 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
                        {arc.momentum}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      {arc.message_count} msgs · {arc.people} people · {(arc.coherence * 100).toFixed(0)}%
                      {" "}coherence
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">
                      {arc.sample_messages[0]
                        ? excerpt(arc.sample_messages[0].body, 160)
                        : "No sample message stored."}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {semanticBriefing?.checks?.length ? (
            <div className="mt-4 rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Semantic checks
              </p>
              <ul className="mt-2 space-y-2 text-sm text-slate-300">
                {semanticBriefing.checks.slice(0, 4).map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </article>
      </section>
    </div>
  );
}
