"use client";

import { useEffect, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";
import { StatusPanel } from "@/components/StatusPanel";

interface Message {
  id: string; room_name: string; sender_name: string; body: string;
  timestamp: number; relevance_score: number | null;
  contribution_themes: string | null; contribution_hint: string | null;
}

interface ThemeCluster {
  theme: string;
  messages: Message[];
  latestTs: number;
}

function parseThemes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clusterByTheme(messages: Message[]): ThemeCluster[] {
  const themes: Record<string, Message[]> = {};
  for (const msg of messages) {
    const parsed = parseThemes(msg.contribution_themes);
    if (parsed.length === 0) parsed.push("uncategorized");
    for (const theme of parsed) {
      if (!themes[theme]) themes[theme] = [];
      themes[theme].push(msg);
    }
  }
  return Object.entries(themes)
    .map(([theme, msgs]) => ({
      theme,
      messages: msgs.sort((a, b) => b.timestamp - a.timestamp),
      latestTs: Math.max(...msgs.map((m) => m.timestamp)),
    }))
    .sort((a, b) => b.messages.length - a.messages.length);
}

function freshnessBadge(ts: number): { label: string; color: string } {
  const hoursAgo = (Date.now() - ts) / (1000 * 60 * 60);
  if (hoursAgo < 24) return { label: "hot", color: "badge-hot" };
  if (hoursAgo < 72) return { label: "warm", color: "badge-warm" };
  if (hoursAgo < 168) return { label: "cool", color: "badge-cool" };
  return { label: "archive", color: "badge-archive" };
}

export default function ContributePage() {
  const [contributions, setContributions] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTheme, setExpandedTheme] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/contributions")
      .then((r) => r.json())
      .then((data) => { setContributions(data.contributions); setLoading(false); });
  }, []);

  const clusters = clusterByTheme(contributions);

  return (
    <div className="space-y-6">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Contribution Opportunities
        </h1>
        <p className="vibe-subtitle">
          Clustered themes with freshest windows for a fast response.
        </p>
      </header>
      {loading ? (
        <StatusPanel
          loading
          title="Loading contribution map"
          detail="Clustering recent messages into actionable themes."
        />
      ) : clusters.length === 0 ? (
        <StatusPanel
          title="No contribution opportunities yet"
          detail="When high-value themes emerge, they will show up here."
        />
      ) : (
        <div className="space-y-4">
          {clusters.map((cluster) => {
            const freshness = freshnessBadge(cluster.latestTs);
            const isExpanded = expandedTheme === cluster.theme;
            return (
              <div
                key={cluster.theme}
                className="vibe-panel fade-up rounded-xl border border-slate-700/70"
              >
                <button
                  onClick={() => setExpandedTheme(isExpanded ? null : cluster.theme)}
                  className="flex w-full items-center justify-between gap-4 p-4 text-left sm:p-5"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-emerald-300">
                      {cluster.theme}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${freshness.color}`}
                    >
                      {freshness.label}
                    </span>
                    <span className="text-xs text-slate-400">
                      {cluster.messages.length} messages
                    </span>
                  </div>
                  <span className="text-lg leading-none text-slate-500">
                    {isExpanded ? "−" : "+"}
                  </span>
                </button>
                {isExpanded && (
                  <div className="grid gap-3 border-t border-slate-700/70 p-4 md:grid-cols-2 sm:p-5">
                    {cluster.messages.slice(0, 10).map((msg) => (
                      <ContributionCard key={msg.id} message={msg} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
