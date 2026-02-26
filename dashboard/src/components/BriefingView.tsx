"use client";

import { useMemo, useState } from "react";

interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface Contribution {
  theme: string;
  type: string;
  freshness: string;
  threads: string[];
  why: string;
  action: string;
  channel?: string;
  reply_to?: string;
  draft_message?: string;
  message_count: number;
}

interface TrendData {
  emerging?: string[];
  fading?: string[];
  shifts?: string;
}

interface EvidenceMessage {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface RecentUpdateQuote {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface RecentUpdateTopic {
  topic: string;
  count: number;
}

interface RecentUpdateChannel {
  name: string;
  count: number;
}

interface RecentUpdateSnapshot {
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

interface VibezRadarGapQuote {
  id: string;
  timestamp: number;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
}

interface VibezRadarGap {
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

interface VibezRadarRedundancy {
  type: "thread_overlap" | "message_duplication";
  score_pct: number;
  title: string;
  detail: string;
}

interface VibezRadarThreadQuality {
  thread_title: string;
  evidence_messages: number;
  evidence_people: number;
  newest_evidence: string | null;
  quality: "strong" | "mixed" | "thin";
  notes: string[];
}

interface VibezRadarSnapshot {
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

interface SemanticArcMessage {
  id: string;
  sender_name: string;
  room_name: string;
  body: string;
  timestamp: number;
}

interface SemanticArc {
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

interface SemanticBriefing {
  enabled: boolean;
  coverage_pct: number;
  orphan_pct: number;
  avg_coherence: number;
  drift_risk: "low" | "medium" | "high";
  checks: string[];
  arcs: SemanticArc[];
}

interface StoredConversationArc {
  title?: string;
  participants?: string[];
  core_exchange?: string;
  why_it_matters?: string;
  likely_next?: string;
  how_to_add_value?: string;
}

interface Props {
  briefing_json: string | null;
  contributions_json?: string | null;
  trends: string | null;
  daily_memo?: string | null;
  conversation_arcs_json?: string | null;
  previous_report_date?: string | null;
  previous_daily_memo?: string | null;
  previous_briefing_json?: string | null;
  previous_trends?: string | null;
  report_date: string;
  evidence_messages?: EvidenceMessage[];
  recent_update?: RecentUpdateSnapshot | null;
  radar?: VibezRadarSnapshot | null;
  semantic_briefing?: SemanticBriefing | null;
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "agent",
  "agents",
  "around",
  "being",
  "because",
  "between",
  "could",
  "daily",
  "from",
  "have",
  "house",
  "into",
  "just",
  "more",
  "over",
  "their",
  "there",
  "these",
  "they",
  "this",
  "thread",
  "today",
  "using",
  "with",
]);

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function freshnessBadge(freshness: string): { color: string; label: string } {
  switch (freshness.toLowerCase()) {
    case "hot":
      return { color: "badge-hot", label: "hot" };
    case "warm":
      return { color: "badge-warm", label: "warm" };
    case "cool":
      return { color: "badge-cool", label: "cool" };
    default:
      return { color: "badge-archive", label: freshness || "archive" };
  }
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
  return matches ? matches : [];
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function excerpt(text: string, maxLength = 260): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatTs(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function buildExecutiveTakeaways(threads: Thread[], trendData: TrendData): string[] {
  const takeaways: string[] = [];
  if (trendData.shifts) takeaways.push(trendData.shifts);
  if (trendData.emerging && trendData.emerging.length > 0) {
    takeaways.push(
      `Emerging: ${trendData.emerging
        .slice(0, 3)
        .map((item) => item.replace(/\.\.\.$/, ""))
        .join(", ")}.`,
    );
  }
  for (const thread of threads.slice(0, 3)) {
    const participants = thread.participants.slice(0, 4).join(", ");
    takeaways.push(
      `${thread.title}: ${thread.insights} ${participants ? `(Participants: ${participants})` : ""}`,
    );
  }
  if (takeaways.length === 0) {
    takeaways.push("No structured executive data is available for this reporting window.");
  }
  return takeaways.map((item) => item.trim());
}

function pickEvidenceQuotes(messages: EvidenceMessage[], threads: Thread[]): EvidenceMessage[] {
  const keywordSet = new Set<string>(
    threads
      .flatMap((thread) => [thread.title, thread.insights].flatMap(extractKeywords))
      .slice(0, 180),
  );
  const senderCounts = new Map<string, number>();
  const now = Date.now();
  return [...messages]
    .filter((message) => {
      if (!message?.body) return false;
      const sender = (message.sender_name || "").toLowerCase();
      if (sender.includes("whatsappbot")) return false;
      const text = message.body.trim();
      if (text.length < 80) return false;
      if (/^https?:\/\//i.test(text)) return false;
      return true;
    })
    .map((message) => {
      const text = message.body.toLowerCase();
      const keywordHits = Array.from(keywordSet).reduce(
        (sum, token) => (text.includes(token) ? sum + 1 : sum),
        0,
      );
      const recencyHours = Math.max(0, (now - Number(message.timestamp || now)) / 36e5);
      const recencyBonus = Math.max(0, 24 - recencyHours) * 0.12;
      const relevance = message.relevance_score ?? 0;
      const score = relevance * 2 + keywordHits * 0.9 + recencyBonus;
      return { message, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ message }) => {
      const sender = message.sender_name || "Unknown";
      const count = senderCounts.get(sender) || 0;
      if (count >= 2) return false;
      senderCounts.set(sender, count + 1);
      return true;
    })
    .slice(0, 6)
    .map((entry) => entry.message);
}

function collectReferences(threads: Thread[], quotes: EvidenceMessage[]): string[] {
  const links: string[] = [];
  for (const thread of threads) {
    links.push(...thread.links);
  }
  for (const quote of quotes) {
    links.push(...extractUrls(quote.body));
  }
  const deduped = Array.from(new Set(links.map((link) => link.trim()).filter(Boolean)));
  return deduped.slice(0, 14);
}

function qualityBadge(quality: "strong" | "mixed" | "thin"): string {
  if (quality === "strong") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
  if (quality === "mixed") return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  return "border-rose-400/40 bg-rose-400/10 text-rose-200";
}

function semanticRiskBadge(risk: "low" | "medium" | "high"): string {
  if (risk === "high") return "border-rose-400/40 bg-rose-400/10 text-rose-200";
  if (risk === "medium") return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
}

type BriefingTab = "snapshot" | "daily" | "evidence" | "radar";

type AtGlanceSignal = "new" | "continuing" | "fresh-window" | "baseline";

interface SnapshotAtGlanceItem {
  title: string;
  detail: string;
  freshness: string;
  signal: AtGlanceSignal;
}

interface SnapshotConversationArc {
  title: string;
  participants: string[];
  coreExchange: string;
  whyItMatters: string;
  likelyNext: string;
  howToAddValue: string;
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findContributionForThread(thread: Thread, contributions: Contribution[]): Contribution | null {
  const titleText = normalizeMatchText(thread.title);
  if (!titleText) return null;

  for (const contribution of contributions) {
    const threadRefs = contribution.threads || [];
    for (const ref of threadRefs) {
      const refText = normalizeMatchText(ref);
      if (!refText) continue;
      if (titleText.includes(refText) || refText.includes(titleText)) {
        return contribution;
      }
    }
  }
  return null;
}

function buildConversationArcs(
  threads: Thread[],
  contributions: Contribution[],
): SnapshotConversationArc[] {
  return threads.slice(0, 3).map((thread) => {
    const linkedContribution = findContributionForThread(thread, contributions);
    const participants = thread.participants.slice(0, 5);
    const themeLabel = linkedContribution?.theme
      ? linkedContribution.theme.replace(/-/g, " ")
      : "this discussion";

    return {
      title: thread.title || "Untitled thread",
      participants,
      coreExchange: excerpt(thread.insights || "No detailed insight provided yet.", 170),
      whyItMatters:
        linkedContribution?.why ||
        `This thread is shaping how people are framing ${themeLabel}, which can influence follow-up work.`,
      likelyNext: `Expect follow-up around ${themeLabel} and practical execution details.`,
      howToAddValue:
        linkedContribution?.action ||
        "Add one concrete example or implementation detail from your current projects.",
    };
  });
}

function normalizeStoredConversationArcs(
  arcs: StoredConversationArc[],
): SnapshotConversationArc[] {
  return arcs
    .map((arc) => ({
      title: (arc.title || "Untitled conversation").trim(),
      participants: Array.isArray(arc.participants) ? arc.participants.slice(0, 5) : [],
      coreExchange: excerpt(arc.core_exchange || "", 170),
      whyItMatters: excerpt(arc.why_it_matters || "", 170),
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
}

function freshnessRank(freshness: string): number {
  const value = freshness.toLowerCase();
  if (value === "hot") return 4;
  if (value === "warm") return 3;
  if (value === "cool") return 2;
  if (value === "archive") return 1;
  return 0;
}

function selectSnapshotMoves(contributions: Contribution[]): Contribution[] {
  return [...contributions]
    .sort((a, b) => {
      const freshnessDelta = freshnessRank(b.freshness) - freshnessRank(a.freshness);
      if (freshnessDelta !== 0) return freshnessDelta;
      return (b.message_count || 0) - (a.message_count || 0);
    })
    .slice(0, 3);
}

function toKeywordSet(text: string): Set<string> {
  return new Set(extractKeywords(text));
}

function overlapRatio(source: Set<string>, target: Set<string>): number {
  if (source.size === 0 || target.size === 0) return 0;
  let overlap = 0;
  for (const token of source) {
    if (target.has(token)) overlap += 1;
  }
  return overlap / source.size;
}

function overlapCount(source: Set<string>, target: Set<string>): number {
  if (source.size === 0 || target.size === 0) return 0;
  let overlap = 0;
  for (const token of source) {
    if (target.has(token)) overlap += 1;
  }
  return overlap;
}

function classifySignalNovelty(currentText: string, previousText: string): AtGlanceSignal {
  const current = toKeywordSet(currentText);
  const previous = toKeywordSet(previousText);
  if (current.size === 0 || previous.size === 0) return "baseline";
  const sharedTokens = overlapCount(current, previous);
  if (sharedTokens >= 6) return "continuing";
  const ratio = overlapRatio(current, previous);
  if (ratio >= 0.25) return "continuing";
  return "new";
}

function signalBadge(signal: AtGlanceSignal): { label: string; className: string } {
  if (signal === "new") {
    return {
      label: "New",
      className: "border-emerald-400/35 bg-emerald-400/10 text-emerald-200",
    };
  }
  if (signal === "continuing") {
    return {
      label: "Continuing",
      className: "border-amber-400/35 bg-amber-400/10 text-amber-200",
    };
  }
  if (signal === "fresh-window") {
    return {
      label: "Fresh Window",
      className: "border-cyan-400/35 bg-cyan-400/10 text-cyan-200",
    };
  }
  return {
    label: "No Baseline",
    className: "border-slate-500/40 bg-slate-700/20 text-slate-300",
  };
}

function buildAtGlanceItems(
  recentUpdate: RecentUpdateSnapshot | null,
  trendData: TrendData,
  threads: Thread[],
  dailyMemo: string,
  previousReportDate: string | null,
  previousDailyMemo: string,
  previousThreads: Thread[],
  previousTrendData: TrendData,
): SnapshotAtGlanceItem[] {
  const items: SnapshotAtGlanceItem[] = [];

  if (recentUpdate) {
    const topTopics = recentUpdate.top_topics.slice(0, 2).map((topic) => topic.topic);
    const topChannels = recentUpdate.top_channels.slice(0, 2).map((channel) => channel.name);
    const topicPart =
      topTopics.length > 0 ? ` Main topics: ${topTopics.join(", ")}.` : "";
    const channelPart =
      topChannels.length > 0 ? ` Most active channels: ${topChannels.join(", ")}.` : "";
    items.push({
      title: "Live Activity Pulse",
      detail: `${recentUpdate.message_count} messages from ${recentUpdate.active_users} people across ${recentUpdate.active_channels} channels.${topicPart}${channelPart}`,
      freshness: `${recentUpdate.window_label} · next refresh ${recentUpdate.next_refresh_label}`,
      signal: "fresh-window",
    });
  }

  const fallbackNarrative = threads
    .slice(0, 2)
    .map((thread) => `${thread.title}: ${thread.insights}`)
    .join(" ");
  const narrativeText = (dailyMemo || fallbackNarrative).trim();
  if (narrativeText) {
    const previousNarrativeText = [
      previousDailyMemo,
      previousThreads
        .slice(0, 2)
        .map((thread) => `${thread.title}: ${thread.insights}`)
        .join(" "),
    ]
      .join(" ")
      .trim();
    items.push({
      title: "Daily Narrative",
      detail: excerpt(narrativeText, 210),
      freshness: `24h synthesis (${report_dateLabel(previousReportDate, dailyMemo)})`,
      signal: classifySignalNovelty(narrativeText, previousNarrativeText),
    });
  }

  const trendText = [
    trendData.shifts || "",
    trendData.emerging?.length ? `Emerging: ${trendData.emerging.slice(0, 3).join(", ")}` : "",
    trendData.fading?.length ? `Fading: ${trendData.fading.slice(0, 2).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(". ")
    .trim();
  if (trendText) {
    const previousTrendText = [
      previousTrendData.shifts || "",
      previousTrendData.emerging?.join(", ") || "",
      previousTrendData.fading?.join(", ") || "",
    ]
      .filter(Boolean)
      .join(". ")
      .trim();
    items.push({
      title: "Trend Movement",
      detail: excerpt(trendText, 210),
      freshness:
        previousReportDate
          ? `Compared against ${previousReportDate}`
          : "No prior trend baseline",
      signal: classifySignalNovelty(trendText, previousTrendText),
    });
  }

  if (items.length === 0) {
    items.push({
      title: "No Snapshot Data",
      detail: "No high-signal summary is available yet for this reporting window.",
      freshness: "Awaiting next refresh",
      signal: "baseline",
    });
  }

  return items.slice(0, 3);
}

function report_dateLabel(previousReportDate: string | null, dailyMemo: string): string {
  if (!dailyMemo) return "thread-derived narrative";
  if (!previousReportDate) return "no prior memo";
  return `vs ${previousReportDate}`;
}

export function BriefingView({
  briefing_json,
  contributions_json,
  trends,
  daily_memo = null,
  conversation_arcs_json = null,
  previous_report_date = null,
  previous_daily_memo = null,
  previous_briefing_json = null,
  previous_trends = null,
  report_date,
  evidence_messages = [],
  recent_update = null,
  radar = null,
  semantic_briefing = null,
}: Props) {
  const threads = parseJson<Thread[]>(briefing_json, []);
  const contributions = parseJson<Contribution[]>(contributions_json, []);
  const previousThreads = parseJson<Thread[]>(previous_briefing_json, []);
  const storedConversationArcs = useMemo(() => {
    const parsed = parseJson<unknown>(conversation_arcs_json, []);
    return Array.isArray(parsed) ? (parsed as StoredConversationArc[]) : [];
  }, [conversation_arcs_json]);
  const trendData = parseJson<TrendData>(trends, {});
  const previousTrendData = parseJson<TrendData>(previous_trends, {});
  const resolvedDailyMemo = (daily_memo || "").trim();
  const resolvedPreviousDailyMemo = (previous_daily_memo || "").trim();
  const [activeTab, setActiveTab] = useState<BriefingTab>("snapshot");
  const [showAllContributions, setShowAllContributions] = useState(false);
  const [expandedThreadKey, setExpandedThreadKey] = useState<string | null>(null);

  const executiveTakeaways = useMemo(
    () => buildExecutiveTakeaways(threads, trendData),
    [threads, trendData],
  );
  const evidenceQuotes = useMemo(
    () => pickEvidenceQuotes(evidence_messages, threads),
    [evidence_messages, threads],
  );
  const references = useMemo(
    () => collectReferences(threads, evidenceQuotes),
    [threads, evidenceQuotes],
  );
  const inferredConversationArcs = useMemo(
    () => buildConversationArcs(threads, contributions),
    [threads, contributions],
  );
  const conversationArcs = useMemo(() => {
    const normalized = normalizeStoredConversationArcs(storedConversationArcs);
    if (normalized.length > 0) return normalized.slice(0, 3);
    return inferredConversationArcs;
  }, [storedConversationArcs, inferredConversationArcs]);
  const snapshotMoves = useMemo(
    () => selectSnapshotMoves(contributions),
    [contributions],
  );
  const atGlanceItems = useMemo(
    () =>
      buildAtGlanceItems(
        recent_update,
        trendData,
        threads,
        resolvedDailyMemo,
        previous_report_date,
        resolvedPreviousDailyMemo,
        previousThreads,
        previousTrendData,
      ),
    [
      recent_update,
      trendData,
      threads,
      resolvedDailyMemo,
      previous_report_date,
      resolvedPreviousDailyMemo,
      previousThreads,
      previousTrendData,
    ],
  );
  const visibleContributions = showAllContributions
    ? contributions
    : contributions.slice(0, 3);
  const tabs: Array<{ key: BriefingTab; label: string; detail: string }> = [
    { key: "snapshot", label: "Snapshot", detail: "60-90 second overview" },
    { key: "daily", label: "Daily Briefing", detail: "Full narrative and action queue" },
    { key: "evidence", label: "Evidence", detail: "Quotes, links, and source traces" },
    { key: "radar", label: "Radar", detail: "Coverage and quality diagnostics" },
  ];

  return (
    <div className="space-y-8">
      <header className="fade-up space-y-2">
        <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
          Executive Briefing
        </p>
        <h2 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          AGI Community Pulse <span className="text-cyan-200/90">— {report_date}</span>
        </h2>
        <p className="vibe-subtitle max-w-3xl">
          Fast narrative overview first, then deeper detail only when you need it.
        </p>
      </header>

      <section className="vibe-panel fade-up rounded-xl p-4">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`rounded border px-3 py-1.5 text-sm ${
                activeTab === tab.key
                  ? "border-cyan-300/70 bg-cyan-400/15 text-cyan-100"
                  : "border-slate-700/80 bg-slate-900/45 text-slate-300 hover:border-slate-500/90"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-400">
          {tabs.find((tab) => tab.key === activeTab)?.detail}
        </p>
      </section>

      {activeTab === "radar" && recent_update && (
        <section className="vibe-panel fade-up rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="vibe-title text-lg text-slate-100">Recent Update</h3>
            <span className="vibe-chip rounded px-2 py-0.5 text-xs">
              Refresh: {recent_update.refresh_cadence} (local)
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-200">{recent_update.summary}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Messages</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {recent_update.message_count}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">People</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {recent_update.active_users}
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Channels</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {recent_update.active_channels}
              </p>
            </div>
          </div>
          {recent_update.top_topics.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {recent_update.top_topics.slice(0, 6).map((topic) => (
                <span
                  key={topic.topic}
                  className="rounded border border-cyan-400/35 bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200"
                >
                  {topic.topic} · {topic.count}
                </span>
              ))}
            </div>
          )}
          {recent_update.quotes.length > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {recent_update.quotes.map((quote) => (
                <article
                  key={quote.id}
                  className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
                >
                  <p className="text-sm leading-relaxed text-slate-100">“{excerpt(quote.body, 170)}”</p>
                  <p className="mt-2 text-xs text-slate-400">
                    {quote.sender_name} · {quote.room_name}
                  </p>
                </article>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Window: {recent_update.window_label} · Next refresh: {recent_update.next_refresh_label}
          </p>
        </section>
      )}

      {activeTab === "radar" && radar && (
        <section className="vibe-panel fade-up rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="vibe-title text-lg text-slate-100">Vibez Radar</h3>
            <span className="vibe-chip rounded px-2 py-0.5 text-xs">
              Last {radar.window_hours}h quality scan
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-200">
            Coverage check across {radar.totals.messages} messages from {radar.totals.people} people:
            {" "}
            {radar.coverage.topic_coverage_pct}% of topical volume is represented in current briefing
            priorities.
          </p>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Topic Coverage</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {radar.coverage.topic_coverage_pct}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Classification Coverage</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {radar.coverage.classification_coverage_pct}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Duplicate Pressure</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {radar.coverage.duplicate_pressure_pct}%
              </p>
            </div>
          </div>

          {radar.gaps.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Coverage Gaps
              </p>
              {radar.gaps.slice(0, 4).map((gap) => (
                <article
                  key={`${gap.topic}-${gap.last_seen}`}
                  className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-100">{gap.topic}</p>
                    <span className="rounded border border-rose-300/35 bg-rose-300/10 px-2 py-0.5 text-xs text-rose-200">
                      {gap.message_count} msgs
                    </span>
                    <span className="text-xs text-slate-400">
                      {gap.people} people · {gap.channels} channels
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{gap.reason}</p>
                  {gap.sample_quote && (
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">
                      “{excerpt(gap.sample_quote.body, 180)}” — {gap.sample_quote.sender_name} ·{" "}
                      {gap.sample_quote.room_name}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}

          {radar.redundancies.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Redundancy Flags
              </p>
              {radar.redundancies.slice(0, 3).map((item) => (
                <article
                  key={`${item.type}-${item.title}`}
                  className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-slate-100">{item.title}</p>
                    <span className="rounded border border-amber-300/35 bg-amber-300/10 px-2 py-0.5 text-xs text-amber-200">
                      {item.score_pct}%
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-300">{item.detail}</p>
                </article>
              ))}
            </div>
          )}

          {radar.thread_quality.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Thread Evidence Quality
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {radar.thread_quality.slice(0, 6).map((thread) => (
                  <article
                    key={thread.thread_title}
                    className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-100">{thread.thread_title}</p>
                      <span className={`rounded border px-2 py-0.5 text-xs ${qualityBadge(thread.quality)}`}>
                        {thread.quality}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      {thread.evidence_messages} evidence msgs · {thread.evidence_people} people
                      {thread.newest_evidence ? ` · Latest: ${thread.newest_evidence}` : ""}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-slate-300">
                      {thread.notes.join(" ")}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "radar" && semantic_briefing?.enabled && (
        <section className="vibe-panel fade-up rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="vibe-title text-lg text-slate-100">Semantic Arc Intelligence</h3>
            <span
              className={`rounded border px-2 py-0.5 text-xs uppercase tracking-wide ${semanticRiskBadge(
                semantic_briefing.drift_risk,
              )}`}
            >
              Drift {semantic_briefing.drift_risk}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Embedding-based cluster view of recent conversations to catch arcs that topic tags miss.
          </p>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Semantic Coverage</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {semantic_briefing.coverage_pct.toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Unclustered</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {semantic_briefing.orphan_pct.toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs text-slate-400">Avg Coherence</p>
              <p className="mt-1 text-xl font-semibold text-slate-100">
                {(semantic_briefing.avg_coherence * 100).toFixed(1)}%
              </p>
            </div>
          </div>

          {semantic_briefing.checks.length > 0 && (
            <div className="mt-4 rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Semantic Checks
              </p>
              <ul className="mt-2 space-y-1 text-sm text-slate-300">
                {semantic_briefing.checks.slice(0, 3).map((check, index) => (
                  <li key={`${check}-${index}`} className="list-disc pl-1">
                    {check}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {semantic_briefing.arcs.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Top Semantic Arcs
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {semantic_briefing.arcs.slice(0, 6).map((arc) => (
                  <article
                    key={arc.id}
                    className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-100">{arc.title}</p>
                      <span
                        className={`rounded border px-2 py-0.5 text-xs ${
                          arc.momentum === "rising"
                            ? "border-rose-400/35 bg-rose-400/10 text-rose-200"
                            : arc.momentum === "cooling"
                              ? "border-slate-500/35 bg-slate-700/20 text-slate-300"
                              : "border-cyan-400/35 bg-cyan-400/10 text-cyan-200"
                        }`}
                      >
                        {arc.momentum}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      {arc.message_count} msgs · {arc.people} people · {arc.channels} channels ·
                      coherence {(arc.coherence * 100).toFixed(0)}%
                    </p>
                    <p className="mt-2 text-xs text-slate-300">
                      {arc.top_people.slice(0, 4).join(", ")}
                    </p>
                    {arc.sample_messages[0] && (
                      <p className="mt-2 text-xs leading-relaxed text-slate-400">
                        “{excerpt(arc.sample_messages[0].body, 160)}”
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "snapshot" && (
        <>
          <section className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Today at a Glance</h3>
              <div className="mt-3 space-y-3">
                {atGlanceItems.map((item, index) => {
                  const signal = signalBadge(item.signal);
                  return (
                    <article
                      key={`${item.title}-${index}`}
                      className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-slate-100">{item.title}</p>
                        <span className={`rounded border px-2 py-0.5 text-xs ${signal.className}`}>
                          {signal.label}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-slate-200">{item.detail}</p>
                      <p className="mt-2 text-xs text-slate-400">{item.freshness}</p>
                    </article>
                  );
                })}
                {atGlanceItems.length === 0 && (
                  <p className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3 text-sm text-slate-300">
                    Snapshot data is still loading.
                  </p>
                )}
              </div>
            </article>
            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Quick Scope</h3>
              <div className="mt-3 grid gap-3">
                <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-400">Conversation Arcs</p>
                  <p className="mt-1 text-xl font-semibold text-slate-100">
                    {conversationArcs.length}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-400">Contribution Moves</p>
                  <p className="mt-1 text-xl font-semibold text-slate-100">
                    {snapshotMoves.length}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
                  <p className="text-xs text-slate-400">Current Top Trends</p>
                  <p className="mt-1 text-xl font-semibold text-slate-100">
                    {Math.max(trendData.emerging?.length || 0, trendData.fading?.length || 0)}
                  </p>
                </div>
                {semantic_briefing?.enabled && (
                  <div className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3">
                    <p className="text-xs text-slate-400">Semantic Arcs (14d)</p>
                    <p className="mt-1 text-xl font-semibold text-slate-100">
                      {semantic_briefing.arcs.length}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Drift: {semantic_briefing.drift_risk}
                    </p>
                  </div>
                )}
              </div>
            </article>
          </section>

          <section className="space-y-4">
            <h3 className="vibe-title text-lg text-slate-100">Conversation Arcs</h3>
            {conversationArcs.length === 0 ? (
              <div className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
                No conversation arcs are available for this date.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {conversationArcs.map((arc, index) => (
                  <article key={`${arc.title}-${index}`} className="vibe-panel rounded-xl p-5">
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
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Trend Direction</h3>
              {(trendData.emerging?.length || trendData.fading?.length || trendData.shifts) ? (
                <div className="mt-3 space-y-3 text-sm">
                  {trendData.emerging && trendData.emerging.length > 0 && (
                    <p className="text-emerald-300">
                      <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-emerald-400/90">
                        Emerging
                      </span>
                      {trendData.emerging.slice(0, 4).join(", ")}
                    </p>
                  )}
                  {trendData.fading && trendData.fading.length > 0 && (
                    <p className="text-slate-400">
                      <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-slate-500">
                        Fading
                      </span>
                      {trendData.fading.slice(0, 4).join(", ")}
                    </p>
                  )}
                  {trendData.shifts && (
                    <p className="leading-relaxed text-slate-300">{trendData.shifts}</p>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-400">No trend direction available yet.</p>
              )}
            </article>

            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Best Ways to Add Value Today</h3>
              {snapshotMoves.length === 0 ? (
                <p className="mt-3 text-sm text-slate-400">
                  No contribution moves are available for this date.
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {snapshotMoves.map((contribution, index) => {
                    const badge = freshnessBadge(contribution.freshness);
                    return (
                      <article
                        key={`${contribution.theme}-${index}`}
                        className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-slate-100">{contribution.theme}</p>
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge.color}`}>
                            {badge.label}
                          </span>
                          {contribution.channel && (
                            <span className="text-xs text-slate-400">{contribution.channel}</span>
                          )}
                        </div>
                        <p className="mt-2 text-sm text-slate-300">{contribution.why}</p>
                        <p className="mt-2 text-sm font-medium text-emerald-200/95">
                          {contribution.action}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </article>
          </section>
        </>
      )}

      {activeTab === "daily" && (
        <>
          {resolvedDailyMemo && (
            <section className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Daily Memo</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-200">{resolvedDailyMemo}</p>
            </section>
          )}
          <section className="grid gap-4 lg:grid-cols-2">
            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Executive Snapshot</h3>
              <div className="mt-3 space-y-2 text-sm text-slate-200">
                {executiveTakeaways.slice(0, 5).map((takeaway, index) => (
                  <p key={`${takeaway}-${index}`} className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                    {takeaway}
                  </p>
                ))}
              </div>
            </article>
            <article className="vibe-panel rounded-xl p-5">
              <h3 className="vibe-title text-lg text-slate-100">Thread Priorities</h3>
              <div className="mt-3 space-y-3">
                {threads.slice(0, 5).map((thread, index) => (
                  <div key={`${thread.title}-${index}`} className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                    <p className="text-sm font-semibold text-slate-100">{thread.title}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {thread.participants.slice(0, 6).join(", ") || "Participants not listed"}
                    </p>
                  </div>
                ))}
                {threads.length === 0 && (
                  <p className="text-sm text-slate-400">No thread priorities available for this date.</p>
                )}
              </div>
            </article>
          </section>
        </>
      )}

      {activeTab === "evidence" &&
        (evidenceQuotes.length > 0 ||
          references.length > 0 ||
          (recent_update?.quotes.length || 0) > 0) && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Evidence, Quotes, and References</h3>
          {evidenceQuotes.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              {evidenceQuotes.map((quote) => (
                <article key={quote.id} className="vibe-panel rounded-xl p-5">
                  <p className="text-sm leading-relaxed text-slate-100">“{excerpt(quote.body)}”</p>
                  <p className="mt-3 text-xs text-slate-400">
                    {quote.sender_name} · {quote.room_name} · {formatTs(quote.timestamp)}
                  </p>
                </article>
              ))}
            </div>
          )}
          {recent_update && recent_update.quotes.length > 0 && (
            <div className="vibe-panel rounded-xl p-5">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Recent High-Signal Quotes
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {recent_update.quotes.map((quote) => (
                  <article
                    key={quote.id}
                    className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
                  >
                    <p className="text-sm leading-relaxed text-slate-100">
                      “{excerpt(quote.body, 170)}”
                    </p>
                    <p className="mt-2 text-xs text-slate-400">
                      {quote.sender_name} · {quote.room_name}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}
          {references.length > 0 && (
            <div className="vibe-panel rounded-xl p-5">
              <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
                Source Links
              </p>
              <div className="mt-3 grid gap-2">
                {references.map((link, index) => (
                  <a
                    key={`${link}-${index}`}
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm break-all text-cyan-300 hover:text-cyan-100"
                  >
                    {hostname(link)} — {link}
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === "evidence" &&
        evidenceQuotes.length === 0 &&
        references.length === 0 &&
        (!recent_update || recent_update.quotes.length === 0) && (
          <section className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
            No evidence links or quote excerpts are available for this date.
          </section>
        )}

      {activeTab === "daily" && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Key Threads</h3>
          {threads.length === 0 ? (
            <div className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
              No briefing available for this date.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {threads.map((thread, i) => (
                <article key={`${thread.title}-${i}`} className="vibe-panel fade-up rounded-xl p-5">
                  <h4 className="vibe-title text-base text-slate-100">{thread.title}</h4>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {thread.participants.map((participant) => (
                      <span
                        key={`${thread.title}-${participant}`}
                        className="vibe-chip rounded px-2 py-0.5 text-xs"
                      >
                        {participant}
                      </span>
                    ))}
                  </div>
                  {(() => {
                    const threadKey = `${thread.title}-${i}`;
                    const isExpanded = expandedThreadKey === threadKey;
                    return (
                      <>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <p className="text-xs text-slate-500">
                            {thread.links.length} ref{thread.links.length === 1 ? "" : "s"}
                          </p>
                          <button
                            onClick={() =>
                              setExpandedThreadKey((prev) => (prev === threadKey ? null : threadKey))
                            }
                            className="rounded border border-slate-600/70 bg-slate-900/45 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-300/60"
                          >
                            {isExpanded ? "Hide deep dive" : "Deep dive"}
                          </button>
                        </div>
                        <p className="mt-3 text-sm leading-relaxed text-slate-300">
                          {isExpanded ? thread.insights : excerpt(thread.insights, 180)}
                        </p>
                        {isExpanded && thread.links.length > 0 && (
                          <div className="mt-3 space-y-1">
                            {thread.links.map((link, j) => (
                              <a
                                key={`${thread.title}-${j}`}
                                href={link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-xs break-all text-cyan-300 hover:text-cyan-100"
                              >
                                {link}
                              </a>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "daily" && contributions.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="vibe-title text-lg text-slate-100">Optional Contribution Moves</h3>
            {contributions.length > 3 && (
              <button
                onClick={() => setShowAllContributions((prev) => !prev)}
                className="rounded border border-slate-600/70 bg-slate-900/50 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-300/60"
              >
                {showAllContributions
                  ? "Show fewer contribution options"
                  : `Show all ${contributions.length} contribution options`}
              </button>
            )}
          </div>
          <div className="grid gap-4">
            {visibleContributions.map((contribution, i) => {
              const badge = freshnessBadge(contribution.freshness);
              return (
                <article
                  key={`${contribution.theme}-${i}`}
                  className="vibe-panel fade-up rounded-xl p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-emerald-300">
                      {contribution.theme}
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge.color}`}>
                      {badge.label}
                    </span>
                    <span className="vibe-chip rounded px-2 py-0.5 text-xs">
                      {contribution.type}
                    </span>
                    {contribution.message_count > 0 && (
                      <span className="text-xs text-slate-400">
                        {contribution.message_count} msgs
                      </span>
                    )}
                  </div>

                  {(contribution.channel || contribution.reply_to) && (
                    <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-900/65 p-3">
                      {contribution.channel && (
                        <p className="text-sm text-slate-200">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Channel
                          </span>
                          {contribution.channel}
                        </p>
                      )}
                      {contribution.reply_to && (
                        <p className="mt-1 text-sm text-slate-300">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Reply To
                          </span>
                          {contribution.reply_to}
                        </p>
                      )}
                    </div>
                  )}

                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{contribution.why}</p>
                  <p className="mt-2 text-sm font-medium text-emerald-200/95">{contribution.action}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {activeTab === "daily" &&
        (trendData.emerging?.length || trendData.fading?.length || trendData.shifts) && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Trend Direction</h3>
          <div className="vibe-panel rounded-xl p-5">
            {trendData.emerging && trendData.emerging.length > 0 && (
              <p className="text-sm text-emerald-300">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-emerald-400/90">
                  Emerging
                </span>
                {trendData.emerging.join(", ")}
              </p>
            )}
            {trendData.fading && trendData.fading.length > 0 && (
              <p className="mt-2 text-sm text-slate-400">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-slate-500">
                  Fading
                </span>
                {trendData.fading.join(", ")}
              </p>
            )}
            {trendData.shifts && (
              <p className="mt-3 text-sm leading-relaxed text-slate-300">{trendData.shifts}</p>
            )}
          </div>
        </section>
      )}

      {activeTab === "radar" && !recent_update && !radar && (
        <section className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
          No recent update or radar diagnostics are available for this date.
        </section>
      )}
    </div>
  );
}
