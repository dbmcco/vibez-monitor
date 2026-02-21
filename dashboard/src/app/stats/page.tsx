"use client";

import { useEffect, useMemo, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

interface DailyCount {
  date: string;
  count: number;
}

interface RankedStat {
  name: string;
  messages: number;
  active_days: number;
  first_seen: string;
  last_seen: string;
  avg_relevance: number | null;
}

interface TopicStat {
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

interface TopicCooccurrence {
  topic_a: string;
  topic_b: string;
  co_messages: number;
  overlap_ratio: number;
  jaccard: number;
  last_seen: string;
  trend: "up" | "flat" | "down";
}

interface SeasonalityStats {
  by_weekday: { weekday: string; count: number }[];
  by_hour: { hour: number; count: number }[];
  topic_peaks: {
    topic: string;
    messages: number;
    peak_weekday: string;
    peak_hour: number;
  }[];
}

interface StatsDashboard {
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

interface TopicDrilldownMessage {
  id: string;
  timestamp: number;
  date: string;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
}

interface TopicDrilldown {
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

interface TopicInsights {
  summary: string;
  guidance: string[];
  watchouts: string[];
  next_questions: string[];
}

const CHART_COLORS = [
  "#22d3ee",
  "#34d399",
  "#f59e0b",
  "#f87171",
  "#a78bfa",
  "#fb7185",
  "#2dd4bf",
  "#60a5fa",
];

function Sparkline({ daily }: { daily: DailyCount[] }) {
  const bars = daily.slice(-24);
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div className="flex h-8 items-end gap-[2px]">
      {bars.map((bar) => (
        <div
          key={bar.date}
          title={`${bar.date}: ${bar.count}`}
          className="w-1 rounded-sm bg-cyan-400/80"
          style={{ height: `${Math.max(8, (bar.count / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function toLinePath(points: { x: number; y: number }[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");
}

function toAreaPath(points: { x: number; y: number }[], baseline: number): string {
  if (points.length === 0) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${toLinePath(points)} L${last.x} ${baseline} L${first.x} ${baseline} Z`;
}

function InteractiveTimelineChart({
  daily,
  color,
  yLabel,
}: {
  daily: DailyCount[];
  color: string;
  yLabel: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 900;
  const height = 220;
  const padLeft = 34;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 30;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const maxY = Math.max(1, ...daily.map((point) => point.count));

  const points = useMemo(
    () =>
      daily.map((point, i) => {
        const x = padLeft + (i / Math.max(1, daily.length - 1)) * innerWidth;
        const y = padTop + innerHeight - (point.count / maxY) * innerHeight;
        return { x, y, ...point };
      }),
    [daily, innerWidth, innerHeight, maxY],
  );

  const hovered = hoverIndex === null ? null : points[hoverIndex];

  if (daily.length === 0) {
    return <p className="text-sm text-slate-400">No timeline data yet.</p>;
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-56 w-full rounded-lg border border-slate-700/50 bg-slate-950/40"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left;
          const normalized = Math.min(Math.max(px / rect.width, 0), 1);
          const idx = Math.round(normalized * (daily.length - 1));
          setHoverIndex(idx);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          stroke="#334155"
          strokeWidth={1}
        />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerHeight} stroke="#334155" strokeWidth={1} />
        <path d={toAreaPath(points, padTop + innerHeight)} fill={color} fillOpacity={0.12} />
        <path d={toLinePath(points)} fill="none" stroke={color} strokeWidth={2.5} />
        {hovered ? (
          <>
            <line
              x1={hovered.x}
              y1={padTop}
              x2={hovered.x}
              y2={padTop + innerHeight}
              stroke={color}
              strokeOpacity={0.35}
              strokeDasharray="4 4"
            />
            <circle cx={hovered.x} cy={hovered.y} r={4} fill={color} />
          </>
        ) : null}
        <text x={padLeft} y={height - 8} fill="#94a3b8" fontSize="10">
          {daily[0]?.date}
        </text>
        <text x={width - padRight} y={height - 8} fill="#94a3b8" fontSize="10" textAnchor="end">
          {daily[daily.length - 1]?.date}
        </text>
        <text x={padLeft + 2} y={padTop + 10} fill="#94a3b8" fontSize="10">
          {maxY} {yLabel}
        </text>
      </svg>
      {hovered ? (
        <div className="mt-2 text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{hovered.date}</span>
          {" · "}
          {hovered.count} {yLabel}
        </div>
      ) : (
        <div className="mt-2 text-xs text-slate-500">Hover to inspect daily values.</div>
      )}
    </div>
  );
}

function TopicTrendExplorer({ topics }: { topics: TopicStat[] }) {
  const topTopics = topics.slice(0, 10);
  const [selectedTopics, setSelectedTopics] = useState<string[] | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 900;
  const height = 260;
  const padLeft = 40;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 34;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const resolvedSelectedTopics = useMemo(() => {
    const defaults = topTopics.slice(0, 3).map((topic) => topic.topic);
    const base = selectedTopics ?? defaults;
    const filtered = base.filter((name) => topTopics.some((topic) => topic.topic === name));
    if (filtered.length > 0) return filtered;
    return defaults;
  }, [selectedTopics, topTopics]);

  const days = topTopics[0]?.daily.map((d) => d.date) ?? [];
  const countsByTopic = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const topic of topTopics) {
      map.set(
        topic.topic,
        topic.daily.map((d) => d.count),
      );
    }
    return map;
  }, [topTopics]);

  const maxY = Math.max(
    1,
    ...resolvedSelectedTopics.flatMap((name) => countsByTopic.get(name) ?? []),
  );

  const hoveredDate = hoverIndex === null ? null : days[hoverIndex];

  if (topTopics.length === 0) {
    return <p className="text-sm text-slate-400">No topic trend data yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {topTopics.map((topic, index) => {
          const selected = resolvedSelectedTopics.includes(topic.topic);
          const color = CHART_COLORS[index % CHART_COLORS.length];
          return (
            <button
              key={topic.topic}
              onClick={() =>
                setSelectedTopics((prev) => {
                  const defaults = topTopics.slice(0, 3).map((item) => item.topic);
                  const base = (prev ?? defaults).filter((name) =>
                    topTopics.some((item) => item.topic === name),
                  );
                  return base.includes(topic.topic)
                    ? base.filter((name) => name !== topic.topic)
                    : [...base, topic.topic];
                })
              }
              className={`rounded-md border px-2.5 py-1 text-xs ${
                selected
                  ? "border-slate-200/40 text-slate-100"
                  : "border-slate-700 text-slate-400"
              }`}
              style={selected ? { backgroundColor: `${color}30` } : undefined}
            >
              {topic.topic}
            </button>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-64 w-full rounded-lg border border-slate-700/50 bg-slate-950/40"
        onMouseMove={(event) => {
          if (days.length === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left;
          const normalized = Math.min(Math.max(px / rect.width, 0), 1);
          const idx = Math.round(normalized * (days.length - 1));
          setHoverIndex(idx);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          stroke="#334155"
          strokeWidth={1}
        />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerHeight} stroke="#334155" strokeWidth={1} />
        {resolvedSelectedTopics.map((topicName) => {
          const topicIndex = topTopics.findIndex((topic) => topic.topic === topicName);
          const color = CHART_COLORS[topicIndex % CHART_COLORS.length];
          const topicCounts = countsByTopic.get(topicName) ?? [];
          const points = topicCounts.map((count, i) => ({
            x: padLeft + (i / Math.max(1, days.length - 1)) * innerWidth,
            y: padTop + innerHeight - (count / maxY) * innerHeight,
          }));
          return (
            <path
              key={topicName}
              d={toLinePath(points)}
              fill="none"
              stroke={color}
              strokeWidth={2.2}
              opacity={0.95}
            />
          );
        })}
        {hoverIndex !== null && days.length > 0 ? (
          <line
            x1={padLeft + (hoverIndex / Math.max(1, days.length - 1)) * innerWidth}
            y1={padTop}
            x2={padLeft + (hoverIndex / Math.max(1, days.length - 1)) * innerWidth}
            y2={padTop + innerHeight}
            stroke="#94a3b8"
            strokeOpacity={0.45}
            strokeDasharray="4 4"
          />
        ) : null}
        <text x={padLeft} y={height - 10} fill="#94a3b8" fontSize="10">
          {days[0]}
        </text>
        <text x={width - padRight} y={height - 10} fill="#94a3b8" fontSize="10" textAnchor="end">
          {days[days.length - 1]}
        </text>
        <text x={padLeft + 2} y={padTop + 10} fill="#94a3b8" fontSize="10">
          {maxY} msgs
        </text>
      </svg>
      {hoveredDate ? (
        <div className="space-y-1 text-xs text-slate-300">
          <div className="font-semibold text-slate-100">{hoveredDate}</div>
          {resolvedSelectedTopics.map((topicName) => {
            const topicIndex = topTopics.findIndex((topic) => topic.topic === topicName);
            const color = CHART_COLORS[topicIndex % CHART_COLORS.length];
            const count = countsByTopic.get(topicName)?.[hoverIndex ?? 0] ?? 0;
            return (
              <div key={topicName} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                <span>{topicName}</span>
                <span className="text-slate-400">{count}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-slate-500">Toggle topics, then hover to compare daily trend lines.</div>
      )}
    </div>
  );
}

function TopicRecurrenceMap({ topics }: { topics: TopicStat[] }) {
  const [hoveredTopic, setHoveredTopic] = useState<TopicStat | null>(null);
  const points = topics.slice(0, 30);
  const width = 900;
  const height = 250;
  const padLeft = 40;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 34;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const maxMessages = Math.max(1, ...points.map((topic) => topic.message_count));

  if (points.length === 0) {
    return <p className="text-sm text-slate-400">No recurrence data yet.</p>;
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full rounded-lg border border-slate-700/50 bg-slate-950/40">
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          stroke="#334155"
          strokeWidth={1}
        />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerHeight} stroke="#334155" strokeWidth={1} />
        {points.map((topic, idx) => {
          const x = padLeft + topic.recurrence_ratio * innerWidth;
          const y = padTop + innerHeight - (topic.message_count / maxMessages) * innerHeight;
          const radius = 4 + Math.sqrt(topic.message_count) * 0.35;
          const color = CHART_COLORS[idx % CHART_COLORS.length];
          return (
            <circle
              key={topic.topic}
              cx={x}
              cy={y}
              r={radius}
              fill={color}
              fillOpacity={hoveredTopic?.topic === topic.topic ? 0.95 : 0.5}
              stroke={hoveredTopic?.topic === topic.topic ? "#e2e8f0" : "none"}
              onMouseEnter={() => setHoveredTopic(topic)}
              onMouseLeave={() => setHoveredTopic(null)}
            />
          );
        })}
        <text x={padLeft} y={height - 10} fill="#94a3b8" fontSize="10">
          low recurrence
        </text>
        <text x={width - padRight} y={height - 10} fill="#94a3b8" fontSize="10" textAnchor="end">
          high recurrence
        </text>
        <text x={padLeft + 2} y={padTop + 10} fill="#94a3b8" fontSize="10">
          {maxMessages} msgs
        </text>
      </svg>
      {hoveredTopic ? (
        <div className="mt-2 text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{hoveredTopic.topic}</span>
          {" · "}
          {hoveredTopic.message_count} msgs
          {" · "}
          recurrence {Math.round(hoveredTopic.recurrence_ratio * 100)}%
          {" · "}
          {hoveredTopic.trend}
        </div>
      ) : (
        <div className="mt-2 text-xs text-slate-500">
          Hover bubbles to inspect topic recurrence and volume.
        </div>
      )}
    </div>
  );
}

function trendBadge(trend: TopicStat["trend"]): string {
  if (trend === "up") return "badge-hot";
  if (trend === "down") return "badge-archive";
  return "badge-cool";
}

function recurrenceBadge(level: TopicStat["recurrence_label"]): string {
  if (level === "high") return "badge-hot";
  if (level === "medium") return "badge-warm";
  return "badge-cool";
}

function maxCount(values: Array<{ count: number }>): number {
  return Math.max(1, ...values.map((v) => v.count));
}

type DayRange = 30 | 90 | 180 | 365 | "all";

export default function StatsPage() {
  const [days, setDays] = useState<DayRange>(90);
  const [stats, setStats] = useState<StatsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [topicDrilldown, setTopicDrilldown] = useState<TopicDrilldown | null>(null);
  const [topicInsights, setTopicInsights] = useState<TopicInsights | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/stats?days=${days}`)
      .then((r) => r.json())
      .then((data: { stats: StatsDashboard | null }) => {
        if (!active) return;
        setStats(data.stats);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setStats(null);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days]);

  const effectiveSelectedTopic = useMemo(() => {
    if (!stats || stats.topics.length === 0) return null;
    if (selectedTopic && stats.topics.some((topic) => topic.topic === selectedTopic)) {
      return selectedTopic;
    }
    return stats.topics[0].topic;
  }, [stats, selectedTopic]);

  useEffect(() => {
    if (!effectiveSelectedTopic) return;
    let active = true;
    fetch(`/api/stats/topic?topic=${encodeURIComponent(effectiveSelectedTopic)}&days=${days}`)
      .then((r) => r.json())
      .then((data: { drilldown: TopicDrilldown | null; insights: TopicInsights | null }) => {
        if (!active) return;
        setTopicDrilldown(data.drilldown);
        setTopicInsights(data.insights);
      })
      .catch(() => {
        if (!active) return;
        setTopicDrilldown(null);
        setTopicInsights(null);
      });
    return () => {
      active = false;
    };
  }, [effectiveSelectedTopic, days]);

  const generatedLabel = useMemo(() => {
    if (!stats) return "";
    return new Date(stats.generated_at).toLocaleString();
  }, [stats]);

  const activeDrilldown =
    topicDrilldown && topicDrilldown.topic === effectiveSelectedTopic
      ? topicDrilldown
      : null;
  const activeInsights = activeDrilldown ? topicInsights : null;

  if (loading) {
    return (
      <StatusPanel
        loading
        title="Loading stats"
        detail="Calculating user, channel, and topic trends."
      />
    );
  }

  if (!stats) {
    return (
      <StatusPanel
        title="Stats unavailable"
        detail="Could not load analytics right now. Try refreshing in a moment."
      />
    );
  }

  const scopeLabel =
    stats.scope.mode === "active_groups"
      ? `Scoped to ${stats.scope.active_group_count} currently tracked channels`
      : stats.scope.mode === "excluded_groups"
        ? `Scoped by exclusions (${stats.scope.excluded_groups.length} filtered names)`
        : "Using all channels in DB";

  return (
    <div className="space-y-6">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Stats & Trends
        </h1>
        <p className="vibe-subtitle">
          Activity by user, channel, and topic with lifecycle and recurrence over time.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {([30, 90, 180, 365, "all"] as DayRange[]).map((range) => (
          <button
            key={range}
            onClick={() => {
              if (range === days) return;
              setLoading(true);
              setDays(range);
            }}
            className={`rounded-md px-3 py-1.5 text-sm ${
              days === range ? "vibe-button" : "vibe-chip"
            }`}
          >
            {range === "all" ? "All" : `${range}d`}
          </button>
        ))}
        <span className="text-xs text-slate-400">Last computed: {generatedLabel}</span>
      </div>

      <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-100">
        {scopeLabel}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Messages</div>
          <div className="vibe-title mt-1 text-2xl">{stats.totals.messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Users</div>
          <div className="vibe-title mt-1 text-2xl">{stats.totals.users}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Channels</div>
          <div className="vibe-title mt-1 text-2xl">{stats.totals.channels}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Topics</div>
          <div className="vibe-title mt-1 text-2xl">{stats.totals.topics}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Avg relevance</div>
          <div className="vibe-title mt-1 text-2xl">
            {stats.totals.avg_relevance?.toFixed(2) ?? "n/a"}
          </div>
        </div>
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="vibe-title text-lg">Interactive Volume Trend</h2>
          <span className="text-xs text-slate-400">{stats.window_days} day window</span>
        </div>
        <InteractiveTimelineChart daily={stats.timeline} color="#22d3ee" yLabel="msgs" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Interactive Topic Trend Explorer</h2>
          <TopicTrendExplorer topics={stats.topics} />
        </div>
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Topic Recurrence Map</h2>
          <TopicRecurrenceMap topics={stats.topics} />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Top Users</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-slate-400">
                <tr>
                  <th className="pb-2 pr-3">User</th>
                  <th className="pb-2 pr-3">Msgs</th>
                  <th className="pb-2 pr-3">Active Days</th>
                  <th className="pb-2 pr-3">Avg Rel</th>
                  <th className="pb-2">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {stats.users.slice(0, 15).map((user) => (
                  <tr key={user.name} className="border-t border-slate-700/60">
                    <td className="py-2 pr-3 text-slate-200">{user.name}</td>
                    <td className="py-2 pr-3">{user.messages}</td>
                    <td className="py-2 pr-3">{user.active_days}</td>
                    <td className="py-2 pr-3">{user.avg_relevance?.toFixed(2) ?? "n/a"}</td>
                    <td className="py-2">{user.last_seen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Top Channels</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-slate-400">
                <tr>
                  <th className="pb-2 pr-3">Channel</th>
                  <th className="pb-2 pr-3">Msgs</th>
                  <th className="pb-2 pr-3">Active Days</th>
                  <th className="pb-2 pr-3">Avg Rel</th>
                  <th className="pb-2">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {stats.channels.slice(0, 15).map((channel) => (
                  <tr key={channel.name} className="border-t border-slate-700/60">
                    <td className="py-2 pr-3 text-slate-200">{channel.name}</td>
                    <td className="py-2 pr-3">{channel.messages}</td>
                    <td className="py-2 pr-3">{channel.active_days}</td>
                    <td className="py-2 pr-3">
                      {channel.avg_relevance?.toFixed(2) ?? "n/a"}
                    </td>
                    <td className="py-2">{channel.last_seen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <h2 className="vibe-title mb-3 text-lg">Topic Lifecycle & Recurrence</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="pb-2 pr-3">Topic</th>
                <th className="pb-2 pr-3">Started (Ever)</th>
                <th className="pb-2 pr-3">Started (Window)</th>
                <th className="pb-2 pr-3">Last Seen</th>
                <th className="pb-2 pr-3">Msgs</th>
                <th className="pb-2 pr-3">Active Days</th>
                <th className="pb-2 pr-3">Recur</th>
                <th className="pb-2 pr-3">Trend</th>
                <th className="pb-2 pr-3">Peak Cycle</th>
                <th className="pb-2">Timeline</th>
              </tr>
            </thead>
            <tbody>
              {stats.topics.map((topic) => (
                <tr key={topic.topic} className="border-t border-slate-700/60">
                  <td className="py-2 pr-3 text-slate-200">
                    <button
                      onClick={() => setSelectedTopic(topic.topic)}
                      className={`rounded px-2 py-0.5 text-left text-sm ${
                        effectiveSelectedTopic === topic.topic
                          ? "bg-cyan-400/20 text-cyan-100"
                          : "hover:bg-slate-800/70"
                      }`}
                    >
                      {topic.topic}
                    </button>
                  </td>
                  <td className="py-2 pr-3">{topic.started_on}</td>
                  <td className="py-2 pr-3">{topic.started_in_window}</td>
                  <td className="py-2 pr-3">{topic.last_seen}</td>
                  <td className="py-2 pr-3">{topic.message_count}</td>
                  <td className="py-2 pr-3">
                    {topic.active_days}/{topic.span_days}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${recurrenceBadge(topic.recurrence_label)}`}>
                      {topic.recurrence_label} ({Math.round(topic.recurrence_ratio * 100)}%)
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${trendBadge(topic.trend)}`}>
                      {topic.trend} ({topic.last_7d}/{topic.prev_7d})
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-300">
                    {topic.peak_weekday} @ {String(topic.peak_hour).padStart(2, "0")}:00
                  </td>
                  <td className="py-2">
                    <Sparkline daily={topic.daily} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="vibe-title text-lg">Topic Drilldown</h2>
          <span className="text-xs text-slate-400">
            {effectiveSelectedTopic ? `Selected: ${effectiveSelectedTopic}` : "Select a topic above"}
          </span>
        </div>

        {effectiveSelectedTopic && !activeDrilldown ? (
          <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 px-3 py-2 text-sm text-slate-300">
            Loading topic insights...
          </div>
        ) : !activeDrilldown ? (
          <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 px-3 py-2 text-sm text-slate-400">
            Choose a topic from the lifecycle table to open deep analysis.
          </div>
        ) : (
          <div className="space-y-5">
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <div className="text-xs text-slate-400">Messages</div>
                <div className="mt-1 text-xl font-semibold text-slate-100">
                  {activeDrilldown.summary.message_count}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <div className="text-xs text-slate-400">Active Days</div>
                <div className="mt-1 text-xl font-semibold text-slate-100">
                  {activeDrilldown.summary.active_days}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <div className="text-xs text-slate-400">First Seen</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {activeDrilldown.summary.first_seen}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <div className="text-xs text-slate-400">Last Seen</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {activeDrilldown.summary.last_seen}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3">
                <div className="text-xs text-slate-400">Recurrence</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {Math.round(activeDrilldown.summary.recurrence_ratio * 100)}%
                  {" · "}
                  {activeDrilldown.summary.trend}
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Topic Volume Over Time</h3>
              <InteractiveTimelineChart daily={activeDrilldown.timeline} color="#34d399" yLabel="topic msgs" />
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">Top Users In Topic</h3>
                <div className="space-y-1 text-sm">
                  {activeDrilldown.top_users.map((user) => (
                    <div key={user.name} className="flex justify-between gap-3">
                      <span className="text-slate-200">{user.name}</span>
                      <span className="text-slate-400">{user.messages}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">Top Channels In Topic</h3>
                <div className="space-y-1 text-sm">
                  {activeDrilldown.top_channels.map((channel) => (
                    <div key={channel.name} className="flex justify-between gap-3">
                      <span className="text-slate-200">{channel.name}</span>
                      <span className="text-slate-400">{channel.messages}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {activeInsights ? (
              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/5 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-cyan-100">Summary</h3>
                  <p className="text-sm leading-relaxed text-slate-100">{activeInsights.summary}</p>
                </div>
                <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-emerald-100">Guidance</h3>
                  <ul className="space-y-1 text-sm text-slate-100">
                    {activeInsights.guidance.map((item, idx) => (
                      <li key={`${item}-${idx}`} className="list-disc pl-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-amber-100">Watch-outs</h3>
                  <ul className="space-y-1 text-sm text-slate-100">
                    {activeInsights.watchouts.map((item, idx) => (
                      <li key={`${item}-${idx}`} className="list-disc pl-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-lg border border-fuchsia-400/30 bg-fuchsia-400/5 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-fuchsia-100">Next Questions</h3>
                  <ul className="space-y-1 text-sm text-slate-100">
                    {activeInsights.next_questions.map((item, idx) => (
                      <li key={`${item}-${idx}`} className="list-disc pl-1">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            ) : null}

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Related Topics</h3>
              <div className="flex flex-wrap gap-2">
                {activeDrilldown.related_topics.map((edge) => (
                  <button
                    key={`${edge.topic_a}-${edge.topic_b}`}
                    onClick={() => setSelectedTopic(edge.topic_b)}
                    className="rounded-md border border-slate-700 bg-slate-900/50 px-2.5 py-1 text-xs text-slate-200 hover:border-cyan-300/60"
                  >
                    {edge.topic_b} · {edge.co_messages}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Recent Messages</h3>
              <div className="space-y-2">
                {activeDrilldown.recent_messages.slice(0, 18).map((message) => (
                  <div
                    key={message.id}
                    className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3"
                  >
                    <div className="mb-1 text-xs text-slate-400">
                      {message.date} · {message.room_name} · {message.sender_name}
                    </div>
                    <p className="text-sm text-slate-200">{message.body}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <h2 className="vibe-title mb-3 text-lg">Topic Co-occurrence Graph (Edges)</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="pb-2 pr-3">Topic A</th>
                <th className="pb-2 pr-3">Topic B</th>
                <th className="pb-2 pr-3">Co-Msgs</th>
                <th className="pb-2 pr-3">Overlap</th>
                <th className="pb-2 pr-3">Jaccard</th>
                <th className="pb-2 pr-3">Trend</th>
                <th className="pb-2">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.cooccurrence.map((edge) => (
                <tr key={`${edge.topic_a}-${edge.topic_b}`} className="border-t border-slate-700/60">
                  <td className="py-2 pr-3 text-slate-200">{edge.topic_a}</td>
                  <td className="py-2 pr-3 text-slate-200">{edge.topic_b}</td>
                  <td className="py-2 pr-3">{edge.co_messages}</td>
                  <td className="py-2 pr-3">{Math.round(edge.overlap_ratio * 100)}%</td>
                  <td className="py-2 pr-3">{Math.round(edge.jaccard * 100)}%</td>
                  <td className="py-2 pr-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${trendBadge(edge.trend)}`}>
                      {edge.trend}
                    </span>
                  </td>
                  <td className="py-2">{edge.last_seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Weekly Seasonality</h2>
          <div className="space-y-2">
            {(() => {
              const max = maxCount(stats.seasonality.by_weekday);
              return stats.seasonality.by_weekday.map((item) => (
                <div key={item.weekday} className="flex items-center gap-3">
                  <span className="w-10 text-xs text-slate-300">{item.weekday}</span>
                  <div className="h-2 flex-1 rounded bg-slate-800">
                    <div
                      className="h-2 rounded bg-cyan-400/85"
                      style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs text-slate-400">{item.count}</span>
                </div>
              ));
            })()}
          </div>
        </div>

        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Hourly Seasonality</h2>
          <div className="grid grid-cols-12 gap-1">
            {(() => {
              const max = maxCount(stats.seasonality.by_hour);
              return stats.seasonality.by_hour.map((item) => (
                <div key={item.hour} className="flex flex-col items-center gap-1">
                  <div
                    className="w-3 rounded-sm bg-emerald-400/80"
                    style={{ height: `${Math.max(8, (item.count / max) * 64)}px` }}
                    title={`${String(item.hour).padStart(2, "0")}:00 — ${item.count}`}
                  />
                  <span className="text-[10px] text-slate-400">
                    {String(item.hour).padStart(2, "0")}
                  </span>
                </div>
              ));
            })()}
          </div>
        </div>
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <h2 className="vibe-title mb-3 text-lg">Topic Seasonality Peaks</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-slate-400">
              <tr>
                <th className="pb-2 pr-3">Topic</th>
                <th className="pb-2 pr-3">Msgs</th>
                <th className="pb-2 pr-3">Peak Weekday</th>
                <th className="pb-2">Peak Hour</th>
              </tr>
            </thead>
            <tbody>
              {stats.seasonality.topic_peaks.map((peak) => (
                <tr key={peak.topic} className="border-t border-slate-700/60">
                  <td className="py-2 pr-3 text-slate-200">{peak.topic}</td>
                  <td className="py-2 pr-3">{peak.messages}</td>
                  <td className="py-2 pr-3">{peak.peak_weekday}</td>
                  <td className="py-2">{String(peak.peak_hour).padStart(2, "0")}:00</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
