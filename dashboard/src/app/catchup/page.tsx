// ABOUTME: Catchup page — preset + custom date range window selector with on-demand synthesis.
// ABOUTME: Renders catchup_memo, hot_on_return, arcs, unresolved_threads, people, themes, trends, links.

"use client";

import { useState } from "react";

interface CatchupArc {
  title: string;
  participants: string[];
  core_exchange: string;
  why_it_matters: string;
  likely_next: string;
}

interface CatchupLink {
  url: string;
  title: string;
  category: string;
  relevance: string;
}

interface CatchupResult {
  catchup_memo: string;
  conversation_arcs: CatchupArc[];
  themes: string[];
  trends: {
    emerging?: string[];
    fading?: string[];
    shifts?: string;
  };
  links: CatchupLink[];
  people_activity: Array<{ name: string; role: string }>;
  unresolved_threads: Array<{ title: string; status: string }>;
  hot_on_return: Array<{ title: string; why_hot: string }>;
}

const PRESETS = [
  { key: "weekend", label: "Weekend" },
  { key: "3days", label: "3 Days" },
  { key: "1week", label: "1 Week" },
  { key: "2weeks", label: "2 Weeks" },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computePresetDates(preset: PresetKey): { start: string; end: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (preset === "weekend") {
    const day = today.getDay();
    const daysToLastSunday = day === 0 ? 7 : day;
    const lastSunday = new Date(today);
    lastSunday.setDate(today.getDate() - daysToLastSunday);
    const lastSaturday = new Date(lastSunday);
    lastSaturday.setDate(lastSunday.getDate() - 1);
    return {
      start: formatLocalDate(lastSaturday),
      end: formatLocalDate(lastSunday),
    };
  }

  const presetDays: Record<Exclude<PresetKey, "weekend">, number> = {
    "3days": 3,
    "1week": 7,
    "2weeks": 14,
  };
  const days = presetDays[preset as Exclude<PresetKey, "weekend">];
  const start = new Date(today);
  start.setDate(today.getDate() - days);
  const end = new Date(today);
  end.setDate(today.getDate() - 1);
  return { start: formatLocalDate(start), end: formatLocalDate(end) };
}

export default function CatchupPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [activePreset, setActivePreset] = useState<PresetKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CatchupResult | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trendData = {
    emerging: result?.trends?.emerging ?? [],
    fading: result?.trends?.fading ?? [],
    shifts: result?.trends?.shifts ?? "",
  };
  const hasRenderableContent = Boolean(
    result &&
      (result.catchup_memo.trim() ||
        result.hot_on_return.length > 0 ||
        result.conversation_arcs.length > 0 ||
        result.unresolved_threads.length > 0 ||
        result.people_activity.length > 0 ||
        result.themes.length > 0 ||
        trendData.emerging.length > 0 ||
        trendData.fading.length > 0 ||
        trendData.shifts.trim() ||
        result.links.length > 0)
  );

  function handlePreset(preset: PresetKey) {
    const dates = computePresetDates(preset);
    setStart(dates.start);
    setEnd(dates.end);
    setActivePreset(preset);
  }

  async function handleGenerate() {
    if (!start || !end) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setFromCache(false);
    try {
      const params = new URLSearchParams({ start, end });
      const response = await fetch(`/api/catchup?${params.toString()}`);
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Request failed");
      }
      const body = (await response.json()) as {
        result: CatchupResult;
        cached: boolean;
      };
      setResult(body.result);
      setFromCache(body.cached);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Catchup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Get up to speed on what happened while you were away.
        </p>
      </div>

      {/* Window selector */}
      <div className="vibe-panel rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => handlePreset(p.key)}
              className={`vibe-button rounded px-3 py-1.5 text-sm ${
                activePreset === p.key ? "ring-2 ring-cyan-400/60" : ""
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400" htmlFor="catchup-start">
              From
            </label>
            <input
              id="catchup-start"
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setActivePreset(null);
              }}
              className="vibe-input rounded px-2 py-1 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-400" htmlFor="catchup-end">
              To
            </label>
            <input
              id="catchup-end"
              type="date"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                setActivePreset(null);
              }}
              className="vibe-input rounded px-2 py-1 text-sm"
            />
          </div>
          <button
            onClick={() => void handleGenerate()}
            disabled={!start || !end || loading}
            className="vibe-button rounded px-4 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate"}
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-3 text-slate-400 text-sm">
          <span className="vibe-spinner inline-block h-4 w-4 rounded-full border-2 border-slate-600 border-t-cyan-400" />
          Synthesizing {start} to {end}...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded border border-red-700/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-6">
          {fromCache && (
            <p className="text-xs text-slate-500">Cached result</p>
          )}

          {!hasRenderableContent && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                No Catchup Yet
              </h2>
              <p className="mt-2 text-sm text-slate-300">
                No stored daily briefing content was available for this time window.
              </p>
            </div>
          )}

          {/* Catchup memo */}
          {result.catchup_memo && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-cyan-400">
                What You Missed
              </h2>
              <p className="text-sm text-slate-200 leading-relaxed">
                {result.catchup_memo}
              </p>
            </div>
          )}

          {/* Hot on return */}
          {result.hot_on_return.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-amber-400">
                Re-Engage Here First
              </h2>
              <ul className="space-y-3">
                {result.hot_on_return.map((item, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-slate-100">
                      {item.title}
                    </span>
                    <span className="text-xs text-slate-400">
                      {item.why_hot}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Conversation arcs */}
          {result.conversation_arcs.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Conversation Arcs
              </h2>
              {result.conversation_arcs.map((arc, i) => (
                <div key={i} className="vibe-panel rounded-lg p-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-100">
                      {arc.title}
                    </h3>
                    {arc.participants.length > 0 && (
                      <span className="text-xs text-slate-500">
                        {arc.participants.join(", ")}
                      </span>
                    )}
                  </div>
                  {arc.core_exchange && (
                    <p className="text-sm text-slate-300">{arc.core_exchange}</p>
                  )}
                  {arc.why_it_matters && (
                    <p className="text-xs text-slate-400">
                      <span className="text-slate-500">Why it matters: </span>
                      {arc.why_it_matters}
                    </p>
                  )}
                  {arc.likely_next && (
                    <p className="text-xs text-slate-400">
                      <span className="text-slate-500">Likely next: </span>
                      {arc.likely_next}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Unresolved threads */}
          {result.unresolved_threads.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Still Open
              </h2>
              <ul className="space-y-3">
                {result.unresolved_threads.map((t, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium text-slate-100">
                      {t.title}
                    </span>
                    <span className="text-xs text-slate-400">{t.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* People activity */}
          {result.people_activity.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Who Drove Things
              </h2>
              <ul className="space-y-2">
                {result.people_activity.map((p, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="text-sm font-medium text-slate-100 min-w-[100px]">
                      {p.name}
                    </span>
                    <span className="text-xs text-slate-400">{p.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Themes */}
          {result.themes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {result.themes.map((theme, i) => (
                <span key={i} className="vibe-chip rounded px-2 py-0.5 text-xs">
                  {theme}
                </span>
              ))}
            </div>
          )}

          {/* Trends */}
          {(trendData.emerging.length > 0 ||
            trendData.fading.length > 0 ||
            trendData.shifts) && (
            <div className="vibe-panel rounded-lg p-4 space-y-2">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Trends
              </h2>
              {trendData.shifts && (
                <p className="text-sm text-slate-300 italic">
                  {trendData.shifts}
                </p>
              )}
              {trendData.emerging.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">Emerging:</span>
                  {trendData.emerging.map((t, i) => (
                    <span
                      key={i}
                      className="badge-warm rounded px-1.5 py-0.5 text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {trendData.fading.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">Fading:</span>
                  {trendData.fading.map((t, i) => (
                    <span
                      key={i}
                      className="badge-archive rounded px-1.5 py-0.5 text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Links */}
          {result.links.length > 0 && (
            <div className="vibe-panel rounded-lg p-4">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Links Shared
              </h2>
              <ul className="space-y-3">
                {result.links.map((link, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-cyan-400 hover:underline"
                    >
                      {link.title || link.url}
                    </a>
                    {link.relevance && (
                      <span className="text-xs text-slate-400">
                        {link.relevance}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
