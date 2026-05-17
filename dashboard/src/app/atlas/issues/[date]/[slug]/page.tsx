"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

interface AtlasCitation {
  ref: string;
  type: "message" | "link";
  label: string;
  channel?: string;
  sender?: string;
  timestamp?: number;
  body?: string;
  url?: string;
  title?: string;
}

interface AtlasEditorialArticle {
  role: "lead" | "secondary";
  section: string;
  title: string;
  slug: string;
  dek: string;
  summary: string;
  body: string[];
  actions: string[];
  evidence_refs: string[];
  link_refs: string[];
  channels: string[];
  image: {
    kind: "generated" | "link" | "chat" | "none";
    prompt?: string;
    url?: string;
    alt?: string;
  };
  related_article_slugs: string[];
}

interface AtlasEditorialReport {
  issue: {
    date: string;
    title: string;
    subtitle: string;
    edition_label: string;
  };
  articles: AtlasEditorialArticle[];
}

interface AtlasSnapshot {
  citations: Record<string, AtlasCitation>;
}

interface AtlasPayload {
  atlas: AtlasSnapshot | null;
  editorial_report: AtlasEditorialReport | null;
  editorial_error?: string | null;
}

interface AtlasDeeperDive {
  title: string;
  claim_under_review: string;
  retrieval_mode: "semantic" | "keyword_fallback";
  supporting_evidence: string[];
  counterevidence: string[];
  weak_spots: string[];
  alternative_interpretations: string[];
  recommended_actions: string[];
  citation_refs: string[];
}

