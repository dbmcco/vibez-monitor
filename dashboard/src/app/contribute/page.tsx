"use client";

import { useEffect, useMemo, useState } from "react";
import { ContributionCard } from "@/components/ContributionCard";
import { StatusPanel } from "@/components/StatusPanel";

type ContributionNeedType =
  | "decision"
  | "information"
  | "coordination"
  | "creation"
  | "support"
  | "none";
type ContributionNeedFilter = ContributionNeedType | "all";
type ContributionAxisKey =
  | "urgency"
  | "need_strength"
  | "aging_risk"
  | "leverage"
  | "strategic_fit"
  | "comparative_advantage"
  | "effort_to_value"
  | "dependency_blocker"
  | "relationship_stakes"
  | "risk_if_ignored"
  | "recurrence_signal"
  | "confidence";
type SortKey = "priority_score" | ContributionAxisKey;

interface ContributionAxes {
  urgency: number;
  need_strength: number;
  aging_risk: number;
  leverage: number;
  strategic_fit: number;
  comparative_advantage: number;
  effort_to_value: number;
  dependency_blocker: number;
  relationship_stakes: number;
  risk_if_ignored: number;
  recurrence_signal: number;
  confidence: number;
}

interface ContributionOpportunity {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  alert_level: string | null;
  topics: string[];
  contribution_themes: string[];
  entities: string[];
  contribution_hint: string | null;
  need_type: ContributionNeedType;
  hours_old: number;
  priority_score: number;
  axes: ContributionAxes;
  reasons: string[];
}

interface ContributionSection {
  key:
    | "act_now"
    | "high_leverage"
    | "aging_risk"
    | "blocked"
    | "relationship"
    | "quick_wins";
  label: string;
  description: string;
  items: ContributionOpportunity[];
}

interface ContributionAxisSummary {
  axis: ContributionAxisKey;
  label: string;
  average: number;
  high_count: number;
}

interface ContributionNeedSummary {
  need_type: ContributionNeedType;
  count: number;
}

interface RecurringContributionTheme {
  theme: string;
  messages: number;
  avg_priority: number;
  latest_seen: string;
  channels: string[];
  dominant_need_type: ContributionNeedType;
}

interface ContributionDashboard {
  generated_at: string;
  lookback_days: number;
  totals: {
    messages: number;
    opportunities: number;
    act_now: number;
    high_leverage: number;
    aging_risk: number;
    blocked: number;
  };
  axis_summary: ContributionAxisSummary[];
  need_summary: ContributionNeedSummary[];
  recurring_themes: RecurringContributionTheme[];
  opportunities: ContributionOpportunity[];
  sections: ContributionSection[];
}

const AXIS_LABELS: Record<ContributionAxisKey, string> = {
  urgency: "Urgency",
  need_strength: "Need Strength",
  aging_risk: "Aging Risk",
  leverage: "Leverage",
  strategic_fit: "Strategic Fit",
  comparative_advantage: "Comparative Advantage",
  effort_to_value: "Effort-to-Value",
  dependency_blocker: "Dependency / Blocker",
  relationship_stakes: "Relationship Stakes",
  risk_if_ignored: "Risk if Ignored",
  recurrence_signal: "Recurrence Signal",
  confidence: "Confidence",
};

const AXIS_KEYS = Object.keys(AXIS_LABELS) as ContributionAxisKey[];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "priority_score", label: "Overall Priority" },
  { key: "urgency", label: "Urgency" },
  { key: "need_strength", label: "Need Strength" },
  { key: "aging_risk", label: "Aging Risk" },
  { key: "leverage", label: "Leverage" },
  { key: "dependency_blocker", label: "Dependency / Blocker" },
  { key: "relationship_stakes", label: "Relationship Stakes" },
  { key: "risk_if_ignored", label: "Risk if Ignored" },
  { key: "effort_to_value", label: "Effort-to-Value" },
  { key: "recurrence_signal", label: "Recurrence Signal" },
  { key: "strategic_fit", label: "Strategic Fit" },
  { key: "comparative_advantage", label: "Comparative Advantage" },
  { key: "confidence", label: "Confidence" },
];

const NEED_COLORS: Record<ContributionNeedType, string> = {
  decision: "#f59e0b",
  information: "#22d3ee",
  coordination: "#34d399",
  creation: "#a78bfa",
  support: "#f87171",
  none: "#94a3b8",
};

