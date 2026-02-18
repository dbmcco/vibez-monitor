"use client";

import { useEffect, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";

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

function clusterByTheme(messages: Message[]): ThemeCluster[] {
  const themes: Record<string, Message[]> = {};
  for (const msg of messages) {
    const parsed: string[] = msg.contribution_themes ? JSON.parse(msg.contribution_themes) : [];
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
  if (hoursAgo < 24) return { label: "hot", color: "bg-red-900 text-red-300" };
  if (hoursAgo < 72) return { label: "warm", color: "bg-amber-900 text-amber-300" };
  if (hoursAgo < 168) return { label: "cool", color: "bg-blue-900 text-blue-300" };
  return { label: "archive", color: "bg-zinc-700 text-zinc-400" };
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
    <div>
      <h1 className="mb-6 text-xl font-semibold">Contribution Opportunities</h1>
      {loading ? (<div className="text-zinc-500">Loading...</div>
      ) : clusters.length === 0 ? (<div className="text-zinc-500">No contribution opportunities yet.</div>
      ) : (
        <div className="space-y-4">
          {clusters.map((cluster) => {
            const freshness = freshnessBadge(cluster.latestTs);
            const isExpanded = expandedTheme === cluster.theme;
            return (
              <div key={cluster.theme} className="rounded-lg border border-emerald-900 bg-zinc-900">
                <button
                  onClick={() => setExpandedTheme(isExpanded ? null : cluster.theme)}
                  className="flex w-full items-center justify-between p-4 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-emerald-400">{cluster.theme}</span>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${freshness.color}`}>{freshness.label}</span>
                    <span className="text-xs text-zinc-500">{cluster.messages.length} messages</span>
                  </div>
                  <span className="text-zinc-500">{isExpanded ? "−" : "+"}</span>
                </button>
                {isExpanded && (
                  <div className="border-t border-zinc-800 p-4 grid gap-3 md:grid-cols-2">
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
