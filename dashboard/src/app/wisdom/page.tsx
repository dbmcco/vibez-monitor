// ABOUTME: Wisdom page for browsing collective knowledge distilled from chat history.
// ABOUTME: Supports topic sorting/filtering, starring, type browsing, and topic drill-down.

"use client";

import { useCallback, useEffect, useState } from "react";
import { ModelEnhancedAnalysis } from "@/components/ModelEnhancedAnalysis";
import { StarButton } from "@/components/StarButton";
import { StatusPanel } from "@/components/StatusPanel";
import { useStars } from "@/lib/stars";

interface WisdomTopic {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  message_count: number;
  contributor_count: number;
  last_active: string | null;
}

interface WisdomItem {
  id: number;
  topic_id: number;
  knowledge_type: string;
  title: string;
  summary: string | null;
  source_links: string;
  source_messages: string;
  contributors: string;
  confidence: number;
  topic_name?: string;
  topic_slug?: string;
}

interface WisdomStats {
  total_topics: number;
  total_items: number;
  type_counts: { type: string; count: number }[];
  top_contributors: { name: string; count: number }[];
}

interface Recommendation {
  id: number;
  from_topic_id: number;
  to_topic_id: number;
  strength: number;
  reason: string | null;
  topic_name: string;
  topic_slug: string;
}

interface TopicBrowseMeta {
  itemCount: number;
  maxConfidence: number;
  types: string[];
  items: WisdomItem[];
}

type ViewMode = "by-type" | "by-topic";
type TopicSort = "impact" | "freshness" | "discussion";

const KNOWLEDGE_TYPE_META: Record<string, { label: string; color: string; description: string }> = {
  stack: { label: "Stack", color: "text-emerald-400", description: "Tools, frameworks, libraries" },
  architecture: {
    label: "Architecture",
    color: "text-violet-400",
    description: "System design, patterns, boundaries",
  },
  best_practices: {
    label: "Best Practices",
    color: "text-amber-400",
    description: "Operational guidance and how-to norms",
  },
  config: { label: "Config", color: "text-sky-400", description: "Setups, env tips, implementation knobs" },
  research: { label: "Research", color: "text-rose-400", description: "Papers, novel ideas, deep dives" },
  tutorial: { label: "Tutorials", color: "text-cyan-400", description: "Walkthroughs and learning paths" },
  news: { label: "News", color: "text-orange-400", description: "Launches, releases, announcements" },
  opinion: { label: "Opinion", color: "text-pink-400", description: "Comparisons, takes, tradeoffs" },
  showcase: { label: "Showcase", color: "text-lime-400", description: "Demos and things people built" },
  people: { label: "People & Orgs", color: "text-indigo-400", description: "Who to follow and teams to watch" },
};

const TOPIC_SORTS: { key: TopicSort; label: string }[] = [
  { key: "impact", label: "Impact" },
  { key: "freshness", label: "Freshness" },
  { key: "discussion", label: "Discussion" },
];

const VALUE_TYPE_ORDER = [
  "best_practices",
  "architecture",
  "config",
  "stack",
  "tutorial",
  "research",
  "opinion",
  "news",
  "showcase",
  "people",
] as const;

const CONVERSATIONAL_LEAD_INS = [
  /^the (community consensus|discussion|conversation|group consensus) (is|was) that\s+/i,
  /^the discussion (indicates|highlights|suggests|shows) that\s+/i,
  /^the discussion (indicates|highlights|suggests|shows)\s+/i,
  /^discussion (centered on|of how to|highlights?)\s+/i,
  /^users (reported|found|discussed|noted) that\s+/i,
  /^users (reported|found|discussed|noted)\s+/i,
  /^people kept coming back to\s+/i,
  /^the community agrees that\s+/i,
  /^the community recommends? that\s+/i,
  /^the group recommends?\s+/i,
  /^the group (emphasizes|believes|argues) that\s+/i,
  /^community consensus is that\s+/i,
];

