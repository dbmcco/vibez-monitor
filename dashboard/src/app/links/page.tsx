// ABOUTME: Links page with NLP search, source/sharer filtering, sort, and browse.
// ABOUTME: Responsive browse view with mobile cards, category filters, and local starring.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StarButton } from "@/components/StarButton";
import { linkStarKey, useStars } from "@/lib/stars";

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
  authored_by: string | null;
}

interface LinkStats {
  total: number;
  sources: { name: string; count: number }[];
  sharers: { name: string; count: number }[];
  categories: { name: string; count: number }[];
  authors: { name: string; count: number }[];
}

interface LinkFilters {
  query: string;
  source: string;
  category: string;
  sort: string;
  days: string;
  sharedBy: string;
  authoredBy: string;
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

const INITIAL_FILTERS: LinkFilters = {
  query: "",
  source: "all",
  category: "all",
  sort: "trending",
  days: "",
  sharedBy: "",
  authoredBy: "",
};

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function smartTitle(link: Link): string {
  const { url, title } = link;
  // Use stored title if it's actually meaningful (not just the domain/hostname)
  const host = hostname(url);
  if (title && title !== host && !title.endsWith(".com") && !title.endsWith(".io") && !title.endsWith(".org") && title.length > host.length + 3) {
    return title;
  }
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    const parts = path.split("/").filter(Boolean);
    // GitHub: github.com/owner/repo, github.com/owner/repo/issues/123, etc.
    if (parsed.hostname.includes("github.com") && parts.length >= 2) {
      const base = `${parts[0]}/${parts[1]}`;
      if (parts[2] === "issues" || parts[2] === "pull") return `${base} #${parts[3] ?? ""}`.trim();
      if (parts[2] === "discussions") return `${base} discussion`;
      if (parts[2]) return `${base}/${parts.slice(2).join("/")}`;
      return base;
    }
    // Gist: gist.github.com/user/hash
    if (parsed.hostname === "gist.github.com" && parts.length >= 1) {
      return `gist by ${parts[0]}`;
    }
    // Twitter/X: x.com/user/status/id → "@user"
    if ((parsed.hostname.includes("x.com") || parsed.hostname.includes("twitter.com")) && parts[0]) {
      return `@${parts[0]} on ${parsed.hostname.includes("x.com") ? "X" : "Twitter"}`;
    }
    // YouTube: use title if available, else "YouTube video"
    if (parsed.hostname.includes("youtube.com") || parsed.hostname === "youtu.be") {
      return title || "YouTube video";
    }
    // Substack: user.substack.com/p/slug → humanise slug
    if (parsed.hostname.endsWith(".substack.com") && parts[0] === "p" && parts[1]) {
      return parts[1].replace(/-/g, " ");
    }
    // Generic: if path has a meaningful last segment, humanise it
    const last = parts[parts.length - 1];
    if (last && last.length > 4 && !last.match(/^\d+$/)) {
      return last.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
    }
  } catch {
    // fall through
  }
  return host;
}

function authoredBadge(authoredBy: string | null): string | null {
  if (!authoredBy) return null;
  return firstName(authoredBy);
}

function categoryBadge(cat: string | null): { color: string; label: string } | null {
  switch (cat) {
    case "tool":
      return { color: "text-emerald-400", label: "tool" };
    case "repo":
      return { color: "text-violet-400", label: "repo" };
    case "article":
      return { color: "text-amber-400", label: "article" };
    case "discussion":
      return { color: "text-sky-400", label: "disc" };
    default:
      return null;
  }
}

