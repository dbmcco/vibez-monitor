"use client";

import { useEffect, useMemo, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

type DayRange = 14 | 30 | 90 | "all";

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
  recent_messages: RecentMessage[];
}

function excerpt(text: string, max = 180): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no body)";
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export default function SpacesPage() {
  const [days, setDays] = useState<DayRange>(30);
  const [selectedSpace, setSelectedSpace] = useState<string>("");
  const [spaces, setSpaces] = useState<SpacesDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    params.set("days", String(days));
    if (selectedSpace) params.set("space", selectedSpace);
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
  }, [days, selectedSpace]);

  const selectedSpaceMeta = useMemo(() => {
    if (!spaces?.selected_space) return null;
    return spaces.spaces.find((space) => space.room_id === spaces.selected_space) || null;
  }, [spaces]);

  if (loading) {
    return (
      <StatusPanel
        loading
        title="Loading Google Groups"
        detail="Preparing group-level monitoring views."
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
          Track Google Groups ingestion only, with quick drilldown by group.
        </p>
      </header>

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

      <div className="rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-100">
        {scopeLabel}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Messages</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.totals.messages}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">Rooms</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.totals.rooms}</div>
        </div>
        <div className="vibe-panel rounded-xl p-4">
          <div className="text-xs text-slate-400">People</div>
          <div className="vibe-title mt-1 text-2xl">{spaces.totals.people}</div>
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
              Pick a group to inspect that stream independently from the rest of the corpus.
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
                    space.room_id === spaces.selected_space ? "bg-cyan-400/10" : "hover:bg-slate-900/50"
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

      <section className="vibe-panel rounded-xl p-5">
        <h2 className="vibe-title text-lg">
          Recent Group Stream: {selectedSpaceMeta?.room_name || "N/A"}
        </h2>
        <div className="mt-3 space-y-2">
          {spaces.recent_messages.length === 0 ? (
            <p className="text-sm text-slate-400">No messages yet for this room in the selected window.</p>
          ) : (
            spaces.recent_messages.slice(0, 40).map((message) => (
              <div
                key={message.id}
                className="rounded-lg border border-slate-700/70 bg-slate-900/45 p-3"
              >
                <div className="mb-1 text-xs text-slate-400">
                  {message.date} · {message.sender_name}
                  {message.relevance_score !== null ? (
                    <span className="ml-2 text-cyan-300">rel {message.relevance_score}</span>
                  ) : null}
                </div>
                <p className="text-sm text-slate-200">{excerpt(message.body)}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