function needLabel(needType: ContributionNeedType): string {
  if (needType === "none") return "Unspecified";
  return needType[0].toUpperCase() + needType.slice(1);
}

function scoreForSort(item: ContributionOpportunity, sortKey: SortKey): number {
  if (sortKey === "priority_score") return item.priority_score;
  return item.axes[sortKey];
}

function summarizeAxes(opportunities: ContributionOpportunity[]): ContributionAxisSummary[] {
  return AXIS_KEYS.map((axis) => {
    const values = opportunities.map((item) => item.axes[axis]);
    const average =
      values.length > 0
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : 0;
    return {
      axis,
      label: AXIS_LABELS[axis],
      average,
      high_count: values.filter((value) => value >= 7).length,
    };
  });
}

function summarizeNeeds(opportunities: ContributionOpportunity[]): ContributionNeedSummary[] {
  const counts = new Map<ContributionNeedType, number>();
  for (const item of opportunities) {
    counts.set(item.need_type, (counts.get(item.need_type) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([need_type, count]) => ({ need_type, count }));
}

function rankSectionItems(items: ContributionOpportunity[], sortKey: SortKey): ContributionOpportunity[] {
  return [...items].sort((a, b) => {
    const scoreDelta = scoreForSort(b, sortKey) - scoreForSort(a, sortKey);
    if (scoreDelta !== 0) return scoreDelta;
    return b.timestamp - a.timestamp;
  });
}

function OpportunityMatrix({
  opportunities,
}: {
  opportunities: ContributionOpportunity[];
}) {
  const width = 860;
  const height = 280;
  const padLeft = 38;
  const padRight = 20;
  const padTop = 18;
  const padBottom = 30;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const points = useMemo(
    () =>
      opportunities.slice(0, 120).map((item) => {
        const x = padLeft + (item.axes.aging_risk / 10) * innerWidth;
        const y = padTop + innerHeight - (item.axes.urgency / 10) * innerHeight;
        const radius = Math.max(3, Math.min(10, item.priority_score / 14));
        return { item, x, y, radius };
      }),
    [opportunities, innerWidth, innerHeight],
  );

  const hovered = points.find((point) => point.item.id === hoveredId)?.item || null;

  if (points.length === 0) {
    return <p className="text-sm text-slate-400">Not enough data for urgency-aging matrix.</p>;
  }

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-64 w-full rounded-lg border border-slate-700/50 bg-slate-950/45"
        onMouseLeave={() => setHoveredId(null)}
      >
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          stroke="#334155"
          strokeWidth={1}
        />
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerHeight} stroke="#334155" strokeWidth={1} />
        {points.map((point) => (
          <circle
            key={point.item.id}
            cx={point.x}
            cy={point.y}
            r={point.radius}
            fill={NEED_COLORS[point.item.need_type]}
            fillOpacity={hoveredId === point.item.id ? 0.95 : 0.7}
            stroke={hoveredId === point.item.id ? "#e2e8f0" : "none"}
            strokeWidth={hoveredId === point.item.id ? 1.5 : 0}
            onMouseEnter={() => setHoveredId(point.item.id)}
          />
        ))}
        <text x={padLeft} y={padTop + 10} fill="#94a3b8" fontSize="10">
          Urgency ↑
        </text>
        <text x={width - padRight} y={height - 8} fill="#94a3b8" fontSize="10" textAnchor="end">
          Aging Risk →
        </text>
      </svg>
      {hovered ? (
        <div className="text-xs text-slate-300">
          <span className="font-semibold text-slate-100">{hovered.sender_name}</span>
          {" · "}
          {hovered.room_name}
          {" · "}
          urgency {hovered.axes.urgency.toFixed(1)}, aging {hovered.axes.aging_risk.toFixed(1)}, score{" "}
          {Math.round(hovered.priority_score)}
        </div>
      ) : (
        <div className="text-xs text-slate-500">Hover points to inspect specific opportunities.</div>
      )}
      <div className="flex flex-wrap gap-2 text-xs text-slate-300">
        {(Object.keys(NEED_COLORS) as ContributionNeedType[]).map((needType) => (
          <span key={needType} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: NEED_COLORS[needType] }}
            />
            {needLabel(needType)}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ContributePage() {
  const [dashboard, setDashboard] = useState<ContributionDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(45);
  const [sortKey, setSortKey] = useState<SortKey>("priority_score");
  const [needFilter, setNeedFilter] = useState<ContributionNeedFilter>("all");
  const [minPriority, setMinPriority] = useState(35);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    act_now: true,
    high_leverage: true,
    aging_risk: true,
    blocked: false,
    relationship: false,
    quick_wins: false,
  });

  useEffect(() => {
    fetch(`/api/contributions?days=${days}&limit=900`)
      .then((response) => response.json())
      .then((data: ContributionDashboard) => {
        setDashboard(data);
        setLoading(false);
      })
      .catch(() => {
        setDashboard(null);
        setLoading(false);
      });
  }, [days]);

  const filteredOpportunities = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.opportunities.filter((item) => {
      if (needFilter !== "all" && item.need_type !== needFilter) return false;
      return item.priority_score >= minPriority;
    });
  }, [dashboard, needFilter, minPriority]);

  const sortedOpportunities = useMemo(
    () => rankSectionItems(filteredOpportunities, sortKey),
    [filteredOpportunities, sortKey],
  );

  const filteredIds = useMemo(
    () => new Set(sortedOpportunities.map((item) => item.id)),
    [sortedOpportunities],
  );

  const sections = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.sections.map((section) => ({
      ...section,
      items: rankSectionItems(
        section.items.filter((item) => filteredIds.has(item.id)),
        sortKey,
      ),
    }));
  }, [dashboard, filteredIds, sortKey]);

  const axisSummary = useMemo(
    () => summarizeAxes(sortedOpportunities),
    [sortedOpportunities],
  );
  const needSummary = useMemo(
    () => summarizeNeeds(sortedOpportunities),
    [sortedOpportunities],
  );

  const sectionCount = (key: ContributionSection["key"]): number =>
    sections.find((section) => section.key === key)?.items.length || 0;

  return (
    <div className="space-y-6">
      <header className="fade-up space-y-2">
        <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Contribution Opportunities
        </h1>
        <p className="vibe-subtitle">
          Multi-axis prioritization across urgency, need, aging, leverage, blockers, risk, and relationship stakes.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {[14, 30, 45, 90].map((range) => (
          <button
            key={range}
            onClick={() => {
              setLoading(true);
              setDays(range);
            }}
            className={`rounded px-3 py-1 text-sm ${days === range ? "vibe-button" : "vibe-chip"}`}
          >
            {range}d
          </button>
        ))}
      </div>

      {loading ? (
        <StatusPanel
          loading
          title="Loading contribution map"
          detail="Scoring urgency, need, aging, leverage, blockers, and recurrence."
        />
      ) : !dashboard ? (
        <StatusPanel
          title="Contribution dashboard unavailable"
          detail="Could not load contribution analytics right now."
        />
      ) : sortedOpportunities.length === 0 ? (
        <StatusPanel
          title="No opportunities match current filters"
          detail="Try lowering minimum score or broadening need type."
        />
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-5">
            <div className="vibe-panel rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400">Filtered</div>
              <div className="vibe-title mt-1 text-2xl">{sortedOpportunities.length}</div>
              <div className="mt-1 text-xs text-slate-500">of {dashboard.totals.opportunities} opportunities</div>
            </div>
            <div className="vibe-panel rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400">Act Now</div>
              <div className="vibe-title mt-1 text-2xl">{sectionCount("act_now")}</div>
            </div>
            <div className="vibe-panel rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400">High Leverage</div>
              <div className="vibe-title mt-1 text-2xl">{sectionCount("high_leverage")}</div>
            </div>
            <div className="vibe-panel rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400">Aging Risk</div>
              <div className="vibe-title mt-1 text-2xl">{sectionCount("aging_risk")}</div>
            </div>
            <div className="vibe-panel rounded-xl p-4">
              <div className="text-xs uppercase tracking-wide text-slate-400">Blocked</div>
              <div className="vibe-title mt-1 text-2xl">{sectionCount("blocked")}</div>
            </div>
          </section>

          <section className="vibe-panel rounded-xl p-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-slate-300">Need type</span>
                <select
                  className="vibe-input w-full rounded-md px-3 py-2 text-sm"
                  value={needFilter}
                  onChange={(event) => setNeedFilter(event.target.value as ContributionNeedFilter)}
                >
                  <option value="all">All needs</option>
                  <option value="decision">Decision</option>
                  <option value="information">Information</option>
                  <option value="coordination">Coordination</option>
                  <option value="creation">Creation</option>
                  <option value="support">Support</option>
                  <option value="none">Unspecified</option>
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-300">Sort by</span>
                <select
                  className="vibe-input w-full rounded-md px-3 py-2 text-sm"
                  value={sortKey}
                  onChange={(event) => setSortKey(event.target.value as SortKey)}
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-300">Minimum priority: {Math.round(minPriority)}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={minPriority}
                  onChange={(event) => setMinPriority(Number(event.target.value))}
                  className="w-full accent-cyan-300"
                />
              </label>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="vibe-panel rounded-xl p-5">
              <h2 className="vibe-title mb-3 text-lg">Axis Scores</h2>
              <div className="space-y-2">
                {axisSummary.map((axis) => (
                  <button
                    key={axis.axis}
                    onClick={() => setSortKey(axis.axis)}
                    className={`w-full rounded-md border p-2 text-left transition ${
                      sortKey === axis.axis
                        ? "border-cyan-400/60 bg-cyan-500/10"
                        : "border-slate-700/60 bg-slate-900/40"
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span>{axis.label}</span>
                      <span>avg {axis.average.toFixed(2)} · {axis.high_count} high</span>
                    </div>
                    <div className="mt-1 h-2 rounded bg-slate-800">
                      <div
                        className="h-full rounded bg-cyan-400/80"
                        style={{ width: `${Math.max(2, axis.average * 10)}%` }}
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="vibe-panel rounded-xl p-5">
              <h2 className="vibe-title mb-3 text-lg">Need Mix & Recurring Themes</h2>
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {needSummary.map((item) => (
                    <span
                      key={item.need_type}
                      className="rounded border border-slate-600/60 bg-slate-900/50 px-2 py-1 text-xs text-slate-200"
                    >
                      {needLabel(item.need_type)}: {item.count}
                    </span>
                  ))}
                </div>
                <div className="max-h-52 overflow-y-auto rounded border border-slate-700/50">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900/75 text-slate-300">
                      <tr>
                        <th className="px-3 py-2">Theme</th>
                        <th className="px-3 py-2">Msgs</th>
                        <th className="px-3 py-2">Avg score</th>
                        <th className="px-3 py-2">Need</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.recurring_themes.slice(0, 10).map((theme) => (
                        <tr key={theme.theme} className="border-t border-slate-700/60">
                          <td className="px-3 py-2 text-slate-200">{theme.theme}</td>
                          <td className="px-3 py-2">{theme.messages}</td>
                          <td className="px-3 py-2">{Math.round(theme.avg_priority)}</td>
                          <td className="px-3 py-2">{needLabel(theme.dominant_need_type)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className="vibe-panel rounded-xl p-5">
            <h2 className="vibe-title mb-3 text-lg">Urgency vs Aging (Interactive)</h2>
            <OpportunityMatrix opportunities={sortedOpportunities} />
          </section>

          <div className="space-y-4">
            {sections.map((section) => {
              const expanded = expandedSections[section.key] || false;
              return (
                <section key={section.key} className="vibe-panel rounded-xl border border-slate-700/70">
                  <button
                    className="flex w-full items-center justify-between gap-4 p-4 text-left sm:p-5"
                    onClick={() =>
                      setExpandedSections((prev) => ({
                        ...prev,
                        [section.key]: !expanded,
                      }))
                    }
                  >
                    <div>
                      <h3 className="vibe-title text-lg text-slate-100">
                        {section.label} <span className="text-sm text-slate-400">({section.items.length})</span>
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">{section.description}</p>
                    </div>
                    <span className="text-lg leading-none text-slate-500">{expanded ? "−" : "+"}</span>
                  </button>
                  {expanded && (
                    <div className="border-t border-slate-700/70 p-4 sm:p-5">
                      {section.items.length === 0 ? (
                        <p className="text-sm text-slate-500">No opportunities in this section for current filters.</p>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          {section.items.slice(0, 12).map((message) => (
                            <ContributionCard key={message.id} message={message} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
