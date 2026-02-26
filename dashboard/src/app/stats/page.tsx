"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

interface RelationshipNode {
  id: string;
  messages: number;
  channels: number;
  replies_out: number;
  replies_in: number;
  dm_signals: number;
  top_topics: string[];
}

interface RelationshipEdge {
  source: string;
  target: string;
  weight: number;
  replies: number;
  mentions: number;
  dm_signals: number;
  turns: number;
}

interface TopicAlignmentEdge {
  source: string;
  target: string;
  similarity: number;
  overlap_count: number;
  shared_topics: string[];
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
  network: {
    relationships: {
      nodes: RelationshipNode[];
      edges: RelationshipEdge[];
      summaries: {
        included_nodes: number;
        total_users_in_window: number;
        total_messages: number;
        directed_edges: number;
        dm_signal_messages: number;
      };
    };
    topic_alignment: {
      nodes: RelationshipNode[];
      edges: TopicAlignmentEdge[];
      summaries: {
        included_nodes: number;
        compared_nodes: number;
        alignment_edges: number;
      };
    };
  };
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

interface TopicHopLink {
  topic: string;
  co_messages: number;
  jaccard: number;
  trend: TopicCooccurrence["trend"];
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

function TopicTrendExplorer({
  topics,
  onTopicDrilldown,
}: {
  topics: TopicStat[];
  onTopicDrilldown?: (topic: string) => void;
}) {
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
              onDoubleClick={() => onTopicDrilldown?.(topic.topic)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                selected
                  ? "border-slate-200/40 text-slate-100"
                  : "border-slate-700 text-slate-400"
              }`}
              title="Click to compare, double-click to open drilldown"
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
      {onTopicDrilldown ? (
        <div className="flex flex-wrap gap-2">
          {topTopics.slice(0, 8).map((topic) => (
            <button
              key={`${topic.topic}-drill`}
              onClick={() => onTopicDrilldown(topic.topic)}
              className="rounded border border-slate-700/70 bg-slate-900/40 px-2 py-1 text-xs text-slate-200 hover:border-cyan-300/60"
            >
              Drill down: {topic.topic}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TopicRecurrenceMap({
  topics,
  onTopicDrilldown,
}: {
  topics: TopicStat[];
  onTopicDrilldown?: (topic: string) => void;
}) {
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
              onClick={() => onTopicDrilldown?.(topic.topic)}
              style={onTopicDrilldown ? { cursor: "pointer" } : undefined}
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
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <span>
            <span className="font-semibold text-slate-100">{hoveredTopic.topic}</span>
            {" · "}
            {hoveredTopic.message_count} msgs
            {" · "}
            recurrence {Math.round(hoveredTopic.recurrence_ratio * 100)}%
            {" · "}
            {hoveredTopic.trend}
          </span>
          {onTopicDrilldown ? (
            <button
              onClick={() => onTopicDrilldown(hoveredTopic.topic)}
              className="rounded border border-slate-700/70 bg-slate-900/40 px-2 py-0.5 text-xs text-slate-200 hover:border-cyan-300/60"
            >
              Open drilldown
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 text-xs text-slate-500">
          Hover bubbles to inspect recurrence and click a bubble to open drilldown.
        </div>
      )}
    </div>
  );
}

function topicNodeColor(trend: TopicCooccurrence["trend"] | "focus" | "neutral"): string {
  if (trend === "focus") return "#22d3ee";
  if (trend === "up") return "#34d399";
  if (trend === "down") return "#f87171";
  return "#60a5fa";
}

function TopicGraphNavigator({
  focusTopic,
  topics,
  edges,
  onSelectTopic,
}: {
  focusTopic: string | null;
  topics: TopicStat[];
  edges: TopicCooccurrence[];
  onSelectTopic: (topic: string) => void;
}) {
  const [hoveredTopic, setHoveredTopic] = useState<string | null>(null);

  const topicStatsByName = useMemo(
    () => new Map(topics.map((topic) => [topic.topic, topic])),
    [topics],
  );

  const adjacency = useMemo(() => {
    const map = new Map<string, TopicHopLink[]>();
    for (const edge of edges) {
      const left = map.get(edge.topic_a) ?? [];
      left.push({
        topic: edge.topic_b,
        co_messages: edge.co_messages,
        jaccard: edge.jaccard,
        trend: edge.trend,
      });
      map.set(edge.topic_a, left);

      const right = map.get(edge.topic_b) ?? [];
      right.push({
        topic: edge.topic_a,
        co_messages: edge.co_messages,
        jaccard: edge.jaccard,
        trend: edge.trend,
      });
      map.set(edge.topic_b, right);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (b.co_messages !== a.co_messages) return b.co_messages - a.co_messages;
        return b.jaccard - a.jaccard;
      });
    }
    return map;
  }, [edges]);

  const graph = useMemo(() => {
    if (!focusTopic) return null;
    const ring1 = (adjacency.get(focusTopic) ?? []).slice(0, 8);
    const ring1Set = new Set(ring1.map((item) => item.topic));
    const ring2Map = new Map<string, TopicHopLink & { parent: string }>();

    for (const firstHop of ring1) {
      const secondary = adjacency.get(firstHop.topic) ?? [];
      for (const secondHop of secondary) {
        if (secondHop.topic === focusTopic || ring1Set.has(secondHop.topic)) continue;
        const scored = secondHop.co_messages * 0.75 + secondHop.jaccard * 100 * 0.25;
        const prev = ring2Map.get(secondHop.topic);
        const prevScore =
          prev === undefined
            ? Number.NEGATIVE_INFINITY
            : prev.co_messages * 0.75 + prev.jaccard * 100 * 0.25;
        if (scored > prevScore) {
          ring2Map.set(secondHop.topic, { ...secondHop, parent: firstHop.topic });
        }
      }
    }

    const ring2 = Array.from(ring2Map.values())
      .sort((a, b) => {
        if (b.co_messages !== a.co_messages) return b.co_messages - a.co_messages;
        return b.jaccard - a.jaccard;
      })
      .slice(0, 12);

    return { ring1, ring2 };
  }, [focusTopic, adjacency]);

  if (!focusTopic || !graph) {
    return (
      <p className="text-sm text-slate-400">
        Select a topic to open graph navigation and hop across adjacent discussions.
      </p>
    );
  }

  const width = 900;
  const height = 460;
  const centerX = width / 2;
  const centerY = 210;
  const ring1Radius = 130;
  const ring2Radius = 220;

  const ring1Nodes = graph.ring1.map((item, index) => {
    const angle = (-Math.PI / 2) + (index / Math.max(1, graph.ring1.length)) * Math.PI * 2;
    return {
      ...item,
      x: centerX + Math.cos(angle) * ring1Radius,
      y: centerY + Math.sin(angle) * ring1Radius,
      angle,
    };
  });

  const ring1AngleByTopic = new Map(ring1Nodes.map((node) => [node.topic, node.angle]));
  const ring2Groups = new Map<string, Array<TopicHopLink & { parent: string }>>();
  for (const node of graph.ring2) {
    const bucket = ring2Groups.get(node.parent) ?? [];
    bucket.push(node);
    ring2Groups.set(node.parent, bucket);
  }

  const ring2Nodes = Array.from(ring2Groups.entries()).flatMap(([parent, nodes]) => {
    const baseAngle = ring1AngleByTopic.get(parent) ?? -Math.PI / 2;
    const spread = Math.min(Math.PI / 2, 0.26 * Math.max(1, nodes.length));
    return nodes.map((node, index) => {
      const t =
        nodes.length === 1 ? 0 : -spread / 2 + (index / (nodes.length - 1)) * spread;
      const angle = baseAngle + t;
      return {
        ...node,
        x: centerX + Math.cos(angle) * ring2Radius,
        y: centerY + Math.sin(angle) * ring2Radius,
      };
    });
  });

  const maxCo = Math.max(
    1,
    ...ring1Nodes.map((node) => node.co_messages),
    ...ring2Nodes.map((node) => node.co_messages),
  );

  const hoverTopic = hoveredTopic ?? focusTopic;
  const hoverStats = topicStatsByName.get(hoverTopic);
  const hoverAdjacency = adjacency.get(hoverTopic) ?? [];

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[26rem] w-full rounded-lg border border-slate-700/50 bg-slate-950/40"
      >
        <circle cx={centerX} cy={centerY} r={ring1Radius} fill="none" stroke="#1e293b" strokeDasharray="3 5" />
        <circle cx={centerX} cy={centerY} r={ring2Radius} fill="none" stroke="#1e293b" strokeDasharray="3 5" />

        {ring1Nodes.map((node) => (
          <line
            key={`edge-core-${node.topic}`}
            x1={centerX}
            y1={centerY}
            x2={node.x}
            y2={node.y}
            stroke="#334155"
            strokeWidth={1 + (node.co_messages / maxCo) * 4}
            strokeOpacity={0.65}
          />
        ))}

        {ring2Nodes.map((node) => {
          const parent = ring1Nodes.find((first) => first.topic === node.parent);
          if (!parent) return null;
          return (
            <line
              key={`edge-outer-${node.parent}-${node.topic}`}
              x1={parent.x}
              y1={parent.y}
              x2={node.x}
              y2={node.y}
              stroke="#475569"
              strokeDasharray="4 4"
              strokeWidth={0.8 + (node.co_messages / maxCo) * 2.6}
              strokeOpacity={0.55}
            />
          );
        })}

        <g
          onMouseEnter={() => setHoveredTopic(focusTopic)}
          onMouseLeave={() => setHoveredTopic(null)}
          onClick={() => onSelectTopic(focusTopic)}
          style={{ cursor: "pointer" }}
        >
          <circle
            cx={centerX}
            cy={centerY}
            r={20}
            fill={topicNodeColor("focus")}
            fillOpacity={0.3}
            stroke={topicNodeColor("focus")}
            strokeWidth={2}
          />
          <text
            x={centerX}
            y={centerY + 4}
            textAnchor="middle"
            className="fill-slate-100 text-[11px] font-semibold"
          >
            focus
          </text>
        </g>

        {ring1Nodes.map((node) => {
          const messages = topicStatsByName.get(node.topic)?.message_count ?? 0;
          const radius = 8 + Math.sqrt(messages) * 0.28;
          const isHovered = hoveredTopic === node.topic;
          return (
            <g
              key={`node-ring1-${node.topic}`}
              onMouseEnter={() => setHoveredTopic(node.topic)}
              onMouseLeave={() => setHoveredTopic(null)}
              onClick={() => onSelectTopic(node.topic)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                fill={topicNodeColor(node.trend)}
                fillOpacity={isHovered ? 0.95 : 0.65}
                stroke={isHovered ? "#e2e8f0" : "#0f172a"}
                strokeWidth={isHovered ? 1.8 : 1}
              />
              <text
                x={node.x}
                y={node.y + radius + 12}
                textAnchor="middle"
                className="fill-slate-300 text-[10px]"
              >
                {node.topic}
              </text>
            </g>
          );
        })}

        {ring2Nodes.map((node) => {
          const messages = topicStatsByName.get(node.topic)?.message_count ?? 0;
          const radius = 6 + Math.sqrt(messages) * 0.2;
          const isHovered = hoveredTopic === node.topic;
          return (
            <g
              key={`node-ring2-${node.topic}`}
              onMouseEnter={() => setHoveredTopic(node.topic)}
              onMouseLeave={() => setHoveredTopic(null)}
              onClick={() => onSelectTopic(node.topic)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={node.x}
                cy={node.y}
                r={radius}
                fill={topicNodeColor(node.trend)}
                fillOpacity={isHovered ? 0.85 : 0.5}
                stroke={isHovered ? "#cbd5e1" : "#0f172a"}
                strokeWidth={isHovered ? 1.6 : 1}
              />
              {isHovered ? (
                <text
                  x={node.x}
                  y={node.y + radius + 12}
                  textAnchor="middle"
                  className="fill-slate-300 text-[10px]"
                >
                  {node.topic}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3 text-xs text-slate-300">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">Hover:</span>
          <span className="font-semibold text-slate-100">{hoverTopic}</span>
          {hoverStats ? <span>{hoverStats.message_count} msgs</span> : null}
          <span>{hoverAdjacency.length} adjacent topics</span>
        </div>
        <p className="mt-1 text-slate-400">
          Click any node to jump focus and continue traversing adjacent discussions.
        </p>
      </div>
    </div>
  );
}

type PeopleNetworkMode = "relationships" | "alignment";

type EdgeWithMetric = {
  source: string;
  target: string;
  metric: number;
  detail: RelationshipEdge | TopicAlignmentEdge;
};

type UndirectedEdge = {
  source: string;
  target: string;
  metric: number;
};

type NetworkCluster = {
  id: string;
  color: string;
  nodeIds: string[];
  size: number;
  messageTotal: number;
  internalWeight: number;
  externalWeight: number;
  topMembers: string[];
};

const NETWORK_CLUSTER_COLORS = [
  "#06b6d4",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#10b981",
  "#84cc16",
  "#f97316",
  "#0ea5e9",
  "#f43f5e",
  "#14b8a6",
];
const NETWORK_EDGE_NEUTRAL = "#94a3b8";
const NETWORK_MIN_ZOOM = 0.45;
const NETWORK_MAX_ZOOM = 3.5;

function PeopleNetworkGraph({ network }: { network: StatsDashboard["network"] }) {
  const [mode, setMode] = useState<PeopleNetworkMode>("relationships");
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [focusedNode, setFocusedNode] = useState<string | null>(null);
  const [personInput, setPersonInput] = useState("");
  const [minRelationshipWeight, setMinRelationshipWeight] = useState(2.8);
  const [minAlignmentSimilarity, setMinAlignmentSimilarity] = useState(0.56);
  const [neighborLimit, setNeighborLimit] = useState(60);
  const [showNeighborEdges, setShowNeighborEdges] = useState(false);
  const [hideIsolated, setHideIsolated] = useState(true);
  const [showCrossClusterEdges, setShowCrossClusterEdges] = useState(false);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [physicsPositions, setPhysicsPositions] = useState<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const panDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const physicsRef = useRef<
    Map<
      string,
      {
        id: string;
        x: number;
        y: number;
        vx: number;
        vy: number;
        anchorX: number;
        anchorY: number;
        radius: number;
      }
    >
  >(new Map());

  const isRelationship = mode === "relationships";
  const baseNodes = isRelationship
    ? network.relationships.nodes
    : network.topic_alignment.nodes;
  const baseEdges = isRelationship
    ? network.relationships.edges
    : network.topic_alignment.edges;

  const sortedNodes = useMemo(
    () => [...baseNodes].sort((a, b) => b.messages - a.messages),
    [baseNodes],
  );
  const nodeById = useMemo(
    () => new Map(sortedNodes.map((node) => [node.id, node])),
    [sortedNodes],
  );

  const threshold = isRelationship ? minRelationshipWeight : minAlignmentSimilarity;

  const weightedEdges = useMemo<EdgeWithMetric[]>(() => {
    if (isRelationship) {
      return (baseEdges as RelationshipEdge[])
        .map((edge) => ({
          source: edge.source,
          target: edge.target,
          metric: edge.weight,
          detail: edge,
        }))
        .filter((edge) => edge.metric >= threshold);
    }
    return (baseEdges as TopicAlignmentEdge[])
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        metric: edge.similarity,
        detail: edge,
      }))
      .filter((edge) => edge.metric >= threshold);
  }, [baseEdges, isRelationship, threshold]);

  const degreeWeightByNode = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of weightedEdges) {
      map.set(edge.source, (map.get(edge.source) || 0) + edge.metric);
      map.set(edge.target, (map.get(edge.target) || 0) + edge.metric);
    }
    return map;
  }, [weightedEdges]);

  const connectedNodeSet = useMemo(() => {
    const set = new Set<string>();
    for (const edge of weightedEdges) {
      set.add(edge.source);
      set.add(edge.target);
    }
    return set;
  }, [weightedEdges]);

  const adjacency = useMemo(() => {
    const map = new Map<string, EdgeWithMetric[]>();
    for (const edge of weightedEdges) {
      const left = map.get(edge.source) ?? [];
      left.push(edge);
      map.set(edge.source, left);

      const right = map.get(edge.target) ?? [];
      right.push(edge);
      map.set(edge.target, right);
    }
    for (const edges of map.values()) {
      edges.sort((a, b) => b.metric - a.metric);
    }
    return map;
  }, [weightedEdges]);

  const undirectedEdges = useMemo<UndirectedEdge[]>(() => {
    const merged = new Map<string, UndirectedEdge>();
    for (const edge of weightedEdges) {
      const [source, target] =
        edge.source.localeCompare(edge.target) <= 0
          ? [edge.source, edge.target]
          : [edge.target, edge.source];
      const key = `${source}||${target}`;
      const existing = merged.get(key);
      if (existing) {
        existing.metric = Number((existing.metric + edge.metric).toFixed(3));
      } else {
        merged.set(key, { source, target, metric: edge.metric });
      }
    }
    return Array.from(merged.values()).sort((a, b) => b.metric - a.metric);
  }, [weightedEdges]);

  const undirectedAdjacency = useMemo(() => {
    const map = new Map<string, Array<{ other: string; metric: number }>>();
    for (const edge of undirectedEdges) {
      const left = map.get(edge.source) ?? [];
      left.push({ other: edge.target, metric: edge.metric });
      map.set(edge.source, left);

      const right = map.get(edge.target) ?? [];
      right.push({ other: edge.source, metric: edge.metric });
      map.set(edge.target, right);
    }
    for (const neighbors of map.values()) {
      neighbors.sort((a, b) => b.metric - a.metric);
    }
    return map;
  }, [undirectedEdges]);

  const community = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of sortedNodes) {
      labels.set(node.id, node.id);
    }

    const orderedNodes = [...sortedNodes].sort((a, b) => {
      const degreeA = degreeWeightByNode.get(a.id) || 0;
      const degreeB = degreeWeightByNode.get(b.id) || 0;
      if (degreeB !== degreeA) return degreeB - degreeA;
      return b.messages - a.messages;
    });

    for (let iteration = 0; iteration < 18; iteration += 1) {
      let changed = 0;
      for (const node of orderedNodes) {
        const neighbors = undirectedAdjacency.get(node.id) ?? [];
        if (neighbors.length === 0) continue;

        const scoreByLabel = new Map<string, number>();
        for (const neighbor of neighbors) {
          const label = labels.get(neighbor.other) ?? neighbor.other;
          scoreByLabel.set(label, (scoreByLabel.get(label) || 0) + neighbor.metric);
        }

        let bestLabel = labels.get(node.id) ?? node.id;
        let bestScore = -1;
        for (const [label, score] of scoreByLabel.entries()) {
          if (score > bestScore + 1e-9) {
            bestScore = score;
            bestLabel = label;
          } else if (Math.abs(score - bestScore) <= 1e-9 && label < bestLabel) {
            bestLabel = label;
          }
        }

        if (bestLabel !== labels.get(node.id)) {
          labels.set(node.id, bestLabel);
          changed += 1;
        }
      }
      if (changed === 0) break;
    }

    const groups = new Map<string, string[]>();
    for (const node of sortedNodes) {
      const label = labels.get(node.id) ?? node.id;
      const members = groups.get(label) ?? [];
      members.push(node.id);
      groups.set(label, members);
    }

    const groupedMembers = Array.from(groups.values()).sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      const sumA = a.reduce((sum, nodeId) => sum + (nodeById.get(nodeId)?.messages || 0), 0);
      const sumB = b.reduce((sum, nodeId) => sum + (nodeById.get(nodeId)?.messages || 0), 0);
      return sumB - sumA;
    });

    const clusterByNode = new Map<string, string>();
    const colorByCluster = new Map<string, string>();
    const clusters: NetworkCluster[] = groupedMembers.map((members, index) => {
      const id = `c${index + 1}`;
      const color = NETWORK_CLUSTER_COLORS[index % NETWORK_CLUSTER_COLORS.length];
      for (const member of members) clusterByNode.set(member, id);
      colorByCluster.set(id, color);

      const sortedMembers = [...members].sort((left, right) => {
        const leftMessages = nodeById.get(left)?.messages || 0;
        const rightMessages = nodeById.get(right)?.messages || 0;
        return rightMessages - leftMessages;
      });

      return {
        id,
        color,
        nodeIds: members,
        size: members.length,
        messageTotal: members.reduce(
          (sum, member) => sum + (nodeById.get(member)?.messages || 0),
          0,
        ),
        internalWeight: 0,
        externalWeight: 0,
        topMembers: sortedMembers.slice(0, 3),
      };
    });

    const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    for (const edge of undirectedEdges) {
      const sourceClusterId = clusterByNode.get(edge.source);
      const targetClusterId = clusterByNode.get(edge.target);
      if (!sourceClusterId || !targetClusterId) continue;
      if (sourceClusterId === targetClusterId) {
        const cluster = clusterById.get(sourceClusterId);
        if (cluster) cluster.internalWeight += edge.metric;
      } else {
        const sourceCluster = clusterById.get(sourceClusterId);
        const targetCluster = clusterById.get(targetClusterId);
        if (sourceCluster) sourceCluster.externalWeight += edge.metric;
        if (targetCluster) targetCluster.externalWeight += edge.metric;
      }
    }

    for (const cluster of clusters) {
      cluster.internalWeight = Number(cluster.internalWeight.toFixed(2));
      cluster.externalWeight = Number(cluster.externalWeight.toFixed(2));
    }

    return { clusters, clusterByNode, colorByCluster };
  }, [sortedNodes, degreeWeightByNode, undirectedAdjacency, nodeById, undirectedEdges]);

  const clusterById = useMemo(
    () => new Map(community.clusters.map((cluster) => [cluster.id, cluster])),
    [community.clusters],
  );

  const resolvedSelectedClusterId =
    selectedClusterId && clusterById.has(selectedClusterId) ? selectedClusterId : null;
  const resolvedFocus = focusedNode && nodeById.has(focusedNode) ? focusedNode : null;
  const personQuery = personInput.trim().toLowerCase();
  const peopleSearchResults = useMemo(() => {
    if (!personQuery) return [] as RelationshipNode[];
    const tokens = personQuery.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return [] as RelationshipNode[];
    return sortedNodes
      .filter((node) => {
        const haystack = node.id.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      })
      .sort((left, right) => {
        const leftName = left.id.toLowerCase();
        const rightName = right.id.toLowerCase();
        const leftPrefix = leftName.startsWith(personQuery) ? 1 : 0;
        const rightPrefix = rightName.startsWith(personQuery) ? 1 : 0;
        if (rightPrefix !== leftPrefix) return rightPrefix - leftPrefix;
        const leftDegree = degreeWeightByNode.get(left.id) || 0;
        const rightDegree = degreeWeightByNode.get(right.id) || 0;
        if (rightDegree !== leftDegree) return rightDegree - leftDegree;
        return right.messages - left.messages;
      });
  }, [personQuery, sortedNodes, degreeWeightByNode]);

  const baseVisibleNodes = useMemo(() => {
    let visibleNodes = sortedNodes;
    if (hideIsolated) {
      visibleNodes = visibleNodes.filter((node) => connectedNodeSet.has(node.id));
    }
    if (resolvedSelectedClusterId) {
      visibleNodes = visibleNodes.filter(
        (node) => community.clusterByNode.get(node.id) === resolvedSelectedClusterId,
      );
    }
    return visibleNodes;
  }, [
    sortedNodes,
    hideIsolated,
    connectedNodeSet,
    resolvedSelectedClusterId,
    community.clusterByNode,
  ]);
  const baseVisibleNodeSet = useMemo(
    () => new Set(baseVisibleNodes.map((node) => node.id)),
    [baseVisibleNodes],
  );

  const displayedNodeIds = useMemo(() => {
    if (!resolvedFocus) {
      if (personQuery) {
        if (peopleSearchResults.length === 0) return new Set<string>();
        const filteredSet = new Set<string>();
        const matchLimit = 16;
        const perMatchNeighborLimit = 8;
        const matches = peopleSearchResults.slice(0, matchLimit);
        for (const match of matches) {
          if (!baseVisibleNodeSet.has(match.id)) continue;
          filteredSet.add(match.id);
          const neighbors = adjacency.get(match.id) ?? [];
          let added = 0;
          for (const edge of neighbors) {
            const other = edge.source === match.id ? edge.target : edge.source;
            if (!baseVisibleNodeSet.has(other)) continue;
            filteredSet.add(other);
            added += 1;
            if (added >= perMatchNeighborLimit) break;
          }
        }
        return filteredSet;
      }
      return new Set(baseVisibleNodes.map((node) => node.id));
    }
    const neighborEdges = adjacency.get(resolvedFocus) ?? [];
    const neighborSet = new Set<string>();
    for (const edge of neighborEdges) {
      const other = edge.source === resolvedFocus ? edge.target : edge.source;
      if (!baseVisibleNodeSet.has(other)) continue;
      neighborSet.add(other);
      if (neighborSet.size >= neighborLimit) break;
    }
    const focusedSet = new Set<string>();
    if (baseVisibleNodeSet.has(resolvedFocus)) focusedSet.add(resolvedFocus);
    for (const neighbor of neighborSet) {
      focusedSet.add(neighbor);
    }
    return focusedSet;
  }, [
    resolvedFocus,
    personQuery,
    peopleSearchResults,
    baseVisibleNodes,
    baseVisibleNodeSet,
    adjacency,
    neighborLimit,
  ]);

  const displayedNodes = useMemo(
    () => sortedNodes.filter((node) => displayedNodeIds.has(node.id)),
    [sortedNodes, displayedNodeIds],
  );
  const displayedNodeSet = useMemo(
    () => new Set(displayedNodes.map((node) => node.id)),
    [displayedNodes],
  );

  const displayedEdges = useMemo(() => {
    const scoped = weightedEdges.filter((edge) => {
      if (!displayedNodeSet.has(edge.source) || !displayedNodeSet.has(edge.target)) return false;
      if (!resolvedFocus) {
        if (showCrossClusterEdges) return true;
        const sourceCluster = community.clusterByNode.get(edge.source);
        const targetCluster = community.clusterByNode.get(edge.target);
        return sourceCluster !== undefined && sourceCluster === targetCluster;
      }
      if (edge.source === resolvedFocus || edge.target === resolvedFocus) return true;
      return showNeighborEdges;
    });
    const limit = resolvedFocus ? (showNeighborEdges ? 900 : 450) : 1800;
    return [...scoped].sort((a, b) => b.metric - a.metric).slice(0, limit);
  }, [
    weightedEdges,
    displayedNodeSet,
    resolvedFocus,
    showNeighborEdges,
    showCrossClusterEdges,
    community.clusterByNode,
  ]);

  const baseMaxMessages = useMemo(
    () => Math.max(1, ...baseVisibleNodes.map((node) => node.messages)),
    [baseVisibleNodes],
  );
  const baseMaxDegreeWeight = useMemo(
    () => Math.max(1, ...baseVisibleNodes.map((node) => degreeWeightByNode.get(node.id) || 0)),
    [baseVisibleNodes, degreeWeightByNode],
  );
  const baseVisibleEdgesForLayout = useMemo(() => {
    const scoped = weightedEdges.filter((edge) => {
      if (!baseVisibleNodeSet.has(edge.source) || !baseVisibleNodeSet.has(edge.target)) {
        return false;
      }
      if (showCrossClusterEdges) return true;
      const sourceCluster = community.clusterByNode.get(edge.source);
      const targetCluster = community.clusterByNode.get(edge.target);
      return sourceCluster !== undefined && sourceCluster === targetCluster;
    });
    return [...scoped].sort((a, b) => b.metric - a.metric).slice(0, 2200);
  }, [
    weightedEdges,
    baseVisibleNodeSet,
    showCrossClusterEdges,
    community.clusterByNode,
  ]);

  const width = 980;
  const height = 620;
  const centerX = width / 2;
  const centerY = 300;

  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    const halos: Array<{ clusterId: string; x: number; y: number; r: number }> = [];
    if (baseVisibleNodes.length === 0) return { positions, halos };

    const nodesByCluster = new Map<string, RelationshipNode[]>();
    for (const node of baseVisibleNodes) {
      const clusterId = community.clusterByNode.get(node.id) || "c0";
      const bucket = nodesByCluster.get(clusterId) ?? [];
      bucket.push(node);
      nodesByCluster.set(clusterId, bucket);
    }

    const clusterGroups = Array.from(nodesByCluster.entries())
      .map(([clusterId, nodes]) => ({
        clusterId,
        nodes: [...nodes].sort((a, b) => b.messages - a.messages),
      }))
      .sort((a, b) => {
        if (b.nodes.length !== a.nodes.length) return b.nodes.length - a.nodes.length;
        const totalA = a.nodes.reduce((sum, node) => sum + node.messages, 0);
        const totalB = b.nodes.reduce((sum, node) => sum + node.messages, 0);
        return totalB - totalA;
      });

    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const marginX = 90;
    const marginY = 78;
    const maxOrbit = Math.min(width, height) * 0.32;
    const clusterOrder = new Map<string, number>();
    clusterGroups.forEach((group, groupIndex) => {
      clusterOrder.set(group.clusterId, groupIndex);
      let clusterX = centerX;
      let clusterY = centerY;
      if (groupIndex > 0) {
        const angle = groupIndex * goldenAngle;
        const radius = Math.min(maxOrbit, 100 + Math.sqrt(groupIndex) * 120);
        clusterX = centerX + Math.cos(angle) * radius;
        clusterY = centerY + Math.sin(angle) * radius;
      }
      clusterX = Math.min(width - marginX, Math.max(marginX, clusterX));
      clusterY = Math.min(height - marginY, Math.max(marginY, clusterY));

      const ringCaps = [1, 6, 12, 20, 28, 38, 50];
      let cursor = 0;
      for (let ring = 0; cursor < group.nodes.length; ring += 1) {
        const cap = ringCaps[ring] ?? Math.max(40, group.nodes.length - cursor);
        const ringNodes = group.nodes.slice(cursor, cursor + cap);
        const localRadius = ring === 0 ? 0 : 24 + ring * 20;
        const offset = -Math.PI / 2 + (ring % 2 === 0 ? 0 : Math.PI / Math.max(1, cap));
        for (let i = 0; i < ringNodes.length; i += 1) {
          const angle = offset + (i / Math.max(1, ringNodes.length)) * Math.PI * 2;
          positions.set(ringNodes[i].id, {
            x: clusterX + Math.cos(angle) * localRadius,
            y: clusterY + Math.sin(angle) * localRadius,
          });
        }
        cursor += ringNodes.length;
      }
    });

    type SimNode = {
      id: string;
      clusterId: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      anchorX: number;
      anchorY: number;
      radius: number;
    };

    const simulation = new Map<string, SimNode>();
    for (const node of baseVisibleNodes) {
      const anchor = positions.get(node.id);
      if (!anchor) continue;
      const degree = degreeWeightByNode.get(node.id) || 0;
      const radius =
        5.8 +
        Math.sqrt(node.messages / baseMaxMessages) * 11 +
        Math.sqrt(degree / baseMaxDegreeWeight) * 3.8;
      simulation.set(node.id, {
        id: node.id,
        clusterId: community.clusterByNode.get(node.id) || "c0",
        x: anchor.x,
        y: anchor.y,
        vx: 0,
        vy: 0,
        anchorX: anchor.x,
        anchorY: anchor.y,
        radius,
      });
    }

    const simNodes = Array.from(simulation.values());
    const forceIterations = 26;
    for (let iteration = 0; iteration < forceIterations; iteration += 1) {
      for (const node of simNodes) {
        node.vx += (node.anchorX - node.x) * 0.02;
        node.vy += (node.anchorY - node.y) * 0.02;
      }

      for (let i = 0; i < simNodes.length; i += 1) {
        const left = simNodes[i];
        for (let j = i + 1; j < simNodes.length; j += 1) {
          const right = simNodes[j];
          let dx = right.x - left.x;
          let dy = right.y - left.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.001) {
            dx = (i % 2 === 0 ? 1 : -1) * 0.001;
            dy = (j % 2 === 0 ? -1 : 1) * 0.001;
            distance = Math.hypot(dx, dy);
          }
          const minDistance = left.radius + right.radius + 3;
          if (distance >= minDistance) continue;
          const overlap = (minDistance - distance) / minDistance;
          const repel = overlap * 0.48;
          const nx = dx / distance;
          const ny = dy / distance;
          left.vx -= nx * repel;
          left.vy -= ny * repel;
          right.vx += nx * repel;
          right.vy += ny * repel;
        }
      }

      for (const edge of baseVisibleEdgesForLayout) {
        const source = simulation.get(edge.source);
        const target = simulation.get(edge.target);
        if (!source || !target) continue;
        let dx = target.x - source.x;
        let dy = target.y - source.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          dx = 0.001;
          dy = -0.001;
          distance = Math.hypot(dx, dy);
        }
        const desiredDistance =
          source.radius +
          target.radius +
          (source.clusterId === target.clusterId ? 12 : 30);
        const springStrength = 0.0035 * Math.min(2.6, edge.metric / 2.8);
        const displacement = distance - desiredDistance;
        const nx = dx / distance;
        const ny = dy / distance;
        const fx = nx * displacement * springStrength;
        const fy = ny * displacement * springStrength;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      for (const node of simNodes) {
        node.vx *= 0.84;
        node.vy *= 0.84;
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < marginX) {
          node.x = marginX;
          node.vx *= -0.22;
        } else if (node.x > width - marginX) {
          node.x = width - marginX;
          node.vx *= -0.22;
        }
        if (node.y < marginY) {
          node.y = marginY;
          node.vy *= -0.22;
        } else if (node.y > height - marginY) {
          node.y = height - marginY;
          node.vy *= -0.22;
        }
      }
    }

    positions.clear();
    for (const node of simNodes) {
      positions.set(node.id, { x: node.x, y: node.y });
    }

    const clusterPoints = new Map<string, Array<{ x: number; y: number }>>();
    for (const node of simNodes) {
      const points = clusterPoints.get(node.clusterId) ?? [];
      points.push({ x: node.x, y: node.y });
      clusterPoints.set(node.clusterId, points);
    }

    halos.length = 0;
    for (const [clusterId, points] of clusterPoints.entries()) {
      const center = points.reduce(
        (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
        { x: 0, y: 0 },
      );
      const centerXPos = center.x / points.length;
      const centerYPos = center.y / points.length;
      let radius = 30;
      for (const point of points) {
        const distance = Math.hypot(point.x - centerXPos, point.y - centerYPos);
        radius = Math.max(radius, distance + 24);
      }
      halos.push({
        clusterId,
        x: centerXPos,
        y: centerYPos,
        r: Number(radius.toFixed(2)),
      });
    }
    halos.sort((left, right) => {
      const leftOrder = clusterOrder.get(left.clusterId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = clusterOrder.get(right.clusterId) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });

    return { positions, halos };
  }, [
    baseVisibleNodes,
    baseVisibleEdgesForLayout,
    baseMaxDegreeWeight,
    baseMaxMessages,
    centerX,
    centerY,
    degreeWeightByNode,
    width,
    height,
    community.clusterByNode,
  ]);

  const maxMessages = useMemo(
    () => Math.max(1, ...displayedNodes.map((node) => node.messages)),
    [displayedNodes],
  );
  const maxDegreeWeight = useMemo(
    () => Math.max(1, ...displayedNodes.map((node) => degreeWeightByNode.get(node.id) || 0)),
    [displayedNodes, degreeWeightByNode],
  );

  useEffect(() => {
    const physics = physicsRef.current;
    const visibleIds = new Set(displayedNodes.map((node) => node.id));
    const zoomSpread = 1 + Math.max(0, zoom - 1) * 0.9;
    for (const id of Array.from(physics.keys())) {
      if (!visibleIds.has(id)) physics.delete(id);
    }

    for (const node of displayedNodes) {
      const anchor = layout.positions.get(node.id);
      if (!anchor) continue;
      const degree = degreeWeightByNode.get(node.id) || 0;
      const radius =
        5.4 +
        Math.sqrt(node.messages / Math.max(1, maxMessages)) * 11 +
        Math.sqrt(degree / Math.max(1, maxDegreeWeight)) * 3.6;
      const existing = physics.get(node.id);
      if (existing) {
        existing.anchorX = anchor.x;
        existing.anchorY = anchor.y;
        existing.radius = radius;
        const drift = Math.hypot(existing.x - anchor.x, existing.y - anchor.y);
        if (drift > 260) {
          existing.x = anchor.x;
          existing.y = anchor.y;
          existing.vx = 0;
          existing.vy = 0;
        }
      } else {
        physics.set(node.id, {
          id: node.id,
          x: anchor.x + (Math.random() - 0.5) * 24,
          y: anchor.y + (Math.random() - 0.5) * 24,
          vx: 0,
          vy: 0,
          anchorX: anchor.x,
          anchorY: anchor.y,
          radius,
        });
      }
    }

    setPhysicsPositions(
      new Map(
        displayedNodes
          .map((node) => {
            const live = physics.get(node.id);
            if (!live) return null;
            return [node.id, { x: live.x, y: live.y }] as const;
          })
          .filter(
            (entry): entry is readonly [string, { x: number; y: number }] => entry !== null,
          ),
      ),
    );

    const edges: Array<{
      source: {
        id: string;
        x: number;
        y: number;
        vx: number;
        vy: number;
        anchorX: number;
        anchorY: number;
        radius: number;
      };
      target: {
        id: string;
        x: number;
        y: number;
        vx: number;
        vy: number;
        anchorX: number;
        anchorY: number;
        radius: number;
      };
      metric: number;
    }> = [];
    for (const edge of displayedEdges) {
      const source = physics.get(edge.source);
      const target = physics.get(edge.target);
      if (!source || !target) continue;
      edges.push({ source, target, metric: edge.metric });
    }

    let frame = 0;
    let rafId = 0;
    const marginX = 62;
    const marginY = 56;

    const step = () => {
      const nodes = Array.from(physics.values());
      if (nodes.length === 0) return;

      for (const node of nodes) {
        const anchorPull = 0.008 / zoomSpread;
        node.vx += (node.anchorX - node.x) * anchorPull;
        node.vy += (node.anchorY - node.y) * anchorPull;
      }

      for (let i = 0; i < nodes.length; i += 1) {
        const left = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
          const right = nodes[j];
          let dx = right.x - left.x;
          let dy = right.y - left.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.001) {
            dx = 0.001;
            dy = -0.001;
            distance = Math.hypot(dx, dy);
          }
          const minDistance = (left.radius + right.radius + 8) * zoomSpread;
          if (distance >= minDistance) continue;
          const overlap = (minDistance - distance) / minDistance;
          const repel = overlap * 0.62;
          const nx = dx / distance;
          const ny = dy / distance;
          left.vx -= nx * repel;
          left.vy -= ny * repel;
          right.vx += nx * repel;
          right.vy += ny * repel;
        }
      }

      for (const edge of edges) {
        const { source, target, metric } = edge;
        let dx = target.x - source.x;
        let dy = target.y - source.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          dx = 0.001;
          dy = -0.001;
          distance = Math.hypot(dx, dy);
        }
        const desiredDistance = (source.radius + target.radius + 14) * zoomSpread;
        const springStrength = (0.0022 / zoomSpread) * Math.min(2.8, metric / 2.2);
        const displacement = distance - desiredDistance;
        const nx = dx / distance;
        const ny = dy / distance;
        const fx = nx * displacement * springStrength;
        const fy = ny * displacement * springStrength;
        source.vx += fx;
        source.vy += fy;
        target.vx -= fx;
        target.vy -= fy;
      }

      for (const node of nodes) {
        node.vx *= 0.86;
        node.vy *= 0.86;
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < marginX) {
          node.x = marginX;
          node.vx *= -0.18;
        } else if (node.x > width - marginX) {
          node.x = width - marginX;
          node.vx *= -0.18;
        }
        if (node.y < marginY) {
          node.y = marginY;
          node.vy *= -0.18;
        } else if (node.y > height - marginY) {
          node.y = height - marginY;
          node.vy *= -0.18;
        }
      }

      frame += 1;
      if (frame % 2 === 0) {
        setPhysicsPositions(
          new Map(
            nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const),
          ),
        );
      }
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [
    displayedNodes,
    displayedEdges,
    layout.positions,
    degreeWeightByNode,
    maxMessages,
    maxDegreeWeight,
    zoom,
    width,
    height,
  ]);

  const renderedPositions = useMemo(() => {
    const raw = new Map<string, { x: number; y: number }>();
    for (const node of displayedNodes) {
      const live = physicsPositions.get(node.id);
      if (live) raw.set(node.id, { x: live.x, y: live.y });
      else {
        const fallback = layout.positions.get(node.id);
        if (fallback) raw.set(node.id, fallback);
      }
    }
    if (zoom <= 1.02 || raw.size === 0) return raw;

    const spread = 1 + Math.min(2.4, Math.max(0, zoom - 1) * 0.75);
    const clusterPoints = new Map<string, Array<{ x: number; y: number }>>();
    for (const node of displayedNodes) {
      const point = raw.get(node.id);
      if (!point) continue;
      const clusterId = community.clusterByNode.get(node.id) || "c0";
      const points = clusterPoints.get(clusterId) ?? [];
      points.push(point);
      clusterPoints.set(clusterId, points);
    }
    const centers = new Map<string, { x: number; y: number }>();
    for (const [clusterId, points] of clusterPoints.entries()) {
      const center = points.reduce(
        (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
        { x: 0, y: 0 },
      );
      centers.set(clusterId, { x: center.x / points.length, y: center.y / points.length });
    }

    const expanded = new Map<string, { x: number; y: number }>();
    for (const node of displayedNodes) {
      const point = raw.get(node.id);
      if (!point) continue;
      const clusterId = community.clusterByNode.get(node.id) || "c0";
      const center = centers.get(clusterId);
      if (!center) {
        expanded.set(node.id, point);
        continue;
      }
      expanded.set(node.id, {
        x: center.x + (point.x - center.x) * spread,
        y: center.y + (point.y - center.y) * spread,
      });
    }
    return expanded;
  }, [displayedNodes, layout.positions, physicsPositions, community.clusterByNode, zoom]);

  const renderedHalos = useMemo(() => {
    if (resolvedFocus) return [];
    const clusterPoints = new Map<string, Array<{ x: number; y: number }>>();
    for (const node of displayedNodes) {
      const point = renderedPositions.get(node.id);
      if (!point) continue;
      const clusterId = community.clusterByNode.get(node.id) || "c0";
      const points = clusterPoints.get(clusterId) ?? [];
      points.push(point);
      clusterPoints.set(clusterId, points);
    }
    const halos: Array<{ clusterId: string; x: number; y: number; r: number }> = [];
    for (const [clusterId, points] of clusterPoints.entries()) {
      const center = points.reduce(
        (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
        { x: 0, y: 0 },
      );
      const x = center.x / points.length;
      const y = center.y / points.length;
      let radius = 32;
      for (const point of points) {
        radius = Math.max(radius, Math.hypot(point.x - x, point.y - y) + 26);
      }
      halos.push({ clusterId, x, y, r: Number(radius.toFixed(2)) });
    }
    return halos.sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  }, [resolvedFocus, displayedNodes, renderedPositions, community.clusterByNode]);

  const maxMetric = useMemo(
    () => Math.max(1, ...displayedEdges.map((edge) => edge.metric)),
    [displayedEdges],
  );

  const hoveredNeighbors = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const set = new Set<string>();
    for (const edge of displayedEdges) {
      if (edge.source === hoveredNode) set.add(edge.target);
      if (edge.target === hoveredNode) set.add(edge.source);
    }
    return set;
  }, [hoveredNode, displayedEdges]);

  const labelNodeSet = useMemo(
    () => new Set(displayedNodes.slice(0, 24).map((node) => node.id)),
    [displayedNodes],
  );

  const clusterSummaries = useMemo(() => {
    const byCluster = new Map<
      string,
      {
        clusterId: string;
        color: string;
        nodeCount: number;
        totalMessages: number;
        edgeCount: number;
        topMembers: string[];
      }
    >();
    for (const node of displayedNodes) {
      const clusterId = community.clusterByNode.get(node.id) || "c0";
      const cluster = clusterById.get(clusterId);
      const existing = byCluster.get(clusterId) ?? {
        clusterId,
        color: community.colorByCluster.get(clusterId) || NETWORK_EDGE_NEUTRAL,
        nodeCount: 0,
        totalMessages: 0,
        edgeCount: 0,
        topMembers: cluster?.topMembers || [node.id],
      };
      existing.nodeCount += 1;
      existing.totalMessages += node.messages;
      byCluster.set(clusterId, existing);
    }
    for (const edge of displayedEdges) {
      const sourceClusterId = community.clusterByNode.get(edge.source) || "c0";
      const targetClusterId = community.clusterByNode.get(edge.target) || "c0";
      const sourceCluster = byCluster.get(sourceClusterId);
      if (sourceCluster) sourceCluster.edgeCount += 1;
      if (targetClusterId !== sourceClusterId) {
        const targetCluster = byCluster.get(targetClusterId);
        if (targetCluster) targetCluster.edgeCount += 1;
      }
    }

    return Array.from(byCluster.values()).sort((a, b) => {
      if (b.nodeCount !== a.nodeCount) return b.nodeCount - a.nodeCount;
      return b.totalMessages - a.totalMessages;
    });
  }, [displayedNodes, displayedEdges, community.clusterByNode, community.colorByCluster, clusterById]);

  const activeNodeId = hoveredNode ?? resolvedFocus;
  const activeNode = activeNodeId ? nodeById.get(activeNodeId) ?? null : null;
  const activeClusterId = activeNodeId ? community.clusterByNode.get(activeNodeId) ?? null : null;
  const activeCluster = activeClusterId ? clusterById.get(activeClusterId) ?? null : null;
  const activeConnections = useMemo(() => {
    if (!activeNodeId) return [];
    const edges = adjacency.get(activeNodeId) ?? [];
    return edges.slice(0, 24).map((edge) => ({
      other: edge.source === activeNodeId ? edge.target : edge.source,
      edge,
    }));
  }, [activeNodeId, adjacency]);
  const activeConnectionCount = useMemo(() => {
    if (!activeNodeId) return 0;
    return (adjacency.get(activeNodeId) ?? []).length;
  }, [activeNodeId, adjacency]);
  const activeVisibleConnectionCount = useMemo(() => {
    if (!activeNodeId) return 0;
    let count = 0;
    for (const edge of displayedEdges) {
      if (edge.source === activeNodeId || edge.target === activeNodeId) count += 1;
    }
    return count;
  }, [activeNodeId, displayedEdges]);

  const topEdges = useMemo(() => displayedEdges.slice(0, 10), [displayedEdges]);
  const visiblePeopleSearchResults = useMemo(
    () => peopleSearchResults.slice(0, 8),
    [peopleSearchResults],
  );

  function focusPerson(personId: string): void {
    setFocusedNode(personId);
    setSelectedClusterId(null);
  }

  function clampZoom(value: number): number {
    return Math.max(NETWORK_MIN_ZOOM, Math.min(NETWORK_MAX_ZOOM, value));
  }

  function zoomAt(nextZoom: number, pivotX: number, pivotY: number): void {
    const clampedZoom = clampZoom(nextZoom);
    if (Math.abs(clampedZoom - zoom) < 0.001) return;
    const worldX = (pivotX - pan.x) / zoom;
    const worldY = (pivotY - pan.y) / zoom;
    setPan({
      x: pivotX - worldX * clampedZoom,
      y: pivotY - worldY * clampedZoom,
    });
    setZoom(clampedZoom);
  }

  function resetViewport(): void {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handleCanvasWheel(event: React.WheelEvent<SVGSVGElement>): void {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const pivotX = ((event.clientX - rect.left) / rect.width) * width;
    const pivotY = ((event.clientY - rect.top) / rect.height) * height;
    const scaleFactor = event.deltaY < 0 ? 1.12 : 0.89;
    zoomAt(zoom * scaleFactor, pivotX, pivotY);
  }

  function handleCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0) return;
    if (!event.shiftKey) return;
    event.preventDefault();
    panDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>): void {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    setPan({
      x: drag.panX + (event.clientX - drag.startClientX) * scaleX,
      y: drag.panY + (event.clientY - drag.startClientY) * scaleY,
    });
  }

  function handleCanvasPointerUp(event: React.PointerEvent<SVGSVGElement>): void {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function focusFromInput() {
    const needle = personInput.trim().toLowerCase();
    if (!needle) return;
    const exact = sortedNodes.find((node) => node.id.toLowerCase() === needle) ?? null;
    const target = exact ?? peopleSearchResults[0] ?? null;
    if (!target) return;
    focusPerson(target.id);
  }

  if (sortedNodes.length === 0) {
    return <p className="text-sm text-slate-400">Not enough data yet to render a people network.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setMode("relationships");
            setHoveredNode(null);
            setFocusedNode(null);
            setSelectedClusterId(null);
            setPersonInput("");
            resetViewport();
          }}
          className={`rounded px-3 py-1 text-sm ${isRelationship ? "vibe-button" : "vibe-chip"}`}
        >
          Relationships
        </button>
        <button
          onClick={() => {
            setMode("alignment");
            setHoveredNode(null);
            setFocusedNode(null);
            setSelectedClusterId(null);
            setPersonInput("");
            resetViewport();
          }}
          className={`rounded px-3 py-1 text-sm ${!isRelationship ? "vibe-button" : "vibe-chip"}`}
        >
          Topic Alignment
        </button>
        <span className="text-xs text-slate-400">
          {isRelationship
            ? `${network.relationships.summaries.included_nodes}/${network.relationships.summaries.total_users_in_window} people shown`
            : `${network.topic_alignment.summaries.included_nodes} people compared`}
        </span>
        <span className="text-xs text-slate-500">
          communities {community.clusters.length} · visible {clusterSummaries.length}
        </span>
        {personQuery ? (
          <span className="text-xs text-cyan-300/85">
            search filter active · {displayedNodes.length} people in graph
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 rounded-lg border border-slate-700/70 bg-slate-900/45 p-3 lg:grid-cols-6">
        <label className="space-y-1 text-xs lg:col-span-2">
          <span className="text-slate-300">Find / focus person</span>
          <div className="flex gap-2">
            <input
              value={personInput}
              onChange={(event) => setPersonInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  focusFromInput();
                }
              }}
              className="vibe-input w-full rounded px-2 py-1 text-sm"
              placeholder="Type a name to filter graph, Enter to focus top match"
            />
            <button onClick={focusFromInput} className="vibe-chip rounded px-2 py-1 text-xs">
              Focus
            </button>
            <button
              onClick={() => {
                setPersonInput("");
                setFocusedNode(null);
              }}
              className="vibe-chip rounded px-2 py-1 text-xs"
            >
              Clear
            </button>
          </div>
          {personQuery ? (
            <div className="rounded border border-slate-700/60 bg-slate-900/45 p-2">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="text-slate-400">
                  Search matches: {peopleSearchResults.length}
                </span>
                {peopleSearchResults.length > visiblePeopleSearchResults.length ? (
                  <span className="text-slate-500">
                    showing top {visiblePeopleSearchResults.length}
                  </span>
                ) : null}
              </div>
              <div className="mb-1 text-[10px] text-cyan-300/80">
                Graph is filtered to matched people and their nearest connections.
              </div>
              {visiblePeopleSearchResults.length === 0 ? (
                <div className="text-[11px] text-slate-500">No participants match this query.</div>
              ) : (
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                  {visiblePeopleSearchResults.map((result) => {
                    const clusterId = community.clusterByNode.get(result.id) || "c0";
                    const clusterColor =
                      community.colorByCluster.get(clusterId) || NETWORK_EDGE_NEUTRAL;
                    const degree = degreeWeightByNode.get(result.id) || 0;
                    return (
                      <button
                        key={`search-${result.id}`}
                        onClick={() => focusPerson(result.id)}
                        className="flex w-full items-center justify-between rounded border border-slate-700/50 px-2 py-1 text-left hover:border-slate-500/80 hover:bg-slate-800/60"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: clusterColor }}
                          />
                          <span className="text-[11px] text-slate-200">{result.id}</span>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {result.messages} msgs · {degree.toFixed(1)} weight
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </label>

        <label className="space-y-1 text-xs">
          <span className="text-slate-300">
            {isRelationship
              ? `Min weight: ${minRelationshipWeight.toFixed(1)}`
              : `Min similarity: ${minAlignmentSimilarity.toFixed(2)}`}
          </span>
          <input
            type="range"
            min={isRelationship ? 0.5 : 0.2}
            max={isRelationship ? 12 : 0.95}
            step={isRelationship ? 0.1 : 0.01}
            value={isRelationship ? minRelationshipWeight : minAlignmentSimilarity}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (isRelationship) setMinRelationshipWeight(value);
              else setMinAlignmentSimilarity(value);
            }}
            className="w-full accent-cyan-300"
          />
        </label>

        <label className="space-y-1 text-xs">
          <span className="text-slate-300">Neighbor cap: {neighborLimit}</span>
          <input
            type="range"
            min={20}
            max={140}
            step={1}
            value={neighborLimit}
            onChange={(event) => setNeighborLimit(Number(event.target.value))}
            className="w-full accent-cyan-300"
          />
        </label>

        <div className="space-y-2 text-xs lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setFocusedNode(null);
                setHoveredNode(null);
                setSelectedClusterId(null);
                setPersonInput("");
              }}
              className="vibe-chip rounded px-2 py-1 text-xs"
            >
              Show all
            </button>
            <label className="flex items-center gap-2 rounded border border-slate-700/70 px-2 py-1 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={showNeighborEdges}
                onChange={(event) => setShowNeighborEdges(event.target.checked)}
                className="accent-cyan-300"
              />
              neighbor-neighbor edges
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded border border-slate-700/70 px-2 py-1 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={hideIsolated}
                onChange={(event) => setHideIsolated(event.target.checked)}
                className="accent-cyan-300"
              />
              hide isolated people
            </label>
            <label className="flex items-center gap-2 rounded border border-slate-700/70 px-2 py-1 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={showCrossClusterEdges}
                onChange={(event) => setShowCrossClusterEdges(event.target.checked)}
                className="accent-cyan-300"
              />
              show cross-cluster links
            </label>
          </div>
        </div>
      </div>

      <details className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer list-none font-semibold text-slate-100">
          Communities in view ({clusterSummaries.length})
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {clusterSummaries.length === 0 ? (
            <span className="text-slate-500">No community data at current filters.</span>
          ) : (
            clusterSummaries.map((cluster) => (
              <button
                key={cluster.clusterId}
                onClick={() => {
                  setFocusedNode(null);
                  setHoveredNode(null);
                  setSelectedClusterId((prev) =>
                    prev === cluster.clusterId ? null : cluster.clusterId,
                  );
                }}
                className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                  resolvedSelectedClusterId === cluster.clusterId
                    ? "border-slate-200/90 bg-slate-200/10 text-slate-100"
                    : "border-slate-700/70 text-slate-300"
                }`}
                title={cluster.topMembers.join(", ")}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: cluster.color }}
                />
                <span>{cluster.clusterId.toUpperCase()}</span>
                <span className="text-slate-400">{cluster.nodeCount} people</span>
                <span className="text-slate-500">{cluster.edgeCount} links</span>
              </button>
            ))
          )}
        </div>
      </details>

      <details className="rounded-lg border border-slate-700/70 bg-slate-900/40 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer list-none font-semibold text-slate-100">
          Methods: how this network is built
        </summary>
        <div className="mt-2 space-y-2 text-slate-300">
          <p>
            Relationship mode uses directional edges inferred from explicit mentions, nearby
            conversational turns/replies in channel history, and DM/offline intent language.
            Edge weight blends these signals and this view currently shows edges with weight
            above {minRelationshipWeight.toFixed(1)}.
          </p>
          <p>
            Topic alignment mode compares each person&apos;s topic-frequency vector with cosine
            similarity and keeps only stronger overlaps with shared topics. This view currently
            shows edges above similarity {minAlignmentSimilarity.toFixed(2)}.
          </p>
          <p>
            Communities are detected on the filtered graph using weighted label propagation on an
            undirected projection. Colors represent these inferred communities and update as your
            thresholds and filters change.
          </p>
          <p>
            Node placement starts from community rings, then runs continuous force simulation
            (collision repulsion + edge springs + anchor pull + damping) so bubbles keep moving
            out of overlap while preserving overall cluster structure.
          </p>
          <p className="text-slate-400">
            These are inference heuristics over message patterns, not definitive social truth.
          </p>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/35 px-3 py-2 text-xs text-slate-300">
        <span className="text-slate-400">Viewport</span>
        <button
          onClick={() => zoomAt(zoom / 1.2, width / 2, height / 2)}
          className="vibe-chip rounded px-2 py-1 text-xs"
          title="Zoom out"
        >
          -
        </button>
        <span className="min-w-12 text-center font-semibold text-slate-100">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => zoomAt(zoom * 1.2, width / 2, height / 2)}
          className="vibe-chip rounded px-2 py-1 text-xs"
          title="Zoom in"
        >
          +
        </button>
        <button onClick={resetViewport} className="vibe-chip rounded px-2 py-1 text-xs">
          Reset view
        </button>
        <span className="text-slate-500">Wheel to zoom, Shift + drag to pan.</span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[34rem] w-full rounded-xl border border-slate-700/60 bg-slate-950/40"
        onWheel={handleCanvasWheel}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerLeave={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        style={{ touchAction: "none" }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {!resolvedFocus
          ? renderedHalos.map((halo) => {
              const haloColor = community.colorByCluster.get(halo.clusterId) || NETWORK_EDGE_NEUTRAL;
              const dimmed =
                resolvedSelectedClusterId !== null && halo.clusterId !== resolvedSelectedClusterId;
              return (
                <g key={`${halo.clusterId}-${Math.round(halo.x)}-${Math.round(halo.y)}`}>
                  <circle
                    cx={halo.x}
                    cy={halo.y}
                    r={halo.r}
                    fill={haloColor}
                    fillOpacity={dimmed ? 0.02 : 0.08}
                    stroke={haloColor}
                    strokeOpacity={dimmed ? 0.18 : 0.42}
                    strokeDasharray="3 5"
                  />
                  <text
                    x={halo.x}
                    y={halo.y - halo.r - 6}
                    textAnchor="middle"
                    className="fill-slate-400 text-[9px]"
                  >
                    {halo.clusterId.toUpperCase()}
                  </text>
                </g>
              );
            })
          : null}

        {displayedEdges.map((edge, index) => {
          const source = renderedPositions.get(edge.source);
          const target = renderedPositions.get(edge.target);
          if (!source || !target) return null;
          const sourceCluster = community.clusterByNode.get(edge.source) || "c0";
          const targetCluster = community.clusterByNode.get(edge.target) || "c0";
          const sameCluster = sourceCluster === targetCluster;
          const emphasized =
            hoveredNode !== null && (edge.source === hoveredNode || edge.target === hoveredNode);
          const muted =
            hoveredNode !== null && edge.source !== hoveredNode && edge.target !== hoveredNode;
          const edgeColor = sameCluster
            ? community.colorByCluster.get(sourceCluster) || NETWORK_EDGE_NEUTRAL
            : NETWORK_EDGE_NEUTRAL;
          return (
            <line
              key={`${edge.source}-${edge.target}-${index}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={edgeColor}
              strokeWidth={0.7 + (edge.metric / maxMetric) * (isRelationship ? 5.4 : 4.6)}
              strokeOpacity={emphasized ? 0.95 : muted ? 0.13 : sameCluster ? 0.42 : 0.24}
              strokeDasharray={!sameCluster && !resolvedFocus ? "3 3" : undefined}
            />
          );
        })}

        {displayedNodes.map((node) => {
          const point = renderedPositions.get(node.id);
          if (!point) return null;
          const clusterId = community.clusterByNode.get(node.id) || "c0";
          const clusterColor = community.colorByCluster.get(clusterId) || NETWORK_EDGE_NEUTRAL;
          const degreeWeight = degreeWeightByNode.get(node.id) || 0;
          const isHovered = hoveredNode === node.id;
          const isFocused = resolvedFocus === node.id;
          const isNeighbor = hoveredNode !== null && hoveredNeighbors.has(node.id);
          const muted = hoveredNode !== null && !isHovered && !isNeighbor;
          const radius =
            5.4 +
            Math.sqrt(node.messages / maxMessages) * 11 +
            Math.sqrt(degreeWeight / maxDegreeWeight) * 3.6;
          const shouldLabel = zoom >= 1.25 || isHovered || isFocused || labelNodeSet.has(node.id);
          return (
            <g
              key={node.id}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => {
                focusPerson(node.id);
              }}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={isFocused ? radius + 2 : radius}
                fill={clusterColor}
                fillOpacity={
                  isHovered ? 0.96 : isNeighbor || isFocused ? 0.8 : muted ? 0.2 : 0.58
                }
                stroke={isHovered || isFocused ? "#e2e8f0" : "#0f172a"}
                strokeWidth={isHovered || isFocused ? 1.8 : 1}
              />
              {shouldLabel ? (
                <text
                  x={point.x}
                  y={point.y + radius + 11}
                  textAnchor="middle"
                  className={`${muted ? "fill-slate-600" : "fill-slate-300"} text-[9px]`}
                >
                  {node.id}
                </text>
              ) : null}
            </g>
          );
        })}
        </g>
      </svg>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3 text-xs text-slate-300">
          {activeNode ? (
            <div className="space-y-2">
              <div className="font-semibold text-slate-100">
                {activeNode.id}
                {resolvedFocus === activeNode.id ? " (focused)" : ""}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor:
                      activeCluster?.color ||
                      (activeClusterId
                        ? community.colorByCluster.get(activeClusterId)
                        : undefined) ||
                      NETWORK_EDGE_NEUTRAL,
                  }}
                />
                <span>{activeClusterId ? activeClusterId.toUpperCase() : "unclustered"}</span>
              </div>
              <div>
                {activeNode.messages} msgs · {activeNode.channels} channels · out {activeNode.replies_out} / in{" "}
                {activeNode.replies_in}
                {isRelationship ? ` · dm/offline ${activeNode.dm_signals}` : ""}
              </div>
              <div className="text-slate-400">
                Connections at threshold: {activeVisibleConnectionCount} visible / {activeConnectionCount} total
              </div>
              <div className="text-slate-400">
                Top topics: {activeNode.top_topics.length > 0 ? activeNode.top_topics.join(", ") : "n/a"}
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto border-t border-slate-700/60 pt-2">
                {activeConnections.length === 0 ? (
                  <div className="text-slate-500">No strong connections at current threshold.</div>
                ) : (
                  activeConnections.map((item, index) => {
                    if (isRelationship) {
                      const edge = item.edge.detail as RelationshipEdge;
                      return (
                        <div key={`${item.other}-${index}`}>
                          {item.other} · w={item.edge.metric.toFixed(1)} · r{edge.replies} · m
                          {edge.mentions} · dm{edge.dm_signals}
                        </div>
                      );
                    }
                    const edge = item.edge.detail as TopicAlignmentEdge;
                    return (
                      <div key={`${item.other}-${index}`}>
                        {item.other} · sim {(item.edge.metric * 100).toFixed(0)}% ·{" "}
                        {edge.shared_topics.join(", ")}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <span>Overview defaults to communities; hover or click a person to inspect individual ties.</span>
          )}
        </div>
        <div className="rounded-lg border border-slate-700/70 bg-slate-900/50 p-3 text-xs text-slate-300">
          <div className="font-semibold text-slate-100">Strongest edges in view</div>
          <div className="mt-1 max-h-64 space-y-1 overflow-y-auto">
            {topEdges.length === 0 ? (
              <div className="text-slate-500">No edges after threshold filtering.</div>
            ) : (
              topEdges.map((edge, index) => {
                const sourceCluster = community.clusterByNode.get(edge.source) || "c0";
                const targetCluster = community.clusterByNode.get(edge.target) || "c0";
                return isRelationship ? (
                  <div key={`${edge.source}-${edge.target}-${index}`}>
                    {edge.source} → {edge.target} · w={edge.metric.toFixed(1)} ·{" "}
                    {sourceCluster.toUpperCase()}
                    {sourceCluster === targetCluster ? "" : ` to ${targetCluster.toUpperCase()}`}
                  </div>
                ) : (
                  <div key={`${edge.source}-${edge.target}-${index}`}>
                    {edge.source} ↔ {edge.target} · sim {(edge.metric * 100).toFixed(0)}% ·{" "}
                    {sourceCluster.toUpperCase()}
                    {sourceCluster === targetCluster ? "" : ` to ${targetCluster.toUpperCase()}`}
                  </div>
                );
              })
            )}
          </div>
          <div className="mt-3 border-t border-slate-700/60 pt-2 text-slate-400">
            Showing {displayedNodes.length} people, {displayedEdges.length} edges,{" "}
            {clusterSummaries.length} communities at current settings.
          </div>
        </div>
      </div>
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

function sumCounts(values: DailyCount[]): number {
  return values.reduce((sum, value) => sum + value.count, 0);
}

type DayRange = 30 | 90 | 180 | 365 | "all";

const SECTION_LINKS = [
  { id: "volume-trend", label: "Volume" },
  { id: "coverage-trend", label: "Coverage" },
  { id: "topic-explorer", label: "Topics" },
  { id: "people-network", label: "People Network" },
  { id: "topic-graph", label: "Graph" },
  { id: "contributors", label: "Users + Channels" },
  { id: "topic-lifecycle", label: "Lifecycle" },
  { id: "topic-drilldown", label: "Drilldown" },
  { id: "cooccurrence", label: "Co-Occurrence" },
  { id: "seasonality", label: "Seasonality" },
];

export default function StatsPage() {
  const [days, setDays] = useState<DayRange>(90);
  const [stats, setStats] = useState<StatsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [topicNav, setTopicNav] = useState<{ trail: string[]; index: number }>({
    trail: [],
    index: -1,
  });
  const [topicDrilldown, setTopicDrilldown] = useState<TopicDrilldown | null>(null);
  const [topicInsights, setTopicInsights] = useState<TopicInsights | null>(null);
  const drilldownRef = useRef<HTMLElement | null>(null);

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
  const activeTopicTrail =
    topicNav.index >= 0 ? topicNav.trail.slice(0, topicNav.index + 1) : [];
  const canGoTopicBack = topicNav.index > 0;
  const canGoTopicForward = topicNav.index >= 0 && topicNav.index < topicNav.trail.length - 1;

  function openTopicDrilldown(
    topic: string,
    options?: { scroll?: boolean; trackNavigation?: boolean },
  ) {
    setSelectedTopic(topic);
    if (options?.trackNavigation !== false) {
      setTopicNav((prev) => {
        const activeTrail =
          prev.index >= 0 ? prev.trail.slice(0, prev.index + 1) : prev.trail.slice();
        if (activeTrail[activeTrail.length - 1] === topic) {
          return { trail: activeTrail, index: activeTrail.length - 1 };
        }
        const nextTrail = [...activeTrail, topic].slice(-32);
        return { trail: nextTrail, index: nextTrail.length - 1 };
      });
    }
    if (options?.scroll !== false) {
      requestAnimationFrame(() => {
        drilldownRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  function goTopicBack() {
    if (!canGoTopicBack) return;
    const nextIndex = topicNav.index - 1;
    const topic = topicNav.trail[nextIndex];
    setTopicNav((prev) => ({ ...prev, index: Math.max(0, prev.index - 1) }));
    setSelectedTopic(topic);
  }

  function goTopicForward() {
    if (!canGoTopicForward) return;
    const nextIndex = topicNav.index + 1;
    const topic = topicNav.trail[nextIndex];
    setTopicNav((prev) => ({ ...prev, index: Math.min(prev.trail.length - 1, prev.index + 1) }));
    setSelectedTopic(topic);
  }

  function jumpToTopicTrail(index: number) {
    if (index < 0 || index >= topicNav.trail.length) return;
    const topic = topicNav.trail[index];
    setTopicNav((prev) => ({ ...prev, index }));
    setSelectedTopic(topic);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <header className="fade-up space-y-2">
          <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
            Stats & Trends
          </h1>
          <p className="vibe-subtitle">
            Activity by user, channel, and topic with lifecycle and recurrence over time.
          </p>
        </header>
        <StatusPanel
          loading
          title="Loading stats"
          detail="Preparing trend windows and topic drilldown snapshots."
          steps={[
            "Aggregating message volume by day",
            "Computing user/channel/topic metrics",
            "Building drilldown and recurrence views",
          ]}
        />
      </div>
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
  const coveragePercent = Math.round(stats.coverage.avg_topic_coverage * 100);
  const recentWindow = Math.min(21, stats.timeline.length);
  const recentMessages = sumCounts(stats.timeline.slice(-recentWindow));
  const recentWithTopics = sumCounts(stats.coverage.with_topics.slice(-recentWindow));
  const recentCoveragePercent =
    recentMessages > 0 ? Math.round((recentWithTopics / recentMessages) * 100) : 0;
  const coverageDaily: DailyCount[] = stats.timeline.map((point, index) => {
    const withTopics = stats.coverage.with_topics[index]?.count || 0;
    const percent = point.count > 0 ? Math.round((withTopics / point.count) * 100) : 0;
    return { date: point.date, count: percent };
  });

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

      <section className="vibe-panel rounded-xl p-4">
        <p className="text-xs uppercase tracking-wide text-slate-400">Jump to section</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SECTION_LINKS.map((link) => (
            <a
              key={link.id}
              href={`#${link.id}`}
              className="vibe-chip rounded px-2.5 py-1 text-xs hover:border-cyan-300/60 hover:text-slate-100"
            >
              {link.label}
            </a>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Topic coverage</div>
          <div className="vibe-title mt-1 text-2xl">{coveragePercent}%</div>
        </div>
      </section>

      <section id="volume-trend" className="vibe-panel scroll-mt-28 rounded-xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="vibe-title text-lg">Interactive Volume Trend</h2>
          <span className="text-xs text-slate-400">{stats.window_days} day window</span>
        </div>
        <InteractiveTimelineChart daily={stats.timeline} color="#22d3ee" yLabel="msgs" />
      </section>

      {recentCoveragePercent < 60 ? (
        <div className="rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
          Topic coverage is low in the recent window ({recentCoveragePercent}% in last {recentWindow} days), which can create apparent topic-trend gaps even when message volume is present.
        </div>
      ) : null}

      <section id="coverage-trend" className="vibe-panel scroll-mt-28 rounded-xl p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="vibe-title text-lg">Topic Classification Coverage</h2>
          <span className="text-xs text-slate-400">
            Last {recentWindow}d: {recentCoveragePercent}% · Overall: {coveragePercent}%
          </span>
        </div>
        <InteractiveTimelineChart daily={coverageDaily} color="#f59e0b" yLabel="% covered" />
      </section>

      <section id="topic-explorer" className="scroll-mt-28 grid gap-4 xl:grid-cols-2">
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Interactive Topic Trend Explorer</h2>
          <TopicTrendExplorer topics={stats.topics} onTopicDrilldown={openTopicDrilldown} />
        </div>
        <div className="vibe-panel rounded-xl p-5">
          <h2 className="vibe-title mb-3 text-lg">Topic Recurrence Map</h2>
          <TopicRecurrenceMap topics={stats.topics} onTopicDrilldown={openTopicDrilldown} />
        </div>
      </section>

      <section id="people-network" className="vibe-panel scroll-mt-28 rounded-xl p-5">
        <h2 className="vibe-title mb-3 text-lg">People Relationship Network</h2>
        <p className="mb-3 text-sm text-slate-300">
          Nodes represent participants. Relationship edges are inferred from explicit mentions,
          conversational replies/turns, and DM-offline signals. Topic Alignment edges show who has
          similar interest distributions.
        </p>
        <PeopleNetworkGraph network={stats.network} />
      </section>

      <section id="contributors" className="scroll-mt-28 grid gap-4 xl:grid-cols-2">
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

      <section id="topic-lifecycle" className="vibe-panel scroll-mt-28 rounded-xl p-5">
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
                      onClick={() => openTopicDrilldown(topic.topic)}
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

      <section
        id="topic-drilldown"
        ref={drilldownRef}
        className="vibe-panel scroll-mt-28 rounded-xl p-5"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="vibe-title text-lg">Topic Drilldown</h2>
          <span className="text-xs text-slate-400">
            {effectiveSelectedTopic ? `Selected: ${effectiveSelectedTopic}` : "Select a topic above"}
          </span>
        </div>

        {effectiveSelectedTopic ? (
          <div className="mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={goTopicBack}
                disabled={!canGoTopicBack}
                className="rounded border border-slate-700/70 bg-slate-900/50 px-2 py-1 text-xs text-slate-200 enabled:hover:border-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Back hop
              </button>
              <button
                onClick={goTopicForward}
                disabled={!canGoTopicForward}
                className="rounded border border-slate-700/70 bg-slate-900/50 px-2 py-1 text-xs text-slate-200 enabled:hover:border-cyan-300/60 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Forward hop
              </button>
              {activeTopicTrail.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeTopicTrail.map((topic, index) => (
                    <button
                      key={`${topic}-${index}`}
                      onClick={() => jumpToTopicTrail(index)}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        index === topicNav.index
                          ? "border-cyan-300/70 bg-cyan-300/15 text-cyan-100"
                          : "border-slate-700 bg-slate-900/40 text-slate-300 hover:border-cyan-300/60"
                      }`}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <section id="topic-graph" className="rounded-lg border border-slate-700/70 bg-slate-900/35 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">Topic Graph Navigator</h3>
              <TopicGraphNavigator
                focusTopic={effectiveSelectedTopic}
                topics={stats.topics}
                edges={stats.cooccurrence}
                onSelectTopic={(topic) => openTopicDrilldown(topic, { scroll: false })}
              />
            </section>
          </div>
        ) : null}

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
                    onClick={() => openTopicDrilldown(edge.topic_b, { scroll: false })}
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

      <section id="cooccurrence" className="vibe-panel scroll-mt-28 rounded-xl p-5">
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

      <section id="seasonality" className="scroll-mt-28 grid gap-4 xl:grid-cols-2">
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
