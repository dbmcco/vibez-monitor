interface Thread {
  title: string;
  participants: string[];
  insights: string;
  links: string[];
}

interface Props {
  briefing_json: string | null;
  trends: string | null;
  report_date: string;
}

export function BriefingView({ briefing_json, trends, report_date }: Props) {
  const threads: Thread[] = briefing_json ? JSON.parse(briefing_json) : [];
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
          {(trendData.emerging?.length > 0 || trendData.fading?.length > 0) && (
            <div className="rounded-lg bg-zinc-900 p-4">
              <h3 className="font-medium text-zinc-200">Trends</h3>
              {trendData.emerging?.length > 0 && (
                <p className="mt-1 text-sm text-emerald-400">Emerging: {trendData.emerging.join(", ")}</p>
              )}
              {trendData.fading?.length > 0 && (
                <p className="mt-1 text-sm text-zinc-500">Fading: {trendData.fading.join(", ")}</p>
              )}
              {trendData.shifts && <p className="mt-2 text-sm text-zinc-300">{trendData.shifts}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
