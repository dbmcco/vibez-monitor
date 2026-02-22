import { RelevanceBadge } from "./RelevanceBadge";

interface Props {
  message: {
    id: string;
    room_name: string;
    sender_name: string;
    body: string;
    timestamp: number;
    relevance_score: number | null;
    contribution_hint: string | null;
    need_type?: string;
    priority_score?: number;
    priority_score_model?: number;
    contribution_themes?: string[];
    reasons?: string[];
    model_intel?: {
      business_learning_value: number;
      relationship_upside: number;
      promotion_risk: number;
      recommended_action: string;
      rationale: string;
    };
    axes?: {
      urgency: number;
      need_strength: number;
      aging_risk: number;
      leverage: number;
      dependency_blocker: number;
      risk_if_ignored: number;
    };
  };
}

export function ContributionCard({ message }: Props) {
  const date = new Date(message.timestamp).toLocaleString();
  const topAxes: Array<[string, number]> = message.axes
    ? [
        ["U", message.axes.urgency],
        ["N", message.axes.need_strength],
        ["A", message.axes.aging_risk],
        ["L", message.axes.leverage],
        ["B", message.axes.dependency_blocker],
        ["R", message.axes.risk_if_ignored],
      ]
    : [];
  topAxes.sort((a, b) => b[1] - a[1]);

  return (
    <div className="rounded-lg border border-slate-700/70 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="vibe-chip rounded px-1.5 py-0.5 text-xs">
            {message.room_name}
          </span>
          {message.need_type && (
            <span className="rounded border border-amber-400/35 bg-amber-400/10 px-1.5 py-0.5 text-xs text-amber-200">
              {message.need_type}
            </span>
          )}
          {typeof message.priority_score === "number" && (
            <span className="rounded border border-cyan-400/35 bg-cyan-400/10 px-1.5 py-0.5 text-xs text-cyan-200">
              score {Math.round(message.priority_score)}
            </span>
          )}
          {typeof message.priority_score_model === "number" && (
            <span className="rounded border border-emerald-400/35 bg-emerald-400/10 px-1.5 py-0.5 text-xs text-emerald-200">
              smart {Math.round(message.priority_score_model)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <RelevanceBadge score={message.relevance_score} />
          <span className="text-xs text-slate-400">{date}</span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-slate-300">
        <span className="font-medium text-slate-200">{message.sender_name}:</span>{" "}
        {message.body.slice(0, 200)}{message.body.length > 200 && "..."}
      </p>
      {message.contribution_themes && message.contribution_themes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {message.contribution_themes.slice(0, 4).map((theme) => (
            <span
              key={theme}
              className="rounded border border-violet-400/35 bg-violet-500/10 px-2 py-0.5 text-xs text-violet-200"
            >
              {theme}
            </span>
          ))}
        </div>
      )}
      {message.contribution_hint && (
        <div className="mt-3 rounded border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200/95">
          {message.contribution_hint}
        </div>
      )}
      {topAxes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {topAxes.slice(0, 3).map(([label, value]) => (
            <span
              key={label}
              className="rounded border border-slate-500/40 bg-slate-800/70 px-1.5 py-0.5 text-xs text-slate-200"
            >
              {label}: {value.toFixed(1)}
            </span>
          ))}
        </div>
      )}
      {message.reasons && message.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-slate-300">
          {message.reasons.slice(0, 3).map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
      )}
      {message.model_intel ? (
        <div className="mt-3 rounded border border-sky-900/70 bg-sky-950/20 px-3 py-2 text-xs text-sky-100">
          <div>
            model: learning {message.model_intel.business_learning_value.toFixed(1)} · relationship{" "}
            {message.model_intel.relationship_upside.toFixed(1)} · promo-risk{" "}
            {message.model_intel.promotion_risk.toFixed(1)}
          </div>
          {message.model_intel.recommended_action ? (
            <div className="mt-1 text-sky-200/95">
              action: {message.model_intel.recommended_action}
            </div>
          ) : null}
          {message.model_intel.rationale ? (
            <div className="mt-1 text-sky-100/90">{message.model_intel.rationale}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