function extractDescription(link: Link): string {
  const title = link.title || "";
  const domain = hostname(link.url);

  if (title && title !== domain && title.length > domain.length + 5) {
    return title;
  }

  if (link.relevance) {
    let text = link.relevance;
    text = text.replace(/\s*\[[\w\s,+\-.'()]+\s+topics:.*?\]\s*/g, "");
    text = text.replace(/https?:\/\/\S+/g, "");
    const chunks = text.split(/\s*\|\s*/).filter((chunk) => chunk.trim().length > 10);
    if (chunks.length > 0) {
      let desc = chunks[0].trim();
      if (desc.length > 120) {
        const cut = desc.lastIndexOf(".", 120);
        desc = cut > 40 ? desc.slice(0, cut + 1) : `${desc.slice(0, 120)}...`;
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
  const [query, setQuery] = useState(INITIAL_FILTERS.query);
  const [source, setSource] = useState(INITIAL_FILTERS.source);
  const [category, setCategory] = useState(INITIAL_FILTERS.category);
  const [sort, setSort] = useState(INITIAL_FILTERS.sort);
  const [days, setDays] = useState(INITIAL_FILTERS.days);
  const [sharedBy, setSharedBy] = useState(INITIAL_FILTERS.sharedBy);
  const [authoredBy, setAuthoredBy] = useState(INITIAL_FILTERS.authoredBy);
  const [starredOnly, setStarredOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { stars, isLinkStarred, toggleLinkStar } = useStars();

  const fetchLinks = useCallback(async (filters: LinkFilters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.query) params.set("q", filters.query);
      if (filters.source !== "all") params.set("source", filters.source);
      if (filters.category !== "all") params.set("category", filters.category);
      if (filters.days) params.set("days", filters.days);
      if (filters.sharedBy) params.set("shared_by", filters.sharedBy);
      if (filters.authoredBy) params.set("authored_by", filters.authoredBy);
      params.set("sort", filters.sort);
      params.set("limit", "100");
      const res = await fetch(`/api/links?${params.toString()}`);
      const data = await res.json();
      setLinks(Array.isArray(data.links) ? data.links : []);
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
    } catch {
      // Ignore stats load failures; browse still works with fetched links.
    }
  }, []);

  useEffect(() => {
    void fetchLinks(INITIAL_FILTERS);
    void fetchStats();

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchLinks, fetchStats]);

  function currentFilters(overrides: Partial<LinkFilters> = {}): LinkFilters {
    return {
      query,
      source,
      category,
      sort,
      days,
      sharedBy,
      authoredBy,
      ...overrides,
    };
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const nextFilters = currentFilters({ query: value });
    debounceRef.current = setTimeout(() => {
      void fetchLinks(nextFilters);
    }, 350);
  }

  function applyFilter(next: Partial<Omit<LinkFilters, "query">>) {
    const merged = currentFilters(next);
    if (next.source !== undefined) setSource(merged.source);
    if (next.category !== undefined) setCategory(merged.category);
    if (next.sort !== undefined) setSort(merged.sort);
    if (next.days !== undefined) setDays(merged.days);
    if (next.sharedBy !== undefined) setSharedBy(merged.sharedBy);
    if (next.authoredBy !== undefined) setAuthoredBy(merged.authoredBy);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void fetchLinks(merged);
  }

  const topSharers = (stats?.sharers || [])
    .filter((entry) => entry.name !== "whatsappbot" && !entry.name.startsWith("+"))
    .slice(0, 10);
  const topCategories = (stats?.categories || []).slice(0, 8);
  const topAuthors = (stats?.authors || []).slice(0, 10);
  const visibleLinks = starredOnly
    ? links.filter((link) => Boolean(stars.links[linkStarKey(link.url)]))
    : links;
  const starredCount = Object.keys(stars.links).length;

  return (
    <div className="fade-up space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="vibe-title text-2xl text-slate-100">Links</h1>
          <p className="vibe-subtitle text-sm">
            Browse or search {stats ? stats.total.toLocaleString() : ""} shared links.
          </p>
        </div>
        <div className="hidden rounded-full border border-slate-700/60 bg-slate-950/70 px-3 py-1 text-xs text-slate-400 sm:block">
          {starredCount} starred
        </div>
      </header>

      <input
        type="text"
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        placeholder="Search: 'trycycle', 'agent sandboxing', 'that repo Dan shared'..."
        className="vibe-input w-full rounded-lg px-4 py-2.5 text-sm"
        aria-label="Search links"
      />

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
            Source
          </span>
          {SOURCES.map((entry) => {
            const count = stats?.sources.find((sourceEntry) => sourceEntry.name === entry.key)?.count;
            return (
              <Pill key={entry.key} active={source === entry.key} onClick={() => applyFilter({ source: entry.key })}>
                {entry.label}
                {count ? <span className="ml-0.5 opacity-50"> {count}</span> : null}
              </Pill>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
            Type
          </span>
          <Pill active={category === "all"} onClick={() => applyFilter({ category: "all" })}>
            All
          </Pill>
          {topCategories.map((entry) => (
            <Pill
              key={entry.name}
              active={category === entry.name}
              onClick={() => applyFilter({ category: entry.name })}
            >
              {entry.name}
              <span className="ml-0.5 opacity-50"> {entry.count}</span>
            </Pill>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
              Sort
            </span>
            {SORTS.map((entry) => (
              <Pill key={entry.key} active={sort === entry.key} onClick={() => applyFilter({ sort: entry.key })}>
                {entry.label}
              </Pill>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-600">Time</span>
            {TIME_RANGES.map((entry) => (
              <Pill key={entry.key} active={days === entry.key} onClick={() => applyFilter({ days: entry.key })}>
                {entry.label}
              </Pill>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
            From
          </span>
          <Pill active={sharedBy === ""} onClick={() => applyFilter({ sharedBy: "" })}>
            Anyone
          </Pill>
          {topSharers.map((entry) => (
            <Pill
              key={entry.name}
              active={sharedBy === entry.name}
              onClick={() => applyFilter({ sharedBy: entry.name })}
            >
              {firstName(entry.name)}
              <span className="ml-0.5 opacity-50"> {entry.count}</span>
            </Pill>
          ))}
        </div>

        {topAuthors.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
              Author
            </span>
            <Pill active={authoredBy === ""} onClick={() => applyFilter({ authoredBy: "" })}>
              All
            </Pill>
            <Pill active={authoredBy === "any"} onClick={() => applyFilter({ authoredBy: "any" })}>
              Members
            </Pill>
            {topAuthors.map((entry) => (
              <Pill
                key={entry.name}
                active={authoredBy === entry.name}
                onClick={() => applyFilter({ authoredBy: entry.name })}
              >
                {firstName(entry.name)}
                <span className="ml-0.5 opacity-50"> {entry.count}</span>
              </Pill>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1">
          <span className="w-12 text-[10px] font-medium uppercase tracking-wider text-slate-600">
            Saved
          </span>
          <Pill active={!starredOnly} onClick={() => setStarredOnly(false)}>
            All
          </Pill>
          <Pill active={starredOnly} onClick={() => setStarredOnly(true)}>
            Starred
            <span className="ml-0.5 opacity-50"> {starredCount}</span>
          </Pill>
        </div>
      </div>

      {loading ? <p className="text-sm text-slate-500">Loading...</p> : null}

      {!loading && visibleLinks.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">
          {query
            ? `No links match "${query}".`
            : starredOnly
              ? "No starred links match these filters."
              : "No links match these filters."}
        </p>
      ) : null}

      {!loading && visibleLinks.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-3 sm:hidden">
            {visibleLinks.map((link) => {
              const displayTitle = smartTitle(link);
              const desc = extractDescription(link);
              const badge = categoryBadge(link.category);
              const sharer = link.shared_by ? firstName(link.shared_by) : "";
              const author = authoredBadge(link.authored_by);

              return (
                <article key={link.id} className="vibe-panel rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block min-w-0 flex-1"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-slate-200" title={link.url}>{displayTitle}</span>
                        {badge ? <span className={`shrink-0 text-[10px] ${badge.color}`}>{badge.label}</span> : null}
                        {author ? (
                          <span className="shrink-0 rounded-full border border-rose-800/50 bg-rose-950/30 px-1.5 py-0 text-[10px] text-rose-300">
                            ✍ {author}
                          </span>
                        ) : null}
                      </div>
                      {desc ? <p className="mt-1 text-sm text-slate-400">{desc}</p> : null}
                    </a>
                    <StarButton
                      compact
                      active={isLinkStarred(link.url)}
                      label={link.url}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleLinkStar(link.url);
                      }}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                    {sharer ? (
                      <span className="rounded-full border border-slate-800/60 px-2 py-0.5">from {sharer}</span>
                    ) : null}
                    {link.last_seen ? (
                      <span className="rounded-full border border-slate-800/60 px-2 py-0.5">
                        {formatDate(link.last_seen)}
                      </span>
                    ) : null}
                    {link.mention_count > 1 ? (
                      <span className="rounded-full border border-slate-800/60 px-2 py-0.5">
                        {link.mention_count} mentions
                      </span>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden overflow-hidden rounded-lg border border-slate-800/60 sm:block">
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
                {visibleLinks.map((link) => {
                  const displayTitle = smartTitle(link);
                  const desc = extractDescription(link);
                  const badge = categoryBadge(link.category);
                  const sharer = link.shared_by ? firstName(link.shared_by) : "";
                  const author = authoredBadge(link.authored_by);

                  return (
                    <tr key={link.id} className="group transition hover:bg-slate-800/20">
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-3">
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block min-w-0 flex-1"
                          >
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-slate-200 group-hover:text-cyan-300" title={link.url}>
                                {displayTitle}
                              </span>
                              {badge ? (
                                <span className={`shrink-0 text-[10px] ${badge.color}`}>{badge.label}</span>
                              ) : null}
                              {author ? (
                                <span className="shrink-0 rounded-full border border-rose-800/50 bg-rose-950/30 px-1.5 py-0 text-[10px] text-rose-300">
                                  ✍ {author}
                                </span>
                              ) : null}
                            </div>
                            {desc ? <p className="mt-0.5 line-clamp-1 text-xs text-slate-400">{desc}</p> : null}
                          </a>
                          <StarButton
                            compact
                            active={isLinkStarred(link.url)}
                            label={link.url}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleLinkStar(link.url);
                            }}
                          />
                        </div>
                      </td>
                      <td className="hidden px-3 py-2 text-xs text-slate-500 sm:table-cell">{sharer}</td>
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
        </div>
      ) : null}

      {!loading && visibleLinks.length > 0 ? (
        <p className="text-center text-[11px] text-slate-600">
          {visibleLinks.length} of {stats?.total.toLocaleString() || "?"} links
        </p>
      ) : null}
    </div>
  );
}
