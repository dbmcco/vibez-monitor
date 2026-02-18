"use client";

import { useEffect, useState } from "react";

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

  if (loading) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Interest Topics</label>
          <textarea className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200" rows={3}
            value={topicsInput} onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="agentic-architecture, practical-tools, business-ai" />
          <p className="mt-1 text-xs text-zinc-500">Comma-separated topic tags</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Your Projects</label>
          <textarea className="w-full rounded bg-zinc-800 p-3 text-sm text-zinc-200" rows={2}
            value={projectsInput} onChange={(e) => setProjectsInput(e.target.value)}
            placeholder="MoneyCommand, Amplifier, driftdriver" />
          <p className="mt-1 text-xs text-zinc-500">Comma-separated project names the classifier matches against</p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-300">Hot Alert Threshold</label>
          <input type="range" min={1} max={10} value={threshold}
            onChange={(e) => setThreshold(parseInt(e.target.value))} className="w-full" />
          <p className="mt-1 text-xs text-zinc-500">Relevance score {threshold}+ triggers hot alerts</p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="rounded bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50">
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
