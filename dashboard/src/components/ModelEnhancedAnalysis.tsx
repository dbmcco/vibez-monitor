"use client";

import type { MouseEvent } from "react";
import { useEffect, useState } from "react";

const STORAGE_KEY = "vibez-wisdom-enhanced-analysis-v1";

interface AnalysisPayload {
  topicName: string;
  topicSummary: string;
  knowledgeType: string;
  title: string;
  summary: string;
}

function loadCache(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function saveCache(next: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; analysis can stay in-memory.
  }
}

export function ModelEnhancedAnalysis({
  cacheKey,
  payload,
  compact = false,
}: {
  cacheKey: string;
  payload: AnalysisPayload;
  compact?: boolean;
}) {
  const [analysis, setAnalysis] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const cached = loadCache()[cacheKey];
    if (cached) setAnalysis(cached);
  }, [cacheKey]);

  async function generateAnalysis() {
    if (loading) return;
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/wisdom/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok || typeof data.analysis !== "string" || !data.analysis.trim()) {
        throw new Error(typeof data.error === "string" ? data.error : "Model analysis failed.");
      }
      const nextAnalysis = data.analysis.trim();
      setAnalysis(nextAnalysis);
      const cache = loadCache();
      cache[cacheKey] = nextAnalysis;
      saveCache(cache);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Model analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  function onGenerateClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void generateAnalysis();
  }

  return (
    <div className="mt-3 border-t border-slate-800/60 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
          Model Enhanced Analysis
        </h4>
        <button
          type="button"
          onClick={onGenerateClick}
          disabled={loading}
          className="rounded-full border border-slate-700/60 px-2.5 py-1 text-[11px] text-cyan-300 transition hover:border-cyan-300/50 hover:text-cyan-200 disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "Generating..." : analysis ? "Refresh" : "Generate"}
        </button>
      </div>
      {analysis ? (
        <p className={`mt-2 text-slate-300 ${compact ? "line-clamp-4 text-xs" : "text-sm"}`}>{analysis}</p>
      ) : null}
      {!analysis && !error ? (
        <p className={`mt-2 text-slate-500 ${compact ? "text-[11px]" : "text-xs"}`}>
          Generate a model pass that explains applicability, tradeoffs, and edge cases.
        </p>
      ) : null}
      {!analysis && error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