interface GuidanceSummary {
  takeaway: string;
  why: string;
  watchout: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.map((value) => String(value).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function topicContributors(items: WisdomItem[]): string[] {
  return Array.from(
    new Set(items.flatMap((item) => parseJsonArray(item.contributors)).filter((value) => value.length > 0)),
  );
}

function topicTypes(items: WisdomItem[]): string[] {
  return Array.from(new Set(items.map((item) => item.knowledge_type).filter(Boolean)));
}

function bestItemSummary(items: WisdomItem[]): string {
  const ranked = [...items].sort((a, b) => b.confidence - a.confidence || b.id - a.id);
  for (const item of ranked) {
    if (item.summary?.trim()) return item.summary.trim();
  }
  for (const item of ranked) {
    if (item.title?.trim()) return item.title.trim();
  }
  return "";
}

function typePriority(type: string): number {
  const idx = VALUE_TYPE_ORDER.indexOf(type as (typeof VALUE_TYPE_ORDER)[number]);
  return idx >= 0 ? idx : VALUE_TYPE_ORDER.length;
}

function prioritizeWisdomItems(items: WisdomItem[]): WisdomItem[] {
  return [...items].sort(
    (a, b) =>
      typePriority(a.knowledge_type) - typePriority(b.knowledge_type) ||
      b.confidence - a.confidence ||
      a.title.localeCompare(b.title),
  );
}

function pickValueItems(items: WisdomItem[], limit: number): WisdomItem[] {
  const ranked = prioritizeWisdomItems(items);
  const seen = new Set<string>();
  const selected: WisdomItem[] = [];
  for (const item of ranked) {
    const key = `${item.knowledge_type}:${item.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function cleanGuidanceCopy(text: string | null | undefined): string {
  if (!text) return "";
  let result = text.trim().replace(/\s+/g, " ");
  for (const pattern of CONVERSATIONAL_LEAD_INS) {
    result = result.replace(pattern, "");
  }
  result = result.replace(/^that\s+/i, "");
  if (!result) return "";
  return result[0].toUpperCase() + result.slice(1);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseGuidanceSummary(text: string | null | undefined): GuidanceSummary {
  const cleaned = cleanGuidanceCopy(text);
  if (!cleaned) {
    return { takeaway: "", why: "", watchout: "" };
  }

  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labeled: Partial<GuidanceSummary> = {};
  for (const line of lines) {
    const match = /^(Takeaway|Why|Watchout):\s*(.+)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase() as keyof GuidanceSummary;
    labeled[key] = match[2].trim();
  }
  if (labeled.takeaway || labeled.why || labeled.watchout) {
    return {
      takeaway: labeled.takeaway || "",
      why: labeled.why || "",
      watchout: labeled.watchout || "",
    };
  }

  const sentences = splitSentences(cleaned);
  return {
    takeaway: sentences[0] || cleaned,
    why: sentences[1] || "",
    watchout: sentences.slice(2).join(" "),
  };
}

function guidanceFromItem(item: WisdomItem): GuidanceSummary {
  const parsed = parseGuidanceSummary(item.summary);
  return {
    takeaway: item.title.trim() || parsed.takeaway,
    why: parsed.takeaway && parsed.takeaway !== item.title.trim() ? parsed.takeaway : parsed.why,
    watchout: parsed.watchout,
  };
}

function buildTopicBrowseMeta(typeItems: Record<string, WisdomItem[]>): Record<string, TopicBrowseMeta> {
  const grouped = new Map<
    string,
    { itemCount: number; maxConfidence: number; typeSet: Set<string>; items: WisdomItem[] }
  >();

  for (const items of Object.values(typeItems)) {
    for (const item of items) {
      const slug = item.topic_slug?.trim();
      if (!slug) continue;
      const existing = grouped.get(slug) || {
        itemCount: 0,
        maxConfidence: 0,
        typeSet: new Set<string>(),
        items: [],
      };
      existing.itemCount += 1;
      existing.maxConfidence = Math.max(existing.maxConfidence, item.confidence || 0);
      if (item.knowledge_type) existing.typeSet.add(item.knowledge_type);
      existing.items.push(item);
      grouped.set(slug, existing);
    }
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([slug, entry]) => [
      slug,
      {
        itemCount: entry.itemCount,
        maxConfidence: entry.maxConfidence,
        types: Array.from(entry.typeSet).sort(),
        items: prioritizeWisdomItems(entry.items),
      },
    ]),
  );
}

function countTopicsByType(topicMetaBySlug: Record<string, TopicBrowseMeta>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const meta of Object.values(topicMetaBySlug)) {
    for (const type of meta.types) {
      counts[type] = (counts[type] || 0) + 1;
    }
  }
  return counts;
}

function topicImpactScore(topic: WisdomTopic, meta?: TopicBrowseMeta): number {
  return (
    topic.message_count * 2 +
    topic.contributor_count * 5 +
    (meta?.itemCount || 0) * 4 +
    Math.round((meta?.maxConfidence || 0) * 100)
  );
}

function dateScore(iso: string | null): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : 0;
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
        active
          ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
          : "border-slate-700/50 text-slate-500 hover:border-slate-500 hover:text-slate-400"
      }`}
    >
      {children}
    </button>
  );
}

function TypeLabel({ type }: { type: string }) {
  const meta = KNOWLEDGE_TYPE_META[type];
  return <span className={meta?.color || "text-slate-300"}>{meta?.label || type}</span>;
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <div className="vibe-panel rounded-xl p-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="vibe-title mt-2 text-2xl text-slate-100">{value}</div>
      <p className="mt-1 text-xs text-slate-400">{detail}</p>
    </div>
  );
}

