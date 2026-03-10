// ABOUTME: Links page with NLP search, source/sharer filtering, sort, and browse.
// ABOUTME: Table-style layout for 2,700+ links with one-line descriptions.

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
  { key: "trending", label: "Trending" },
  { key: "recent", label: "Recent" },
  { key: "shared", label: "Most shared" },
  { key: "oldest", label: "Oldest" },
] as const;

const TIME_RANGES = [
  { key: "7", label: "Week" },
  { key: "14", label: "2w" },
  { key: "30", label: "Month" },
  { key: "90", label: "3mo" },
  { key: "", label: "All" },
] as const;

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function categoryBadge(cat: string | null): { color: string; label: string } | null {
  switch (cat) {
    case "tool": return { color: "text-emerald-400", label: "tool" };
    case "repo": return { color: "text-violet-400", label: "repo" };
    case "article": return { color: "text-amber-400", label: "article" };
    case "discussion": return { color: "text-sky-400", label: "disc" };
    default: return null;
  }
}

function extractDescription(link: Link): string {
  // Synthesis-extracted links have good titles that ARE the description
  const title = link.title || "";
  const domain = hostname(link.url);

  // If title is a real description (not just a domain), use it
  if (title && title !== domain && title.length > domain.length + 5) {
    return title;
  }

  // Otherwise, try to extract a one-liner from relevance
  if (link.relevance) {
    let text = link.relevance;
    // Strip topic fingerprints
    text = text.replace(/\s*\[[\w\s,+\-.'()]+\s+topics:.*?\]\s*/g, "");
    // Strip URLs
    text = text.replace(/https?:\/\/\S+/g, "");
    // Split on pipe separators and take first meaningful chunk
    const chunks = text.split(/\s*\|\s*/).filter((c) => c.trim().length > 10);
    if (chunks.length > 0) {
      let desc = chunks[0].trim();
      // Cap at ~120 chars on a sentence boundary if possible
      if (desc.length > 120) {
        const cut = desc.lastIndexOf(".", 120);
        desc = cut > 40 ? desc.slice(0, cut + 1) : desc.slice(0, 120) + "...";
      }
      return desc;
    }
  }

  return "";
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function firstName(name: string): string {
  return name.split(",")[0].split(" ")[0];
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
        active
          ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
          : "border-slate-700/50 text-slate-500 hover:border-slate-500 hover:text-slate-400"
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
  const [sort, setSort] = useState("trending");
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
      params.set("limit", "100");
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
    fetchLinks("", "all", "trending", "", "");
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

  const topSharers = (stats?.sharers || [])
    .filter((s) => s.name !== "whatsappbot" && !s.name.startsWith("+"))
    .slice(0, 10);

  return (
    <div className="fade-up space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="vibe-title text-2xl text-slate-100">Links</h1>
          <p className="vibe-subtitle text-sm">Browse or search {stats ? stats.total.toLocaleString() : ""} shared links.</p>
        </div>
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

      {/* Filters - compact single row groups */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">Source</span>
          {SOURCES.map((s) => {
            const count = stats?.sources.find((x) => x.name === s.key)?.count;
            return (
              <Pill key={s.key} active={source === s.key} onClick={() => applyFilter(s.key)}>
                {s.label}{count ? <span className="ml-0.5 opacity-50">{count}</span> : null}
              </Pill>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">Sort</span>
            {SORTS.map((s) => (
              <Pill key={s.key} active={sort === s.key} onClick={() => applyFilter(undefined, s.key)}>
                {s.label}
              </Pill>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Time</span>
            {TIME_RANGES.map((t) => (
              <Pill key={t.key} active={days === t.key} onClick={() => applyFilter(undefined, undefined, t.key)}>
                {t.label}
              </Pill>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">From</span>
          <Pill active={sharedBy === ""} onClick={() => applyFilter(undefined, undefined, undefined, "")}>
            Anyone
          </Pill>
          {topSharers.map((s) => (
            <Pill
              key={s.name}
              active={sharedBy === s.name}
              onClick={() => applyFilter(undefined, undefined, undefined, s.name)}
            >
              {firstName(s.name)}<span className="ml-0.5 opacity-50">{s.count}</span>
            </Pill>
          ))}
        </div>
      </div>

      {/* Results */}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}

      {!loading && links.length === 0 && (
        <p className="py-8 text-center text-sm text-slate-500">
          {query ? `No links match "${query}"` : "No links match these filters."}
        </p>
      )}

      {/* Table */}
      {!loading && links.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-800/60">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800/60 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2">Link</th>
                <th className="hidden px-3 py-2 sm:table-cell">From</th>
                <th className="px-3 py-2 text-right">When</th>
                <th className="px-3 py-2 text-right">Shares</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40">
              {links.map((link) => {
                const domain = hostname(link.url);
                const desc = extractDescription(link);
                const badge = categoryBadge(link.category);
                const sharer = link.shared_by ? firstName(link.shared_by) : "";

                return (
                  <tr key={link.id} className="group transition hover:bg-slate-800/20">
                    <td className="px-3 py-2">
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-slate-200 group-hover:text-cyan-300">
                            {domain}
                          </span>
                          {badge && (
                            <span className={`shrink-0 text-[10px] ${badge.color}`}>{badge.label}</span>
                          )}
                        </div>
                        {desc && (
                          <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{desc}</p>
                        )}
                      </a>
                    </td>
                    <td className="hidden px-3 py-2 text-xs text-slate-500 sm:table-cell">
                      {sharer}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">
                      {formatDate(link.last_seen)}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-slate-500">
                      {link.mention_count > 1 ? `${link.mention_count}x` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && links.length > 0 && (
        <p className="text-center text-[11px] text-slate-600">
          {links.length} of {stats?.total.toLocaleString() || "?"} links
        </p>
      )}
    </div>
  );
}
