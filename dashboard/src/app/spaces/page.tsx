"use client";

import { useEffect, useMemo, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

type DayRange = 14 | 30 | 90 | "all";
type TriageMode = "focus" | "balanced" | "explore";

const MODE_DEFAULTS: Record<TriageMode, { minRelevance: number; maxMessages: number }> = {
  focus: { minRelevance: 5, maxMessages: 32 },
  balanced: { minRelevance: 3, maxMessages: 60 },
  explore: { minRelevance: 0, maxMessages: 100 },
};

interface SpaceSummary {
  key: string;
  source: "beeper" | "google_groups" | "other";
  source_label: string;
  room_id: string;
  room_name: string;
  messages: number;
  people: number;
  last_seen: string;
  last_seen_ts: number;
}

interface RecentMessage {
  id: string;
  timestamp: number;
  date: string;
  room_id: string;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
  contribution_flag: number | null;
  alert_level: string | null;
  topics: string[];
  priority_score: number;
}

interface SpacesDashboard {
  window_days: number;
  generated_at: string;
  scope: {
    mode: "active_groups" | "excluded_groups" | "all";
    active_group_count: number;
    excluded_groups: string[];
  };
  totals: {
    messages: number;
    rooms: number;
    people: number;
  };
  sources: {
    source: "beeper" | "google_groups" | "other";
    label: string;
    messages: number;
    rooms: number;
    people: number;
  }[];
  spaces: SpaceSummary[];
  selected_space: string | null;
  triage: {
    mode: TriageMode;
    query: string;
    min_relevance: number;
    max_messages: number;
    filtered_messages: number;
    high_signal_messages: number;
    contribution_messages: number;
    hot_alert_messages: number;
    avg_relevance: number;
  };
  top_topics: {
    topic: string;
    messages: number;
    avg_relevance: number;
  }[];
  top_people: {
    sender_name: string;
    messages: number;
    avg_relevance: number;
    contributions: number;
    hot_alerts: number;
  }[];
  recent_messages: RecentMessage[];
}

function excerpt(text: string, max = 220): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no body)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function modeLabel(mode: TriageMode): string {
  if (mode === "focus") return "Focus";
  if (mode === "balanced") return "Balanced";
  return "Explore";
}