export default function AtlasArticlePage() {
  const params = useParams<{ date: string; slug: string }>();
  const [payload, setPayload] = useState<AtlasPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [deepDive, setDeepDive] = useState<AtlasDeeperDive | null>(null);
  const [deepDiveError, setDeepDiveError] = useState<string | null>(null);
  const [deepDiveLoading, setDeepDiveLoading] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/atlas?hours=48")
      .then((response) => response.json())
      .then((nextPayload: AtlasPayload) => {
        if (!active) return;
        setPayload(nextPayload);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setPayload(null);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const article = useMemo(() => {
    return payload?.editorial_report?.articles.find((item) => item.slug === params.slug) || null;
  }, [payload, params.slug]);
  const citations = payload?.atlas?.citations || {};
  const related = payload?.editorial_report?.articles.filter((item) =>
    article?.related_article_slugs.includes(item.slug),
  ) || [];

  async function spawnDeepDive() {
    if (!article) return;
    setDeepDiveLoading(true);
    setDeepDiveError(null);
    setDeepDive(null);
    try {
      const response = await fetch("/api/atlas/deeper-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article, hours: 48 }),
      });
      const body = await response.json() as {
        deeper_dive: AtlasDeeperDive | null;
        error: string | null;
      };
      if (!response.ok || !body.deeper_dive) {
        throw new Error(body.error || "Deeper dive unavailable.");
      }
      setDeepDive(body.deeper_dive);
    } catch (error) {
      setDeepDiveError(error instanceof Error ? error.message : "Deeper dive unavailable.");
    } finally {
      setDeepDiveLoading(false);
    }
  }

  if (loading) {
    return <div className="rounded-xl border border-[#cbbf9d] bg-[#f8f4ea] p-5 text-sm text-[#342a1b]">Loading article...</div>;
  }

  if (!payload?.editorial_report || !payload.atlas || !article) {
    return (
      <div className="space-y-4">
        <Link href="/atlas" className="inline-flex rounded border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm text-[#342a1b]">
          Back to Atlas
        </Link>
        <div className="rounded-xl border border-[#cbbf9d] bg-[#f8f4ea] p-5 text-sm text-[#342a1b]">
          Article unavailable for {params.date}/{params.slug}.
        </div>
      </div>
    );
  }

  return (
    <div className="fade-up space-y-5">
      <Link href="/atlas" className="inline-flex rounded border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm text-[#342a1b]">
        Back to front page
      </Link>

      <article className="rounded-xl border border-[#d6cdbb] bg-[#f8f4ea] p-5 text-slate-950 sm:p-7">
        <header className="border-b-4 border-double border-slate-900 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
            <span>{payload.editorial_report.issue.title}</span>
            <span>{payload.editorial_report.issue.date}</span>
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-[#8b5f21]">
            {article.section}{article.role === "lead" ? " | Lead Story" : ""}
          </p>
          <h1 className="mt-2 max-w-5xl font-serif text-4xl font-black leading-none tracking-normal text-slate-950 sm:text-6xl">
            {article.title}
          </h1>
          <p className="mt-4 max-w-4xl text-lg leading-8 text-slate-700">{article.dek}</p>
        </header>

        <div className="mt-6 grid gap-7 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.65fr)]">
          <main>
            <ArticleImage article={article} />
            <div className="mt-6 space-y-4 text-base leading-8 text-slate-800 sm:text-lg">
              {article.body.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
            {article.actions.length > 0 && (
              <section className="mt-7 border-t-2 border-slate-900 pt-4">
                <h2 className="font-serif text-2xl font-bold text-slate-950">What to do next</h2>
                <div className="mt-3 space-y-2">
                  {article.actions.map((action, index) => (
                    <p key={index} className="text-sm leading-6 text-slate-700">{action}</p>
                  ))}
                </div>
              </section>
            )}
            {related.length > 0 && (
              <section className="mt-7 border-t border-slate-300 pt-4">
                <h2 className="font-serif text-2xl font-bold text-slate-950">Related stories</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {related.map((item) => (
                    <Link
                      key={item.slug}
                      href={`/atlas/issues/${payload.editorial_report!.issue.date}/${item.slug}`}
                      className="border border-slate-300 bg-white/35 p-3 hover:border-slate-900"
                    >
                      <span className="block font-serif text-xl font-bold text-slate-950">{item.title}</span>
                      <span className="mt-1 block text-sm leading-6 text-slate-700">{item.dek}</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </main>

          <aside className="space-y-4">
            <section className="border border-slate-300 bg-white/35 p-4">
              <h2 className="font-serif text-2xl font-bold text-slate-950">Spawn deeper dive</h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Run vector retrieval and adversarial analysis against this article.
              </p>
              <button
                onClick={spawnDeepDive}
                disabled={deepDiveLoading}
                className="mt-3 border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-[#f8f4ea] disabled:opacity-60"
              >
                {deepDiveLoading ? "Running..." : "Spawn deeper dive"}
              </button>
              {deepDiveError && (
                <p className="mt-3 text-sm leading-6 text-red-700">{deepDiveError}</p>
              )}
            </section>

            {deepDive && <DeepDivePanel dive={deepDive} citations={citations} />}

            <ArticleRail
              title="Evidence"
              refs={article.evidence_refs}
              citations={citations}
            />
            <ArticleRail
              title="Links"
              refs={article.link_refs}
              citations={citations}
            />
            <section className="border border-slate-300 bg-white/35 p-4">
              <h2 className="font-serif text-2xl font-bold text-slate-950">Channels</h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {article.channels.length > 0 ? article.channels.join(", ") : "No channel list supplied."}
              </p>
            </section>
          </aside>
        </div>
      </article>
    </div>
  );
}

function ArticleImage({ article }: { article: AtlasEditorialArticle }) {
  if (article.image.url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={article.image.url}
        alt={article.image.alt || article.title}
        className="h-72 w-full border border-slate-300 object-cover"
      />
    );
  }
  return (
    <div className="flex h-72 w-full items-center justify-center border border-slate-300 bg-slate-200 text-center text-xs uppercase tracking-wide text-slate-500">
      {article.image.prompt || "Editorial image prompt ready"}
    </div>
  );
}

function ArticleRail({
  title,
  refs,
  citations,
}: {
  title: string;
  refs: string[];
  citations: Record<string, AtlasCitation>;
}) {
  if (refs.length === 0) return null;
  return (
    <section className="border border-slate-300 bg-white/35 p-4">
      <h2 className="font-serif text-2xl font-bold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-3">
        {refs.map((ref) => {
          const citation = citations[ref];
          if (!citation) return null;
          return (
            <div key={ref} className="border-b border-slate-300 pb-3 last:border-b-0">
              <p className="text-sm font-semibold text-slate-950">{citation.label}</p>
              <p className="mt-1 break-words text-xs text-slate-500">{ref}</p>
              {citation.body && (
                <p className="mt-2 text-sm leading-6 text-slate-700">{citation.body}</p>
              )}
              {citation.url && (
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex text-sm font-semibold text-slate-950 underline"
                >
                  Open source
                </a>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DeepDivePanel({
  dive,
  citations,
}: {
  dive: AtlasDeeperDive;
  citations: Record<string, AtlasCitation>;
}) {
  return (
    <section className="border-2 border-slate-900 bg-white/50 p-4">
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-600">
        {dive.retrieval_mode === "semantic" ? "Semantic retrieval" : "Keyword fallback"}
      </p>
      <h2 className="mt-1 font-serif text-2xl font-bold text-slate-950">{dive.title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-700">{dive.claim_under_review}</p>
      <DiveList title="Support" items={dive.supporting_evidence} />
      <DiveList title="Counterevidence" items={dive.counterevidence} />
      <DiveList title="Weak spots" items={dive.weak_spots} />
      <DiveList title="Alternative readings" items={dive.alternative_interpretations} />
      <DiveList title="Recommended actions" items={dive.recommended_actions} />
      <ArticleRail title="Divergence citations" refs={dive.citation_refs} citations={citations} />
    </section>
  );
}

function DiveList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="font-serif text-lg font-bold text-slate-950">{title}</h3>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <p key={index} className="text-sm leading-6 text-slate-700">{item}</p>
        ))}
      </div>
    </div>
  );
}
