// ABOUTME: Wisdom page for browsing collective knowledge distilled from chat history.
// ABOUTME: Supports by-type browsing, topic drill-down, and related-topic recommendations.

"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

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

type ViewMode = "by-type" | "by-topic";

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
    new Set(
      items.flatMap((item) => parseJsonArray(item.contributors)).filter((value) => value.length > 0),
    ),
  );
}

function topicTypes(items: WisdomItem[]): string[] {
  return Array.from(new Set(items.map((item) => item.knowledge_type).filter(Boolean)));
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

export default function WisdomPage() {
  const [view, setView] = useState<ViewMode>("by-type");
  const [stats, setStats] = useState<WisdomStats | null>(null);
  const [topics, setTopics] = useState<WisdomTopic[]>([]);
  const [typeItems, setTypeItems] = useState<Record<string, WisdomItem[]>>({});
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<WisdomTopic | null>(null);
  const [topicItems, setTopicItems] = useState<WisdomItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
    loadInitial();
  }, [loadInitial]);

  function resetTopicSelection(nextView?: ViewMode) {
    if (nextView) setView(nextView);
    setSelectedTopic(null);
    setTopicItems([]);
    setRecommendations([]);
    setError("");
  }

  function openTopic(slug: string) {
    setView("by-topic");
    void loadTopicDetail(slug);
  }

  const visibleTypeGroups = selectedType
    ? Object.entries(typeItems).filter(([type]) => type === selectedType)
    : Object.entries(typeItems);
  const topType = stats?.type_counts[0];
  const topContributor = stats?.top_contributors[0];
  const selectedTopicContributors = topicContributors(topicItems);
  const selectedTopicTypes = topicTypes(topicItems);

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
    return (
      <StatusPanel
        title="Wisdom unavailable"
        detail={error || "The wisdom API did not return usable data."}
      />
    );
  }

  return (
    <div className="fade-up space-y-4">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">Wisdom</h1>
            <p className="vibe-subtitle max-w-3xl">
              Collective knowledge extracted from group conversations. Browse by knowledge type or drill
              into a topic to see the group&apos;s shared take.
            </p>
          </div>
          <div className="hidden rounded-full border border-slate-700/60 bg-slate-900/70 px-3 py-1 text-xs text-slate-400 sm:block">
            {stats ? `${stats.total_topics.toLocaleString()} topics · ${stats.total_items.toLocaleString()} items` : "Wisdom"}
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
              active={view === "by-type"}
              onClick={() => {
                setSelectedType(null);
                resetTopicSelection("by-type");
              }}
            >
              By Type
            </Pill>
            <Pill
              active={view === "by-topic"}
              onClick={() => {
                setSelectedType(null);
                resetTopicSelection("by-topic");
              }}
            >
              By Topic
            </Pill>
          </div>
          {selectedType && view === "by-type" ? (
            <button
              onClick={() => setSelectedType(null)}
              className="text-xs text-cyan-300 transition hover:text-cyan-200"
            >
              Clear type filter
            </button>
          ) : null}
        </div>
      </section>

      {error ? (
        <StatusPanel title="Partial load warning" detail={error} />
      ) : null}

      {view === "by-type" && !selectedTopic ? (
        <section className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(KNOWLEDGE_TYPE_META).map(([type, meta]) => {
              const count = stats?.type_counts.find((entry) => entry.type === type)?.count || 0;
              const sample = (typeItems[type] || []).slice(0, 2);
              return (
                <button
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
            <StatusPanel
              title="No wisdom items yet"
              detail="Run the extraction pipeline to populate the by-type view."
            />
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
                                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{item.summary}</p>
                              ) : null}
                            </div>
                            <div className="text-xs text-slate-500">
                              {contributors.length > 0 ? contributors.slice(0, 3).join(", ") : "No contributors"}
                            </div>
                            <div className="text-right text-xs text-slate-500">
                              {Math.round(item.confidence * 100)}%
                            </div>
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
            <StatusPanel
              title="No wisdom topics extracted yet"
              detail="Run the extraction pipeline to populate the topic browser."
            />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {topics.map((topic) => (
                <button
                  key={topic.id}
                  onClick={() => openTopic(topic.slug)}
                  className="vibe-panel rounded-xl p-4 text-left transition hover:border-slate-500/70"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="vibe-title text-lg text-slate-100">{topic.name}</h2>
                      <p className="mt-1 text-xs text-slate-500">
                        {topic.message_count} messages · {topic.contributor_count} contributors
                        {topic.last_active ? ` · active ${formatDate(topic.last_active)}` : ""}
                      </p>
                    </div>
                    <span className="rounded-full border border-slate-700/60 bg-slate-950/70 px-2 py-0.5 text-xs text-slate-300">
                      open
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 text-sm text-slate-400">
                    {topic.summary || "No synthesis summary yet. Open the topic to inspect the extracted items and evidence trails."}
                  </p>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {selectedTopic ? (
        <section className="space-y-4">
          <button
            onClick={() => resetTopicSelection("by-topic")}
            className="text-sm text-cyan-300 transition hover:text-cyan-200"
          >
            ← Back to topics
          </button>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-4">
              <div className="vibe-panel rounded-xl p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="vibe-title text-2xl text-slate-100">{selectedTopic.name}</h2>
                    <p className="mt-2 max-w-3xl text-sm text-slate-400">
                      {selectedTopic.summary ||
                        "This topic has extracted evidence but does not yet have a consensus synthesis summary."}
                    </p>
                  </div>
                  <div className="rounded-full border border-slate-700/60 bg-slate-950/70 px-3 py-1 text-xs text-slate-400">
                    active {formatDate(selectedTopic.last_active) || "recently"}
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

              <div className="space-y-3">
                {topicItems.map((item) => {
                  const contributors = parseJsonArray(item.contributors);
                  const sourceLinks = parseJsonArray(item.source_links);
                  const sourceMessages = parseJsonArray(item.source_messages);
                  return (
                    <article key={item.id} className="vibe-panel rounded-xl p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-slate-700/60 px-2 py-0.5 text-[11px]">
                            <TypeLabel type={item.knowledge_type} />
                          </span>
                          <span className="text-xs text-slate-500">
                            {Math.round(item.confidence * 100)}% confidence
                          </span>
                        </div>
                        <div className="text-xs text-slate-500">
                          {sourceMessages.length} messages · {sourceLinks.length} links
                        </div>
                      </div>
                      <h3 className="vibe-title mt-3 text-lg text-slate-100">{item.title}</h3>
                      {item.summary ? <p className="mt-2 text-sm text-slate-400">{item.summary}</p> : null}
                      {contributors.length > 0 ? (
                        <p className="mt-3 text-xs text-slate-500">
                          Contributors: {contributors.slice(0, 8).join(", ")}
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>

            <aside className="space-y-4">
              <div className="vibe-panel rounded-xl p-4">
                <h3 className="vibe-title text-lg text-slate-100">Related Topics</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Recommendations are based on shared contributors across topics.
                </p>
                <div className="mt-3 space-y-2">
                  {recommendations.length > 0 ? (
                    recommendations.map((rec) => (
                      <button
                        key={rec.id}
                        onClick={() => openTopic(rec.topic_slug)}
                        className="w-full rounded-lg border border-slate-800/70 bg-slate-950/50 px-3 py-3 text-left transition hover:border-slate-600"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-slate-100">{rec.topic_name}</span>
                          <span className="text-[11px] text-slate-500">
                            {Math.round(rec.strength * 100)}%
                          </span>
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
        </section>
      ) : null}
    </div>
  );
}
