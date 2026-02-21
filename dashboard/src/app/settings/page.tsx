"use client";

import { useEffect, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topicsInput, setTopicsInput] = useState("");
  const [projectsInput, setProjectsInput] = useState("");
  const [threshold, setThreshold] = useState(7);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setTopicsInput((data.config.topics as string[] || []).join(", "));
        setProjectsInput((data.config.projects as string[] || []).join(", "));
        setThreshold((data.config.alert_threshold as number) || 7);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const topics = topicsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const projects = projectsInput.split(",").map((t) => t.trim()).filter(Boolean);
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics, projects, alert_threshold: threshold }),
    });
    setSaving(false);
  };

  if (loading) {
    return (
      <StatusPanel
        loading
        title="Loading settings"
        detail="Fetching current signal preferences."
      />
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Settings
        </h1>
        <p className="vibe-subtitle">
          Tune what counts as signal and when alerts become urgent.
        </p>
      </header>

      <div className="vibe-panel space-y-6 rounded-xl p-5 sm:p-6">
        <div>
          <label className="mb-2 block text-sm font-semibold text-slate-200">
            Interest Topics
          </label>
          <textarea
            className="vibe-input w-full rounded-lg p-3 text-sm"
            rows={3}
            value={topicsInput}
            onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="agentic-architecture, practical-tools, business-ai"
          />
          <p className="mt-1 text-xs text-slate-400">Comma-separated topic tags</p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-semibold text-slate-200">
            Your Projects
          </label>
          <textarea
            className="vibe-input w-full rounded-lg p-3 text-sm"
            rows={2}
            value={projectsInput}
            onChange={(e) => setProjectsInput(e.target.value)}
            placeholder="MoneyCommand, Amplifier, driftdriver"
          />
          <p className="mt-1 text-xs text-slate-400">
            Comma-separated project names the classifier matches against
          </p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-semibold text-slate-200">
            Hot Alert Threshold
          </label>
          <input
            type="range"
            min={1}
            max={10}
            value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            className="h-2 w-full cursor-pointer accent-cyan-400"
          />
          <p className="mt-1 text-xs text-slate-400">
            Relevance score <span className="font-semibold text-slate-200">{threshold}+</span>{" "}
            triggers hot alerts
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="vibe-button rounded-lg px-4 py-2.5 text-sm disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
