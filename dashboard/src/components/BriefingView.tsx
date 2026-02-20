interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface Contribution {
  theme: string;
  type: string;
  freshness: string;
  threads: string[];
  why: string;
  action: string;
  draft_message?: string;
  message_count: number;
}

interface Props {
  briefing_json: string | null;
  contributions_json?: string | null;
  trends: string | null;
  report_date: string;
}

function freshnessBadge(freshness: string): { color: string } {
  switch (freshness) {
    case "hot": return { color: "bg-red-900 text-red-300" };
    case "warm": return { color: "bg-amber-900 text-amber-300" };
    case "cool": return { color: "bg-blue-900 text-blue-300" };
    default: return { color: "bg-zinc-700 text-zinc-400" };
  }
}

export function BriefingView({ briefing_json, contributions_json, trends, report_date }: Props) {
  const threads: Thread[] = briefing_json ? JSON.parse(briefing_json) : [];
  const contributions: Contribution[] = contributions_json ? JSON.parse(contributions_json) : [];
  const trendData = trends ? JSON.parse(trends) : {};

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Briefing — {report_date}</h2>

      {threads.length === 0 ? (
        <p className="text-zinc-500">No briefing available for this date.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {threads.map((thread, i) => (
            <div key={i} className="rounded-lg bg-zinc-900 p-4">
              <h3 className="font-medium text-zinc-200">{thread.title}</h3>
              <p className="mt-1 text-xs text-zinc-500">{thread.participants.join(", ")}</p>
              <p className="mt-2 text-sm text-zinc-300">{thread.insights}</p>
              {thread.links.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
                  {thread.links.map((link, j) => (
                    <a key={j} href={link} target="_blank" rel="noopener noreferrer"
                       className="text-xs text-blue-400 hover:underline">{link}</a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {contributions.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-lg font-semibold">Contribution Opportunities</h2>
          <div className="flex flex-col gap-4">
            {contributions.map((c, i) => {
              const badge = freshnessBadge(c.freshness);
              return (
                <div key={i} className="rounded-lg border border-emerald-900 bg-zinc-900 p-4">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-emerald-400">{c.theme}</span>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${badge.color}`}>{c.freshness}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">{c.type}</span>
                    {c.message_count > 0 && (
                      <span className="text-xs text-zinc-500">{c.message_count} msgs</span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-zinc-300">{c.why}</p>
                  <p className="mt-1 text-sm text-zinc-400">{c.action}</p>
                  {c.draft_message && (
                    <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/30 p-3">
                      <div className="mb-1 text-xs font-medium text-emerald-500">Draft message</div>
                      <p className="text-sm text-emerald-200 italic">{c.draft_message}</p>
                      <button
                        onClick={() => navigator.clipboard.writeText(c.draft_message || "")}
                        className="mt-2 rounded bg-emerald-900 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-800 transition-colors"
                      >
                        Copy to clipboard
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(trendData.emerging?.length > 0 || trendData.fading?.length > 0) && (
        <div className="mt-8">
          <h2 className="mb-4 text-lg font-semibold">Trends</h2>
          <div className="rounded-lg bg-zinc-900 p-4">
            {trendData.emerging?.length > 0 && (
              <p className="text-sm text-emerald-400">Emerging: {trendData.emerging.join(", ")}</p>
            )}
            {trendData.fading?.length > 0 && (
              <p className="mt-1 text-sm text-zinc-500">Fading: {trendData.fading.join(", ")}</p>
            )}
            {trendData.shifts && <p className="mt-2 text-sm text-zinc-300">{trendData.shifts}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
