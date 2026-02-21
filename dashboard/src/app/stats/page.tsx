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

export default function StatsPage() {
  const [days, setDays] = useState(90);
  const [stats, setStats] = useState<StatsDashboard | null>(null);
  const [loading, setLoading] = useState(true);

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

  const generatedLabel = useMemo(() => {
    if (!stats) return "";
    return new Date(stats.generated_at).toLocaleString();
  }, [stats]);

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
        {[30, 90, 180].map((range) => (
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
            {range}d
          </button>
        ))}
        <span className="text-xs text-slate-400">Last computed: {generatedLabel}</span>
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
          <h2 className="vibe-title text-lg">Overall Volume Timeline</h2>
          <span className="text-xs text-slate-400">{stats.window_days} day window</span>
        </div>
        <Sparkline daily={stats.timeline} />
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
                  <td className="py-2 pr-3 text-slate-200">{topic.topic}</td>
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