export default function SpacesPage() {
  const [days, setDays] = useState<DayRange>(30);
  const [selectedSpace, setSelectedSpace] = useState<string>("");
  const [mode, setMode] = useState<TriageMode>("focus");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [minRelevance, setMinRelevance] = useState<number>(MODE_DEFAULTS.focus.minRelevance);
  const [maxMessages, setMaxMessages] = useState<number>(MODE_DEFAULTS.focus.maxMessages);
  const [spaces, setSpaces] = useState<SpacesDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    params.set("days", String(days));
    params.set("mode", mode);
    params.set("min_relevance", String(minRelevance));
    params.set("max_messages", String(maxMessages));
    if (selectedSpace) params.set("space", selectedSpace);
    if (query) params.set("q", query);
    fetch(`/api/spaces?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { spaces: SpacesDashboard | null }) => {
        if (!active) return;
        setSpaces(data.spaces);
        if (data.spaces?.selected_space && !selectedSpace) {
          setSelectedSpace(data.spaces.selected_space);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setSpaces(null);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days, selectedSpace, mode, query, minRelevance, maxMessages]);

  const selectedSpaceMeta = useMemo(() => {
    if (!spaces?.selected_space) return null;
    return spaces.spaces.find((space) => space.room_id === spaces.selected_space) || null;
  }, [spaces]);

  if (loading) {
    return (
      <StatusPanel
        loading
        title="Loading Google Groups"
        detail="Building a prioritized queue from your selected group stream."
      />
    );
  }

  if (!spaces) {
    return (
      <StatusPanel
        title="Google Groups unavailable"
        detail="Could not load group tracking right now. Try refreshing in a moment."
      />
    );
  }

  const scopeLabel =
    spaces.scope.mode === "active_groups"
      ? `Scoped to ${spaces.scope.active_group_count} tracked rooms`
      : spaces.scope.mode === "excluded_groups"
        ? `Scoped by exclusions (${spaces.scope.excluded_groups.length} filtered names)`
        : "Using all rooms in DB";

  return (
    <div className="space-y-6">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Google Groups Monitor
        </h1>
        <p className="vibe-subtitle">
          Managed triage view for Google Groups so high-signal threads stay visible first.
        </p>
      </header>

      <section className="vibe-panel rounded-xl p-5">
        <div className="flex flex-wrap items-center gap-2">
          {([14, 30, 90, "all"] as DayRange[]).map((range) => (
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
          <span className="text-xs text-slate-400">
            Last computed: {new Date(spaces.generated_at).toLocaleString()}
          </span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {(["focus", "balanced", "explore"] as TriageMode[]).map((candidate) => (
            <button
              key={candidate}
              onClick={() => {
                if (candidate === mode) return;
                setLoading(true);
                setMode(candidate);
                setMinRelevance(MODE_DEFAULTS[candidate].minRelevance);
                setMaxMessages(MODE_DEFAULTS[candidate].maxMessages);
              }}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${
                mode === candidate
                  ? "border-cyan-300/60 bg-cyan-400/10 text-cyan-100"
                  : "border-slate-700/80 bg-slate-900/50 text-slate-300"
              }`}
            >
              <div className="font-semibold">{modeLabel(candidate)}</div>
              <div className="mt-1 text-xs text-slate-400">
                {candidate === "focus"
                  ? "Action-heavy queue with high relevance, hot alerts, and contribution signal."
                  : candidate === "balanced"
                    ? "Mixed feed balancing relevance and recency."
                    : "Chronological scan for broad situational awareness."}
              </div>
            </button>
          ))}
        </div>

        <form
          className="mt-4 grid gap-3 lg:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            setLoading(true);
            setQuery(queryDraft.trim());
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Search sender/body
            <input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="e.g. context management, Ben, postmortem"
              className="vibe-input rounded-md px-3 py-2 text-sm text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Min relevance: {minRelevance}
            <input
              type="range"
              min={0}
              max={9}
              value={minRelevance}
              onChange={(event) => {
                setLoading(true);
                setMinRelevance(Number.parseInt(event.target.value, 10));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Max queue size
            <select
              value={String(maxMessages)}
              className="vibe-input rounded-md px-3 py-2 text-sm text-slate-100"
              onChange={(event) => {
                setLoading(true);
                setMaxMessages(Number.parseInt(event.target.value, 10));
              }}
            >
              {[20, 32, 40, 60, 80, 100, 140].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="lg:col-span-3 flex flex-wrap items-center gap-2">
            <button type="submit" className="vibe-button rounded-md px-3 py-1.5 text-sm">
              Apply Search
            </button>
            <button
              type="button"
              className="vibe-chip rounded-md px-3 py-1.5 text-sm"
              onClick={() => {
                setLoading(true);
                setQueryDraft("");
                setQuery("");
              }}
            >
              Clear Search
            </button>
            <span className="text-xs text-slate-400">
              Scope: {scopeLabel} · Mode: {modeLabel(spaces.triage.mode)}
            </span>
          </div>
        </form>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Filtered</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.triage.filtered_messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">High Signal</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.triage.high_signal_messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Contribution</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.triage.contribution_messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Hot Alerts</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.triage.hot_alert_messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Avg Relevance</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.triage.avg_relevance}</div>
        </div>
      </section>

      {spaces.spaces.length === 0 ? (
        <StatusPanel
          title="No Google Groups messages yet"
          detail="No `googlegroup:*` messages are currently in the selected window. Confirm `GOOGLE_GROUPS_LIST_IDS` + IMAP credentials and let sync run."
        />
      ) : null}

      <section className="vibe-panel rounded-xl p-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="vibe-title text-lg">Group Tracker</h2>
            <p className="text-xs text-slate-400">
              Select a group, then work the ranked queue below instead of raw chronological spam.
            </p>
          </div>
          <label className="flex min-w-[280px] flex-col gap-1 text-xs text-slate-400">
            Active group
            <select
              className="vibe-input rounded-md px-3 py-2 text-sm text-slate-100"
              value={spaces.selected_space || ""}
              onChange={(event) => {
                setLoading(true);
                setSelectedSpace(event.target.value);
              }}
            >
              {spaces.spaces.map((space) => (
                <option key={space.key} value={space.room_id}>
                  {space.room_name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="max-h-80 overflow-auto rounded-lg border border-slate-700/70">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Group</th>
                <th className="px-3 py-2 text-right">Msgs</th>
                <th className="px-3 py-2 text-right">People</th>
                <th className="px-3 py-2 text-left">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {spaces.spaces.map((space) => (
                <tr
                  key={space.key}
                  className={`border-t border-slate-800/80 ${
                    space.room_id === spaces.selected_space
                      ? "bg-cyan-400/10"
                      : "hover:bg-slate-900/50"
                  }`}
                >
                  <td className="px-3 py-2 text-slate-200">{space.room_name}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{space.messages}</td>
                  <td className="px-3 py-2 text-right text-slate-300">{space.people}</td>
                  <td className="px-3 py-2 text-slate-400">{space.last_seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="vibe-panel rounded-xl p-5">
          <h3 className="vibe-title text-lg">Top Topics in Queue</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {spaces.top_topics.length === 0 ? (
              <p className="text-sm text-slate-400">No topic tags in current queue.</p>
            ) : (
              spaces.top_topics.map((topic) => (
                <span key={topic.topic} className="vibe-chip rounded-md px-2 py-1 text-xs">
                  {topic.topic} · {topic.messages}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="vibe-panel rounded-xl p-5">
          <h3 className="vibe-title text-lg">Top Voices in Queue</h3>
          <div className="mt-3 space-y-2 text-sm">
            {spaces.top_people.length === 0 ? (
              <p className="text-sm text-slate-400">No people stats in current queue.</p>
            ) : (
              spaces.top_people.map((person) => (
                <div
                  key={person.sender_name}
                  className="rounded-md border border-slate-700/80 bg-slate-900/45 px-3 py-2"
                >
                  <div className="font-medium text-slate-200">{person.sender_name}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    {person.messages} msgs · avg rel {person.avg_relevance}
                    {person.contributions > 0 ? ` · ${person.contributions} contribution` : ""}
                    {person.hot_alerts > 0 ? ` · ${person.hot_alerts} hot` : ""}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="vibe-panel rounded-xl p-5">
        <h2 className="vibe-title text-lg">
          Ranked Queue: {selectedSpaceMeta?.room_name || "N/A"}
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Showing up to {spaces.triage.max_messages} items after triage filters.
        </p>
        <div className="mt-3 space-y-2">
          {spaces.recent_messages.length === 0 ? (
            <p className="text-sm text-slate-400">
              No messages match this triage setup. Lower min relevance or switch to Explore.
            </p>
          ) : (
            spaces.recent_messages.map((message) => (
              <div
                key={message.id}
                className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span>
                    {message.date} · {message.sender_name}
                  </span>
                  <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-slate-300">
                    score {message.priority_score}
                  </span>
                  {message.relevance_score !== null ? (
                    <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-cyan-300">
                      rel {message.relevance_score}
                    </span>
                  ) : null}
                  {(message.contribution_flag || 0) > 0 ? (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">
                      contribution
                    </span>
                  ) : null}
                  {message.alert_level === "hot" ? (
                    <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-rose-300">hot</span>
                  ) : null}
                </div>
                <p className="text-sm text-slate-200">{excerpt(message.body)}</p>
                {message.topics.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {message.topics.slice(0, 5).map((topic) => (
                      <span key={`${message.id}:${topic}`} className="vibe-chip rounded px-2 py-0.5 text-xs">
                        {topic}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