function GuidanceCard({
  item,
  topicName,
  topicSlug,
  topicSummary,
  compact = false,
  showEnhancedAnalysis = true,
}: {
  item: WisdomItem;
  topicName: string;
  topicSlug: string;
  topicSummary: string;
  compact?: boolean;
  showEnhancedAnalysis?: boolean;
}) {
  const guidance = guidanceFromItem(item);
  const stableSummary = cleanGuidanceCopy(item.summary);

  return (
    <div className="rounded-xl border border-slate-800/70 bg-slate-950/55 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
          <TypeLabel type={item.knowledge_type} />
        </span>
        <span className="text-[11px] text-slate-500">{Math.round(item.confidence * 100)}%</span>
      </div>
      <p className={`mt-2 font-medium text-slate-100 ${compact ? "line-clamp-2 text-sm" : "text-base"}`}>
        {guidance.takeaway || item.title}
      </p>
      {guidance.why ? (
        <p className={`mt-2 text-slate-400 ${compact ? "line-clamp-2 text-xs" : "text-sm"}`}>{guidance.why}</p>
      ) : null}
      {!compact && guidance.watchout ? (
        <p className="mt-2 text-xs text-amber-200/80">Watchout: {guidance.watchout}</p>
      ) : null}
      {showEnhancedAnalysis ? (
        <ModelEnhancedAnalysis
          compact={compact}
          cacheKey={`${topicSlug}:${item.id}`}
          payload={{
            topicName,
            topicSummary: cleanGuidanceCopy(topicSummary),
            knowledgeType: item.knowledge_type,
            title: guidance.takeaway || item.title,
            summary: stableSummary,
          }}
        />
      ) : null}
    </div>
  );
}

