"use client";

import { useEffect, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";

interface ApiUsageSummary {
  generated_at: string;
  day_key: string;
  config: {
    api_guard_enabled: boolean;
    api_guard_manual_lock: boolean;
    api_daily_budget_usd: number;
    api_daily_request_limit: number;
    api_daily_requests_per_ip: number;
    api_input_cost_per_million_usd: number;
    api_output_cost_per_million_usd: number;
  };
  today: {
    success_requests: number;
    blocked_requests: number;
    error_requests: number;
    model_requests: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  };
  route_breakdown: Array<{
    route: string;
    success_requests: number;
    blocked_requests: number;
    error_requests: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>;
  recent_days: Array<{
    day_key: string;
    success_requests: number;
    blocked_requests: number;
    error_requests: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function nonNegativeInput(raw: string, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [topicsInput, setTopicsInput] = useState("");
  const [projectsInput, setProjectsInput] = useState("");
  const [threshold, setThreshold] = useState(7);
  const [apiGuardEnabled, setApiGuardEnabled] = useState(true);
  const [apiManualLock, setApiManualLock] = useState(false);
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState("6");
  const [dailyRequestLimit, setDailyRequestLimit] = useState("240");
  const [dailyRequestsPerIp, setDailyRequestsPerIp] = useState("80");
  const [inputCostPerMillion, setInputCostPerMillion] = useState("3");
  const [outputCostPerMillion, setOutputCostPerMillion] = useState("15");
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState("");
  const [usageSummary, setUsageSummary] = useState<ApiUsageSummary | null>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        const data = await response.json();
        const config = (data?.config || {}) as Record<string, unknown>;
        setTopicsInput(asStringArray(config.topics).join(", "));
        setProjectsInput(asStringArray(config.projects).join(", "));
        setThreshold(asNumber(config.alert_threshold, 7));
        setApiGuardEnabled(asBool(config.api_guard_enabled, true));
        setApiManualLock(asBool(config.api_guard_manual_lock, false));
        setDailyBudgetUsd(String(asNumber(config.api_daily_budget_usd, 6)));
        setDailyRequestLimit(String(asNumber(config.api_daily_request_limit, 240)));
        setDailyRequestsPerIp(String(asNumber(config.api_daily_requests_per_ip, 80)));
        setInputCostPerMillion(String(asNumber(config.api_input_cost_per_million_usd, 3)));
        setOutputCostPerMillion(String(asNumber(config.api_output_cost_per_million_usd, 15)));
      } finally {
        setLoading(false);
      }
    }

    async function loadUsage(showSpinner: boolean) {
      if (showSpinner) setUsageLoading(true);
      setUsageError("");
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Usage endpoint returned ${response.status}`);
        }
        const data = (await response.json()) as ApiUsageSummary;
        setUsageSummary(data);
      } catch (error) {
        setUsageError(error instanceof Error ? error.message : "Failed to load usage.");
      } finally {
        setUsageLoading(false);
      }
    }

    void loadSettings();
    void loadUsage(true);
    const timer = window.setInterval(() => void loadUsage(false), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const topics = topicsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const projects = projectsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const payload = {
      topics,
      projects,
      alert_threshold: threshold,
      api_guard_enabled: apiGuardEnabled,
      api_guard_manual_lock: apiManualLock,
      api_daily_budget_usd: nonNegativeInput(dailyBudgetUsd, 6),
      api_daily_request_limit: nonNegativeInput(dailyRequestLimit, 240),
      api_daily_requests_per_ip: nonNegativeInput(dailyRequestsPerIp, 80),
      api_input_cost_per_million_usd: nonNegativeInput(inputCostPerMillion, 3),
      api_output_cost_per_million_usd: nonNegativeInput(outputCostPerMillion, 15),
    };
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as ApiUsageSummary;
        setUsageSummary(data);
      }
    } catch {
      // Keep existing usage summary on transient refresh errors.
    }
    setSaving(false);
  };

  const todayCost = usageSummary?.today.estimated_cost_usd || 0;
  const todayCalls = usageSummary?.today.model_requests || 0;
  const todayBlocked = usageSummary?.today.blocked_requests || 0;
  const configuredBudget = nonNegativeInput(dailyBudgetUsd, 6);
  const budgetRemaining =
    configuredBudget > 0 ? Math.max(0, configuredBudget - todayCost) : null;

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
          Tune what counts as signal and keep chat usage/costs inside guardrails.
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
            placeholder="Core Platform, Analytics Pipeline, Automation Tooling"
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
        <hr className="border-slate-800/80" />
        <div className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200/90">
            Chat Usage Guard
          </h2>
          <label className="flex items-center gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-400"
              checked={apiGuardEnabled}
              onChange={(e) => setApiGuardEnabled(e.target.checked)}
            />
            Enable API usage guard
          </label>
          <label className="flex items-center gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-cyan-400"
              checked={apiManualLock}
              onChange={(e) => setApiManualLock(e.target.checked)}
            />
            Manual lockout (blocks chat model calls immediately)
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-300">
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Daily budget (USD, 0 = no cap)
              </span>
              <input
                className="vibe-input w-full rounded-lg p-2.5 text-sm"
                type="number"
                min={0}
                step="0.01"
                value={dailyBudgetUsd}
                onChange={(e) => setDailyBudgetUsd(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm text-slate-300">
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Daily request cap (0 = no cap)
              </span>
              <input
                className="vibe-input w-full rounded-lg p-2.5 text-sm"
                type="number"
                min={0}
                step="1"
                value={dailyRequestLimit}
                onChange={(e) => setDailyRequestLimit(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm text-slate-300">
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Per-client daily cap (0 = no cap)
              </span>
              <input
                className="vibe-input w-full rounded-lg p-2.5 text-sm"
                type="number"
                min={0}
                step="1"
                value={dailyRequestsPerIp}
                onChange={(e) => setDailyRequestsPerIp(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm text-slate-300">
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Input cost / 1M tokens (USD)
              </span>
              <input
                className="vibe-input w-full rounded-lg p-2.5 text-sm"
                type="number"
                min={0}
                step="0.01"
                value={inputCostPerMillion}
                onChange={(e) => setInputCostPerMillion(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-sm text-slate-300 sm:col-span-2">
              <span className="block text-xs uppercase tracking-wide text-slate-400">
                Output cost / 1M tokens (USD)
              </span>
              <input
                className="vibe-input w-full rounded-lg p-2.5 text-sm"
                type="number"
                min={0}
                step="0.01"
                value={outputCostPerMillion}
                onChange={(e) => setOutputCostPerMillion(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-slate-400">
            Applies to Chat Agent only. Briefing/stats analysis pipelines run separately.
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

      <div className="vibe-panel space-y-4 rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-cyan-200/90">
            Chat Usage Snapshot
          </h2>
          <p className="text-xs text-slate-400">
            {usageSummary
              ? `Updated ${new Date(usageSummary.generated_at).toLocaleTimeString()}`
              : "Waiting for data"}
          </p>
        </div>

        {usageLoading && !usageSummary ? (
          <StatusPanel loading title="Loading usage stats" detail="Pulling today’s API usage." />
        ) : usageError ? (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {usageError}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="vibe-card rounded-lg p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Today cost</p>
                <p className="mt-1 text-lg font-semibold text-cyan-200">${todayCost.toFixed(4)}</p>
              </div>
              <div className="vibe-card rounded-lg p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Model calls</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{todayCalls}</p>
              </div>
              <div className="vibe-card rounded-lg p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">Blocked today</p>
                <p className="mt-1 text-lg font-semibold text-amber-200">{todayBlocked}</p>
              </div>
              <div className="vibe-card rounded-lg p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-400">
                  Budget remaining
                </p>
                <p className="mt-1 text-lg font-semibold text-emerald-200">
                  {budgetRemaining === null ? "No cap" : `$${budgetRemaining.toFixed(4)}`}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Route breakdown (today)
              </h3>
              <div className="overflow-x-auto rounded-lg border border-slate-800/90">
                <table className="min-w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Route</th>
                      <th className="px-3 py-2">Calls</th>
                      <th className="px-3 py-2">Blocked</th>
                      <th className="px-3 py-2">Input toks</th>
                      <th className="px-3 py-2">Output toks</th>
                      <th className="px-3 py-2">Cost (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usageSummary?.route_breakdown || []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-3 text-slate-500">
                          No Anthropic usage recorded yet today.
                        </td>
                      </tr>
                    ) : (
                      usageSummary?.route_breakdown.map((row) => (
                        <tr key={row.route} className="border-t border-slate-800/70">
                          <td className="px-3 py-2 text-slate-100">{row.route}</td>
                          <td className="px-3 py-2">{row.success_requests + row.error_requests}</td>
                          <td className="px-3 py-2">{row.blocked_requests}</td>
                          <td className="px-3 py-2">{row.input_tokens.toLocaleString()}</td>
                          <td className="px-3 py-2">{row.output_tokens.toLocaleString()}</td>
                          <td className="px-3 py-2">${row.estimated_cost_usd.toFixed(4)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Last 14 days
              </h3>
              <div className="overflow-x-auto rounded-lg border border-slate-800/90">
                <table className="min-w-full text-left text-xs text-slate-300">
                  <thead className="bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Day (UTC)</th>
                      <th className="px-3 py-2">Calls</th>
                      <th className="px-3 py-2">Blocked</th>
                      <th className="px-3 py-2">Input toks</th>
                      <th className="px-3 py-2">Output toks</th>
                      <th className="px-3 py-2">Cost (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usageSummary?.recent_days || []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-3 text-slate-500">
                          No usage history yet.
                        </td>
                      </tr>
                    ) : (
                      usageSummary?.recent_days.map((row) => (
                        <tr key={row.day_key} className="border-t border-slate-800/70">
                          <td className="px-3 py-2 text-slate-100">{row.day_key}</td>
                          <td className="px-3 py-2">{row.success_requests + row.error_requests}</td>
                          <td className="px-3 py-2">{row.blocked_requests}</td>
                          <td className="px-3 py-2">{row.input_tokens.toLocaleString()}</td>
                          <td className="px-3 py-2">{row.output_tokens.toLocaleString()}</td>
                          <td className="px-3 py-2">${row.estimated_cost_usd.toFixed(4)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
