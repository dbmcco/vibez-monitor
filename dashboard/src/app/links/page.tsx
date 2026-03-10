// ABOUTME: Links page with NLP search, category filtering, and value-ranked results.
// ABOUTME: Fetches from /api/links with debounced search and starter prompts.

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

const CATEGORIES = ["all", "tool", "repo", "article", "discussion"] as const;

const STARTER_PROMPTS = [
  "Repos shared this week",
  "Tools for agent orchestration",
  "Most discussed links",
  "Papers about transformers",
];

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
    default: return "border-slate-600 text-slate-400";
  }
}

export default function LinksPage() {
  const [links, setLinks] = useState<Link[]>([]);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchLinks = useCallback(async (q: string, cat: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (cat !== "all") params.set("category", cat);
      params.set("days", "30");
      params.set("limit", "60");
      const res = await fetch(`/api/links?${params}`);
      const data = await res.json();
      setLinks(data.links || []);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLinks("", "all");
  }, [fetchLinks]);

  function handleQueryChange(value: string) {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchLinks(value, activeCategory);
    }, 300);
  }

  function handleCategoryChange(cat: string) {
    setActiveCategory(cat);
    fetchLinks(query, cat);
  }

  function handlePrompt(prompt: string) {
    setQuery(prompt);
    fetchLinks(prompt, activeCategory);
  }

  return (
    <div className="fade-up space-y-6">
      <header className="space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">Links</h1>
        <p className="vibe-subtitle">Search shared links by describing what you remember.</p>
      </header>

      <div className="space-y-3">
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Describe what you're looking for..."
          className="vibe-input w-full rounded-lg px-4 py-3 text-sm"
          aria-label="Search links"
        />

        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition ${
                activeCategory === cat
                  ? "border-cyan-400/60 bg-cyan-900/30 text-cyan-200"
                  : "border-slate-700/60 bg-slate-900/30 text-slate-400 hover:border-slate-500"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <p className="text-sm text-slate-400">Searching...</p>
      )}

      {!loading && links.length === 0 && !query && (
        <div className="vibe-panel rounded-xl p-6 text-center">
          <p className="mb-4 text-sm text-slate-300">Try a search</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => handlePrompt(prompt)}
                className="rounded-md border border-slate-700/70 bg-slate-900/45 px-3 py-2 text-left text-sm text-slate-400 hover:border-cyan-300/60 hover:text-slate-200"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && links.length === 0 && query && (
        <p className="text-sm text-slate-500">No links found for &quot;{query}&quot;</p>
      )}

      <div className="space-y-2">
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="vibe-panel block rounded-lg px-4 py-3 transition hover:border-cyan-400/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-100">
                  {link.title || hostname(link.url)}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{hostname(link.url)}</p>
                {link.relevance && (
                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{link.relevance}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  {link.shared_by && <span>by {link.shared_by}</span>}
                  {link.source_group && <span>in {link.source_group}</span>}
                  {link.last_seen && (
                    <span>{new Date(link.last_seen).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {link.category && (
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] capitalize ${categoryColor(link.category)}`}>
                    {link.category}
                  </span>
                )}
                {link.mention_count > 1 && (
                  <span className="text-[10px] text-slate-500">
                    shared {link.mention_count}x
                  </span>
                )}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