export default function WisdomPage() {
  const [view, setView] = useState<ViewMode>("by-topic");
  const [stats, setStats] = useState<WisdomStats | null>(null);
  const [topics, setTopics] = useState<WisdomTopic[]>([]);
  const [typeItems, setTypeItems] = useState<Record<string, WisdomItem[]>>({});
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<WisdomTopic | null>(null);
  const [topicItems, setTopicItems] = useState<WisdomItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [topicFilter, setTopicFilter] = useState("all");
  const [topicSort, setTopicSort] = useState<TopicSort>("impact");
  const [starredOnly, setStarredOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const { stars, isWisdomTopicStarred, toggleWisdomTopicStar } = useStars();

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [statsRes, topicsRes, typeRes] = await Promise.all([
        fetch("/api/wisdom?stats=1"),
        fetch("/api/wisdom"),
        fetch("/api/wisdom?type="),
      ]);
      const [statsData, topicsData, typeData] = await Promise.all([
        statsRes.json(),
        topicsRes.json(),
        typeRes.json(),
      ]);
      setStats(statsData);
      setTopics(Array.isArray(topicsData.topics) ? topicsData.topics : []);
      setTypeItems(typeData.items && typeof typeData.items === "object" ? typeData.items : {});
    } catch {
      setStats(null);
      setTopics([]);
      setTypeItems({});
      setError("Wisdom data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTopicDetail = useCallback(async (slug: string) => {
    setLoading(true);
    setError("");
    setSelectedTopic(null);
    setTopicItems([]);
    setRecommendations([]);
    try {
      const detailRes = await fetch(`/api/wisdom?topic=${encodeURIComponent(slug)}`);
      const detail = await detailRes.json();
      if (!detail || !detail.id) {
        setSelectedTopic(null);
        setTopicItems([]);
        setRecommendations([]);
        setError("That topic could not be found.");
        return;
      }
      setSelectedTopic({
        id: detail.id,
        name: detail.name,
        slug: detail.slug,
        summary: detail.summary,
        message_count: detail.message_count,
        contributor_count: detail.contributor_count,
        last_active: detail.last_active,
      });
      const items = Array.isArray(detail.items) ? detail.items : [];
      setTopicItems(items);

      const recRes = await fetch(`/api/wisdom?recommendations=${detail.id}`);
      const recData = await recRes.json();
      setRecommendations(Array.isArray(recData.recommendations) ? recData.recommendations : []);
    } catch {
      setSelectedTopic(null);
      setTopicItems([]);
      setRecommendations([]);
      setError("Topic detail could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const topicParam = new URLSearchParams(window.location.search).get("topic")?.trim() || null;
    if (!topicParam) return;
    setView("by-topic");
    void loadTopicDetail(topicParam);
  }, [loadTopicDetail]);

  const updateTopicParam = useCallback((slug: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (slug) {
      params.set("topic", slug);
    } else {
      params.delete("topic");
    }
    const next = params.toString();
    window.history.replaceState({}, "", next ? `${url.pathname}?${next}` : url.pathname);
  }, []);

  function resetTopicSelection(nextView?: ViewMode) {
    if (nextView) setView(nextView);
    setSelectedTopic(null);
    setTopicItems([]);
    setRecommendations([]);
    setError("");
    updateTopicParam(null);
  }

  function openTopic(slug: string) {
    setView("by-topic");
    updateTopicParam(slug);
    void loadTopicDetail(slug);
  }

  const topicMetaBySlug = buildTopicBrowseMeta(typeItems);
  const topicCountsByType = countTopicsByType(topicMetaBySlug);
  const visibleTypeGroups = selectedType
    ? Object.entries(typeItems).filter(([type]) => type === selectedType)
    : Object.entries(typeItems);
  const filteredTopics = topics
    .filter((topic) => {
      const meta = topicMetaBySlug[topic.slug];
      if (topicFilter !== "all" && !meta?.types.includes(topicFilter)) return false;
      if (starredOnly && !Boolean(stars.wisdomTopics[topic.slug])) return false;
      return true;
    })
    .sort((a, b) => {
      const metaA = topicMetaBySlug[a.slug];
      const metaB = topicMetaBySlug[b.slug];

      if (topicSort === "freshness") {
        return (
          dateScore(b.last_active) - dateScore(a.last_active) ||
          b.message_count - a.message_count ||
          a.name.localeCompare(b.name)
        );
      }

      if (topicSort === "discussion") {
        return (
          b.message_count - a.message_count ||
          b.contributor_count - a.contributor_count ||
          dateScore(b.last_active) - dateScore(a.last_active) ||
          a.name.localeCompare(b.name)
        );
      }

      return (
        topicImpactScore(b, metaB) - topicImpactScore(a, metaA) ||
        b.message_count - a.message_count ||
        dateScore(b.last_active) - dateScore(a.last_active) ||
        a.name.localeCompare(b.name)
      );
    });
  const topType = stats?.type_counts[0];
  const topContributor = stats?.top_contributors[0];
  const rankedTopicItems = prioritizeWisdomItems(topicItems);
  const selectedTopicContributors = topicContributors(topicItems);
  const selectedTopicTypes = topicTypes(topicItems);
  const selectedTopicSummary = selectedTopic?.summary?.trim() || bestItemSummary(topicItems);
  const selectedTopicSummaryParts = parseGuidanceSummary(selectedTopicSummary);
  const selectedTopicValueItems = pickValueItems(rankedTopicItems, 4);
  const starredTopicCount = Object.keys(stars.wisdomTopics).length;

  if (loading && !stats && topics.length === 0 && Object.keys(typeItems).length === 0) {
    return (
      <StatusPanel
        loading
        title="Loading wisdom"
        detail="Pulling topic clusters, extracted knowledge items, and related recommendations."
        steps={[
          "Loading topic totals and knowledge types",
          "Fetching extracted insights by type",
          "Preparing topic-level drill-downs",
        ]}
      />
    );
  }

  if (error && !stats && topics.length === 0 && Object.keys(typeItems).length === 0) {
    return <StatusPanel title="Wisdom unavailable" detail={error || "The wisdom API did not return usable data."} />;
  }

  return (
    <div className="fade-up space-y-4">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">Wisdom</h1>
            <p className="vibe-subtitle max-w-3xl">
              Collective knowledge extracted from group conversations. Open a topic card to see the
              group&apos;s shared take, then pivot by type when you want a different cut.
            </p>
          </div>
          <div className="hidden rounded-full border border-slate-700/60 bg-slate-900/70 px-3 py-1 text-xs text-slate-400 sm:block">
            {stats
              ? `${stats.total_topics.toLocaleString()} topics · ${stats.total_items.toLocaleString()} items`
              : "Wisdom"}
          </div>
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Topics"
          value={stats?.total_topics.toLocaleString() || "0"}
          detail="Distinct knowledge clusters synthesized from chat history."
        />
        <MetricCard
          label="Insights"
          value={stats?.total_items.toLocaleString() || "0"}
          detail="Extracted claims, patterns, and recommendations across topics."
        />
        <MetricCard
          label="Top Type"
          value={topType ? KNOWLEDGE_TYPE_META[topType.type]?.label || topType.type : "None"}
          detail={topType ? `${topType.count} items in the strongest category right now.` : "No extracted type signal yet."}
        />
        <MetricCard
          label="Top Contributor"
          value={topContributor?.name || "None"}
          detail={
            topContributor
              ? `${topContributor.count} knowledge items reference this contributor.`
              : "Contributor counts will populate after extraction runs."
          }
        />
      </section>

      <section className="vibe-panel rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Pill
              active={view === "by-topic"}
              onClick={() => {
                setSelectedType(null);
                resetTopicSelection("by-topic");
              }}
            >
              By Topic
            </Pill>
            <Pill
              active={view === "by-type"}
              onClick={() => {
                setSelectedType(null);
                resetTopicSelection("by-type");
              }}
            >
              By Type
            </Pill>
          </div>
          {selectedType && view === "by-type" ? (
            <button
              type="button"
              onClick={() => setSelectedType(null)}
              className="text-xs text-cyan-300 transition hover:text-cyan-200"
            >
              Clear type filter
            </button>
          ) : (
            <div className="text-xs text-slate-500">{starredTopicCount} starred topics</div>
          )}
        </div>
      </section>

      {error ? <StatusPanel title="Partial load warning" detail={error} /> : null}

      {view === "by-topic" && !selectedTopic ? (
        <section className="vibe-panel rounded-xl p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="w-16 text-[10px] font-medium uppercase tracking-wider text-slate-600">Category</span>
              <Pill active={topicFilter === "all"} onClick={() => setTopicFilter("all")}>
                All
              </Pill>
              {(stats?.type_counts || []).map((entry) => (
                <Pill
                  key={entry.type}
                  active={topicFilter === entry.type}
                  onClick={() => setTopicFilter(entry.type)}
                >
                  {KNOWLEDGE_TYPE_META[entry.type]?.label || entry.type}
                  <span className="ml-0.5 opacity-50"> {topicCountsByType[entry.type] || 0}</span>
                </Pill>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap items-center gap-1">
                <span className="w-16 text-[10px] font-medium uppercase tracking-wider text-slate-600">Sort</span>
                {TOPIC_SORTS.map((entry) => (
                  <Pill key={entry.key} active={topicSort === entry.key} onClick={() => setTopicSort(entry.key)}>
                    {entry.label}
                  </Pill>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Saved</span>
                <Pill active={!starredOnly} onClick={() => setStarredOnly(false)}>
                  All
                </Pill>
                <Pill active={starredOnly} onClick={() => setStarredOnly(true)}>
                  Starred
                  <span className="ml-0.5 opacity-50"> {starredTopicCount}</span>
                </Pill>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {view === "by-type" && !selectedTopic ? (
        <section className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(KNOWLEDGE_TYPE_META).map(([type, meta]) => {
              const count = stats?.type_counts.find((entry) => entry.type === type)?.count || 0;
              const sample = (typeItems[type] || []).slice(0, 2);
              return (
                <button
                  type="button"
                  key={type}
                  onClick={() => setSelectedType((current) => (current === type ? null : type))}
                  className={`vibe-panel rounded-xl p-4 text-left transition ${
                    selectedType === type
                      ? "border-cyan-400/55 shadow-[0_0_0_1px_rgba(84,198,249,0.16)]"
                      : "hover:border-slate-500/70"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className={`text-sm font-medium ${meta.color}`}>{meta.label}</div>
                      <p className="mt-1 text-xs text-slate-400">{meta.description}</p>
                    </div>
                    <div className="rounded-full border border-slate-700/60 bg-slate-950/70 px-2 py-0.5 text-xs text-slate-300">
                      {count}
                    </div>
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {sample.length > 0 ? (
                      sample.map((item) => (
                        <p key={item.id} className="line-clamp-1 text-xs text-slate-400">
                          {item.title}
                        </p>
                      ))
                    ) : (
                      <p className="text-xs text-slate-500">No extracted items yet.</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {visibleTypeGroups.length === 0 ? (
            <StatusPanel title="No wisdom items yet" detail="Run the extraction pipeline to populate the by-type view." />
          ) : (
            <div className="space-y-4">
              {visibleTypeGroups.map(([type, items]) => {
                const meta = KNOWLEDGE_TYPE_META[type];
                return (
                  <div key={type} className="vibe-panel overflow-hidden rounded-xl">
                    <div className="flex items-center justify-between border-b border-slate-800/70 px-4 py-3">
                      <div>
                        <h2 className={`vibe-title text-lg ${meta?.color || "text-slate-200"}`}>
                          {meta?.label || type}
                        </h2>
                        <p className="mt-1 text-xs text-slate-400">
                          {meta?.description || "Extracted items grouped under this knowledge type."}
                        </p>
                      </div>
                      <div className="text-xs text-slate-500">{items.length} items</div>
                    </div>
                    <div className="divide-y divide-slate-800/60">
                      {items.slice(0, selectedType ? 40 : 6).map((item) => {
                        const contributors = parseJsonArray(item.contributors);
                        return (
                          <button
                            type="button"
                            key={item.id}
                            onClick={() => item.topic_slug && openTopic(item.topic_slug)}
                            className="grid w-full gap-2 px-4 py-3 text-left transition hover:bg-slate-900/50 sm:grid-cols-[minmax(0,1fr)_170px_88px]"
                          >
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm text-slate-100">{item.title}</p>
                                {item.topic_name ? (
                                  <span className="rounded-full border border-slate-700/60 px-2 py-0.5 text-[11px] text-slate-400">
                                    {item.topic_name}
                                  </span>
                                ) : null}
                              </div>
                              {item.summary ? (
                                <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                                  {cleanGuidanceCopy(item.summary)}
                                </p>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500">
                              {contributors.length > 0 ? contributors.slice(0, 3).join(", ") : "No contributors"}
                            </div>
                            <div className="text-right text-xs text-slate-500">{Math.round(item.confidence * 100)}%</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {view === "by-topic" && !selectedTopic ? (
        <section className="space-y-3">
          {topics.length === 0 ? (
            <StatusPanel title="No wisdom topics extracted yet" detail="Run the extraction pipeline to populate the topic browser." />
          ) : filteredTopics.length === 0 ? (
            <StatusPanel title="No topics match" detail="Try a different category, sort, or saved filter." />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {filteredTopics.map((topic) => {
                const meta = topicMetaBySlug[topic.slug];
                const impactScore = topicImpactScore(topic, meta);
                const topicSummaryParts = parseGuidanceSummary(topic.summary);
                const topicValueItems = pickValueItems(meta?.items || [], 1);
                const primaryValueItem = topicValueItems[0];
                const additionalValueItem = pickValueItems(meta?.items || [], 2).find(
                  (item) => item.id !== primaryValueItem?.id,
                );
                const additionalGuidance = additionalValueItem ? guidanceFromItem(additionalValueItem) : null;
                const fallbackTakeaway =
                  topicSummaryParts.takeaway ||
                  cleanGuidanceCopy(topic.summary) ||
                  "Summary pending for this topic.";
                const fallbackAdditionalGuidance =
                  topicSummaryParts.why ||
                  topicSummaryParts.watchout ||
                  "No additional extracted guidance yet for this topic.";

                return (
                  <article
                    key={topic.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTopic(topic.slug)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openTopic(topic.slug);
                      }
                    }}
                    className="vibe-panel cursor-pointer rounded-xl p-4 text-left transition hover:-translate-y-0.5 hover:border-slate-500/70"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="vibe-title text-lg text-slate-100">{topic.name}</h2>
                        <p className="mt-1 text-xs text-slate-500">
                          {topic.message_count} messages · {topic.contributor_count} contributors
                          {topic.last_active ? ` · active ${formatDate(topic.last_active)}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StarButton
                          compact
                          active={isWisdomTopicStarred(topic.slug)}
                          label={topic.name}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleWisdomTopicStar(topic.slug);
                          }}
                        />
                        <span className="text-lg leading-none text-slate-500" aria-hidden="true">
                          ↗
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      {primaryValueItem ? (
                        <GuidanceCard
                          item={primaryValueItem}
                          topicName={topic.name}
                          topicSlug={topic.slug}
                          topicSummary={topic.summary || ""}
                          compact
                        />
                      ) : (
                        <div>
                          <p className="line-clamp-2 text-sm text-slate-300">{fallbackTakeaway}</p>
                          {topicSummaryParts.why ? (
                            <p className="mt-2 line-clamp-2 text-xs text-slate-500">{topicSummaryParts.why}</p>
                          ) : null}
                          <ModelEnhancedAnalysis
                            compact
                            cacheKey={`${topic.slug}:topic-summary`}
                            payload={{
                              topicName: topic.name,
                              topicSummary: cleanGuidanceCopy(topic.summary),
                              knowledgeType: "topic",
                              title: fallbackTakeaway,
                              summary: cleanGuidanceCopy(topic.summary),
                            }}
                          />
                        </div>
                      )}
                    </div>

                    <div className="mt-3 border-t border-slate-800/60 pt-3">
                      <h3 className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                        Additional Extracted Guidance
                      </h3>
                      <div className="mt-2 rounded-xl border border-slate-800/60 bg-slate-950/35 px-3 py-2">
                        {additionalValueItem ? (
                          <>
                            <p className="text-xs font-medium text-slate-200">
                              {additionalGuidance?.takeaway || additionalValueItem.title}
                            </p>
                            {additionalGuidance?.why ? (
                              <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">
                                {additionalGuidance.why}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          <p className="text-[11px] text-slate-500">{fallbackAdditionalGuidance}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      <span className="rounded-full border border-slate-800/60 px-2 py-0.5">impact {impactScore}</span>
                      <span className="rounded-full border border-slate-800/60 px-2 py-0.5">
                        {(meta?.itemCount || 0).toLocaleString()} items
                      </span>
                      {(meta?.types || []).slice(0, 3).map((type) => (
                        <span key={type} className="rounded-full border border-slate-800/60 px-2 py-0.5">
                          <TypeLabel type={type} />
                        </span>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {selectedTopic ? (
        <section className="space-y-4">
          <button
            type="button"
            onClick={() => resetTopicSelection("by-topic")}
            className="text-sm text-cyan-300 transition hover:text-cyan-200"
          >
            ← Back to topics
          </button>

          <div className="space-y-4">
            <div className="vibe-panel rounded-xl p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="vibe-title text-2xl text-slate-100">{selectedTopic.name}</h2>
                  <div className="mt-2 max-w-3xl space-y-2">
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                        Takeaway
                      </p>
                      <p className="mt-1 text-sm text-slate-300">
                        {selectedTopicSummaryParts.takeaway ||
                          cleanGuidanceCopy(selectedTopicSummary) ||
                          "Summary pending for this topic."}
                      </p>
                    </div>
                    {selectedTopicSummaryParts.why ? (
                      <p className="text-sm text-slate-400">{selectedTopicSummaryParts.why}</p>
                    ) : null}
                    {selectedTopicSummaryParts.watchout ? (
                      <p className="text-sm text-amber-200/80">
                        Watchout: {selectedTopicSummaryParts.watchout}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StarButton
                    active={isWisdomTopicStarred(selectedTopic.slug)}
                    label={selectedTopic.name}
                    onClick={(event) => {
                      event.preventDefault();
                      toggleWisdomTopicStar(selectedTopic.slug);
                    }}
                  />
                  <div className="rounded-full border border-slate-700/60 bg-slate-950/70 px-3 py-1 text-xs text-slate-400">
                    active {formatDate(selectedTopic.last_active) || "recently"}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="rounded-full border border-slate-700/60 px-2 py-0.5">
                  {selectedTopic.message_count} messages
                </span>
                <span className="rounded-full border border-slate-700/60 px-2 py-0.5">
                  {selectedTopic.contributor_count} contributors
                </span>
                {selectedTopicTypes.map((type) => (
                  <span key={type} className="rounded-full border border-slate-700/60 px-2 py-0.5">
                    <TypeLabel type={type} />
                  </span>
                ))}
              </div>
              {selectedTopicContributors.length > 0 ? (
                <p className="mt-4 text-xs text-slate-500">
                  Contributors: {selectedTopicContributors.slice(0, 8).join(", ")}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="space-y-4">
                {selectedTopicValueItems.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="vibe-title text-lg text-slate-100">Key Guidance</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      {selectedTopicValueItems.map((item) => (
                        <GuidanceCard
                          key={item.id}
                          item={item}
                          topicName={selectedTopic.name}
                          topicSlug={selectedTopic.slug}
                          topicSummary={selectedTopicSummary}
                          showEnhancedAnalysis={false}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <aside className="space-y-4">
                <div className="vibe-panel rounded-xl p-4">
                  <ModelEnhancedAnalysis
                    standalone
                    cacheKey={`${selectedTopic.slug}:topic-detail`}
                    payload={{
                      topicName: selectedTopic.name,
                      topicSummary: cleanGuidanceCopy(selectedTopicSummary),
                      knowledgeType: "topic",
                      title:
                        selectedTopicSummaryParts.takeaway ||
                        cleanGuidanceCopy(selectedTopicSummary) ||
                        selectedTopic.name,
                      summary: cleanGuidanceCopy(selectedTopicSummary),
                    }}
                  />
                </div>

                <div className="vibe-panel rounded-xl p-4">
                  <h3 className="vibe-title text-lg text-slate-100">Related Topics</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Recommendations are based on shared contributors across topics.
                  </p>
                  <div className="mt-3 space-y-2">
                    {recommendations.length > 0 ? (
                      recommendations.map((rec) => (
                        <button
                          type="button"
                          key={rec.id}
                          onClick={() => openTopic(rec.topic_slug)}
                          className="w-full rounded-lg border border-slate-800/70 bg-slate-950/50 px-3 py-3 text-left transition hover:border-slate-600"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm text-slate-100">{rec.topic_name}</span>
                            <span className="text-[11px] text-slate-500">{Math.round(rec.strength * 100)}%</span>
                          </div>
                          {rec.reason ? <p className="mt-1 text-xs text-slate-400">{rec.reason}</p> : null}
                        </button>
                      ))
                    ) : (
                      <p className="text-sm text-slate-500">No related topics yet for this cluster.</p>
                    )}
                  </div>
                </div>

                <div className="vibe-panel rounded-xl p-4">
                  <h3 className="vibe-title text-lg text-slate-100">Top Contributors</h3>
                  <div className="mt-3 space-y-2">
                    {(stats?.top_contributors || []).slice(0, 6).map((entry) => (
                      <div key={entry.name} className="flex items-center justify-between text-sm">
                        <span className="text-slate-300">{entry.name}</span>
                        <span className="text-slate-500">{entry.count}</span>
                      </div>
                    ))}
                    {!stats?.top_contributors?.length ? (
                      <p className="text-sm text-slate-500">Contributor counts will appear after extraction runs.</p>
                    ) : null}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
