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
  channel?: string;
  reply_to?: string;
  draft_message?: string;
  message_count: number;
}

interface TrendData {
  emerging?: string[];
  fading?: string[];
  shifts?: string;
}

interface Props {
  briefing_json: string | null;
  contributions_json?: string | null;
  trends: string | null;
  report_date: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function freshnessBadge(freshness: string): { color: string; label: string } {
  switch (freshness.toLowerCase()) {
    case "hot":
      return { color: "badge-hot", label: "hot" };
    case "warm":
      return { color: "badge-warm", label: "warm" };
    case "cool":
      return { color: "badge-cool", label: "cool" };
    default:
      return { color: "badge-archive", label: freshness || "archive" };
  }
}

export function BriefingView({
  briefing_json,
  contributions_json,
  trends,
  report_date,
}: Props) {
  const threads = parseJson<Thread[]>(briefing_json, []);
  const contributions = parseJson<Contribution[]>(contributions_json, []);
  const trendData = parseJson<TrendData>(trends, {});

  return (
    <div className="space-y-8">
      <header className="fade-up space-y-2">
        <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
          Daily Intelligence
        </p>
        <h2 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
          Briefing <span className="text-cyan-200/90">— {report_date}</span>
        </h2>
        <p className="vibe-subtitle max-w-3xl">
          High-signal threads, contribution vectors, and trend direction from
          the Vibez ecosystem.
        </p>
      </header>

      <section className="space-y-4">
        <h3 className="vibe-title text-lg text-slate-100">Key Threads</h3>
        {threads.length === 0 ? (
          <div className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
            No briefing available for this date.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {threads.map((thread, i) => (
              <article
                key={`${thread.title}-${i}`}
                className="vibe-panel fade-up rounded-xl p-5"
              >
                <h4 className="vibe-title text-base text-slate-100">
                  {thread.title}
                </h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {thread.participants.map((participant) => (
                    <span
                      key={`${thread.title}-${participant}`}
                      className="vibe-chip rounded px-2 py-0.5 text-xs"
                    >
                      {participant}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">
                  {thread.insights}
                </p>
                {thread.links.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {thread.links.map((link, j) => (
                      <a
                        key={`${thread.title}-${j}`}
                        href={link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs break-all text-cyan-300 hover:text-cyan-100"
                      >
                        {link}
                      </a>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {contributions.length > 0 && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">
            Contribution Opportunities
          </h3>
          <div className="grid gap-4">
            {contributions.map((contribution, i) => {
              const badge = freshnessBadge(contribution.freshness);
              return (
                <article
                  key={`${contribution.theme}-${i}`}
                  className="vibe-panel fade-up rounded-xl p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-emerald-300">
                      {contribution.theme}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${badge.color}`}
                    >
                      {badge.label}
                    </span>
                    <span className="vibe-chip rounded px-2 py-0.5 text-xs">
                      {contribution.type}
                    </span>
                    {contribution.message_count > 0 && (
                      <span className="text-xs text-slate-400">
                        {contribution.message_count} msgs
                      </span>
                    )}
                  </div>

                  {(contribution.channel || contribution.reply_to) && (
                    <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-900/65 p-3">
                      {contribution.channel && (
                        <p className="text-sm text-slate-200">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Channel
                          </span>
                          {contribution.channel}
                        </p>
                      )}
                      {contribution.reply_to && (
                        <p className="mt-1 text-sm text-slate-300">
                          <span className="mr-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                            Reply To
                          </span>
                          {contribution.reply_to}
                        </p>
                      )}
                    </div>
                  )}

                  <p className="mt-3 text-sm leading-relaxed text-slate-300">
                    {contribution.why}
                  </p>
                  <p className="mt-2 text-sm font-medium text-emerald-200/95">
                    {contribution.action}
                  </p>

                  {contribution.draft_message && (
                    <div className="mt-4 rounded-lg border border-emerald-900/70 bg-emerald-950/25 p-3">
                      <p className="text-xs font-semibold tracking-wide text-emerald-300 uppercase">
                        Draft Message
                      </p>
                      <p className="mt-2 text-sm italic leading-relaxed text-emerald-100/90">
                        {contribution.draft_message}
                      </p>
                      <button
                        onClick={() =>
                          navigator.clipboard.writeText(
                            contribution.draft_message || "",
                          )
                        }
                        className="vibe-button mt-3 rounded px-2.5 py-1.5 text-xs"
                      >
                        Copy to clipboard
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {(trendData.emerging?.length || trendData.fading?.length || trendData.shifts) && (
        <section className="space-y-4">
          <h3 className="vibe-title text-lg text-slate-100">Trends</h3>
          <div className="vibe-panel rounded-xl p-5">
            {trendData.emerging && trendData.emerging.length > 0 && (
              <p className="text-sm text-emerald-300">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-emerald-400/90">
                  Emerging
                </span>
                {trendData.emerging.join(", ")}
              </p>
            )}
            {trendData.fading && trendData.fading.length > 0 && (
              <p className="mt-2 text-sm text-slate-400">
                <span className="mr-2 text-xs font-semibold tracking-wide uppercase text-slate-500">
                  Fading
                </span>
                {trendData.fading.join(", ")}
              </p>
            )}
            {trendData.shifts && (
              <p className="mt-3 text-sm leading-relaxed text-slate-300">
                {trendData.shifts}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
