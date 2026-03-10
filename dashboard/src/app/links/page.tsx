// ABOUTME: Links page with NLP search, source/sharer filtering, sort, and browse.
// ABOUTME: 2,700+ links from chat — discoverable via search, source, person, or sort.

"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface Link {
  id: number;
  url: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  first_seen: string | null;
  last_seen: string | null;
  mention_count: number;
  value_score: number;
}

interface LinkStats {
  total: number;
  sources: { name: string; count: number }[];
  sharers: { name: string; count: number }[];
  categories: { name: string; count: number }[];
}

const SOURCES = [
  { key: "all", label: "All" },
  { key: "github", label: "GitHub" },
  { key: "x", label: "X" },
  { key: "youtube", label: "YouTube" },
  { key: "substack", label: "Substack" },
  { key: "arxiv", label: "arXiv" },
  { key: "reddit", label: "Reddit" },
  { key: "hackernews", label: "HN" },
  { key: "medium", label: "Medium" },
] as const;

const SORTS = [
  { key: "value", label: "Top" },
  { key: "shared", label: "Most shared" },
  { key: "recent", label: "Recent" },
  { key: "oldest", label: "Oldest" },
] as const;

const TIME_RANGES = [
  { key: "7", label: "Week" },
  { key: "14", label: "2 weeks" },
  { key: "30", label: "Month" },
  { key: "90", label: "3 months" },
  { key: "", label: "All time" },
] as const;

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function categoryColor(cat: string | null): string {
  switch (cat) {
    case "tool": return "border-emerald-400/50 text-emerald-300";
    case "repo": return "border-violet-400/50 text-violet-300";
    case "article": return "border-amber-400/50 text-amber-300";
    case "discussion": return "border-sky-400/50 text-sky-300";
    default: return "";
  }
}

function cleanRelevance(text: string): string {
  // Strip sender topic fingerprints
  let clean = text.replace(/\s*\[[\w\s,+\-.'()]+ topics:.*?\]\s*/g, "").trim();
  // Strip repeated URL segments
  clean = clean.replace(/https?:\/\/\S+/g, "").trim();
  // Collapse repeated pipe separators
  clean = clean.replace(/(\s*\|\s*)+/g, " — ").trim();
  // Remove leading/trailing dashes
  clean = clean.replace(/^[\s—-]+|[\s—-]+$/g, "").trim();
  return clean;
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${
        active
          ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
          : "border-slate-700/60 bg-slate-900/30 text-slate-400 hover:border-slate-500"
      }`}
    >
      {children}
    </button>
  );
}

export default function LinksPage() {
  const [links, setLinks] = useState<Link[]>([]);
  const [stats, setStats] = useState<LinkStats | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("value");
  const [days, setDays] = useState("");
  const [sharedBy, setSharedBy] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchLinks = useCallback(async (q: string, src: string, srt: string, d: string, sharer: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (src !== "all") params.set("source", src);
      if (d) params.set("days", d);
      if (sharer) params.set("shared_by", sharer);
      params.set("sort", srt);
      params.set("limit", "80");
      const res = await fetch(`/api/links?${params}`);
      const data = await res.json();
      setLinks(data.links || []);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/links?stats=1");
      const data = await res.json();
      setStats(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchLinks("", "all", "value", "", "");
    fetchStats();
  }, [fetchLinks, fetchStats]);

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchLinks(value, source, sort, days, sharedBy);
    }, 350);
  }

  function applyFilter(newSource?: string, newSort?: string, newDays?: string, newSharer?: string) {
    const s = newSource ?? source;
    const sr = newSort ?? sort;
    const d = newDays ?? days;
    const sh = newSharer ?? sharedBy;
    if (newSource !== undefined) setSource(s);
    if (newSort !== undefined) setSort(sr);
    if (newDays !== undefined) setDays(d);
    if (newSharer !== undefined) setSharedBy(sh);
    fetchLinks(query, s, sr, d, sh);
  }

  const topSharers = stats?.sharers.slice(0, 10) || [];

  return (
    <div className="fade-up space-y-4">
      <header className="space-y-1">
        <div className="flex items-baseline justify-between">
          <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">Links</h1>
          {stats && (
            <span className="text-xs text-slate-500">{stats.total.toLocaleString()} links indexed</span>
          )}
        </div>
        <p className="vibe-subtitle text-sm">Browse shared links or search by describing what you remember.</p>
      </header>

      {/* Search */}
      <input
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="Search: 'trycycle', 'agent sandboxing', 'that repo Dan shared'..."
        className="vibe-input w-full rounded-lg px-4 py-2.5 text-sm"
        aria-label="Search links"
      />

      {/* Filter bar */}
      <div className="space-y-2">
        {/* Source pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">Source</span>
          {SOURCES.map((s) => (
            <Pill key={s.key} active={source === s.key} onClick={() => applyFilter(s.key)}>
              {s.label}
              {stats && s.key !== "all" && (
                <span className="ml-1 opacity-60">
                  {stats.sources.find((x) => x.name === s.key)?.count || 0}
                </span>
              )}
            </Pill>
          ))}
        </div>

        {/* Sort + Time range */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">Sort</span>
            {SORTS.map((s) => (
              <Pill key={s.key} active={sort === s.key} onClick={() => applyFilter(undefined, s.key)}>
                {s.label}
              </Pill>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">Time</span>
            {TIME_RANGES.map((t) => (
              <Pill key={t.key} active={days === t.key} onClick={() => applyFilter(undefined, undefined, t.key)}>
                {t.label}
              </Pill>
            ))}
          </div>
        </div>

        {/* Shared-by pills */}
        {topSharers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">From</span>
            <Pill active={sharedBy === ""} onClick={() => applyFilter(undefined, undefined, undefined, "")}>
              Anyone
            </Pill>
            {topSharers.map((s) => (
              <Pill
                key={s.name}
                active={sharedBy === s.name}
                onClick={() => applyFilter(undefined, undefined, undefined, s.name)}
              >
                {s.name.split(" ")[0]}
                <span className="ml-1 opacity-60">{s.count}</span>
              </Pill>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      {loading && <p className="text-sm text-slate-400">Loading...</p>}

      {!loading && links.length === 0 && (
        <div className="vibe-panel rounded-xl p-6 text-center">
          <p className="text-sm text-slate-400">
            {query ? `No links found for "${query}"` : "No links match these filters"}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        {links.map((link) => {
          const domain = hostname(link.url);
          const displayTitle = link.title && link.title !== domain ? link.title : null;
          const relevanceClean = link.relevance ? cleanRelevance(link.relevance) : null;
          // Only show relevance if it's meaningful (not just the URL repeated)
          const showRelevance = relevanceClean && relevanceClean.length > 20
            && !relevanceClean.startsWith("http")
            && relevanceClean !== domain;

          return (
            <a
              key={link.id}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="vibe-panel group block rounded-lg px-4 py-2.5 transition hover:border-cyan-400/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100 group-hover:text-cyan-200">
                    {displayTitle || domain}
                  </p>
                  {displayTitle && (
                    <p className="mt-0.5 text-[11px] text-slate-500">{domain}</p>
                  )}
                  {showRelevance && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                      {relevanceClean}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                    {link.shared_by && <span>by {link.shared_by}</span>}
                    {link.source_group && <span>in {link.source_group}</span>}
                    {link.last_seen && (
                      <span>{new Date(link.last_seen).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {link.category && (
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] capitalize ${categoryColor(link.category)}`}>
                      {link.category}
                    </span>
                  )}
                  {link.mention_count > 1 && (
                    <span className="text-[10px] text-slate-500">
                      {link.mention_count}x shared
                    </span>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>

      {!loading && links.length > 0 && (
        <p className="text-center text-xs text-slate-600">
          Showing {links.length} of {stats?.total.toLocaleString() || "?"} links
        </p>
      )}
    </div>
  );
}
