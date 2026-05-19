"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  atlasArticleHref,
  atlasFrontPageHref,
  isRenderableArticleImageUrl,
} from "@/lib/atlas-ui";
import { cleanAtlasReaderText } from "@/lib/atlas-text";

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
    status?: "pending" | "ready" | "failed" | "skipped";
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

export default function AtlasArticleClient({
  articleDate,
  articleSlug,
  initialWindowHours,
  initialPayload,
  deepDiveHref,
}: {
  articleDate: string;
  articleSlug: string;
  initialWindowHours: number;
  initialPayload: AtlasPayload | null;
  deepDiveHref: string;
}) {
  const [windowHours] = useState(initialWindowHours);
  const [payload, setPayload] = useState<AtlasPayload | null>(initialPayload);
  const [loading] = useState(false);

  useEffect(() => {
    setPayload(initialPayload);
  }, [initialPayload]);

  const article = useMemo(() => {
    return payload?.editorial_report?.articles.find((item) => item.slug === articleSlug) || null;
  }, [payload, articleSlug]);
  const citations = payload?.atlas?.citations || {};
  const related = payload?.editorial_report?.articles.filter((item) =>
    article?.related_article_slugs.includes(item.slug),
  ) || [];

  if (loading) {
    return <div className="rounded-xl border border-[#cbbf9d] bg-[#f8f4ea] p-5 text-sm text-[#342a1b]">Loading article...</div>;
  }

  if (!payload?.editorial_report || !payload.atlas || !article) {
    return (
      <div className="space-y-4">
        <Link href={atlasFrontPageHref(windowHours)} className="inline-flex rounded border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm text-[#342a1b]">
          Back to Atlas
        </Link>
        <div className="rounded-xl border border-[#cbbf9d] bg-[#f8f4ea] p-5 text-sm text-[#342a1b]">
          Article unavailable for {articleDate}/{articleSlug}.
        </div>
      </div>
    );
  }

  return (
    <div className="atlas-newspaper fade-up space-y-5">
      <Link href={atlasFrontPageHref(windowHours)} className="inline-flex rounded border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm !text-[#342a1b]">
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
          <p className="mt-4 max-w-4xl text-lg leading-8 text-slate-700">
            {cleanAtlasReaderText(article.dek)}
          </p>
        </header>

        <div className="mt-6 grid gap-7 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.65fr)]">
          <main>
            <ArticleImage article={article} />
            <div className="mt-6 space-y-4 text-base leading-8 text-slate-800 sm:text-lg">
              {article.body.map((paragraph, index) => (
                <p key={index}>{cleanAtlasReaderText(paragraph)}</p>
              ))}
            </div>
            {article.evidence_refs.length > 0 && (
              <section className="mt-6 border-y border-slate-300 py-4">
                <h2 className="font-serif text-2xl font-bold text-slate-950">Citations</h2>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {article.evidence_refs.map((ref) => {
                    const citation = citations[ref];
                    if (!citation) return null;
                    return (
                      <div key={ref} className="border border-slate-300 bg-white/35 p-3">
                        <p className="text-sm font-semibold text-slate-950">{citation.label}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
            {article.actions.length > 0 && (
              <section className="mt-7 border-t-2 border-slate-900 pt-4">
                <h2 className="font-serif text-2xl font-bold text-slate-950">What to do next</h2>
                <div className="mt-3 space-y-2">
                  {article.actions.map((action, index) => (
                    <p key={index} className="text-sm leading-6 text-slate-700">
                      {cleanAtlasReaderText(action)}
                    </p>
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
                      href={atlasArticleHref(payload.editorial_report!.issue.date, item.slug, windowHours)}
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
              <h2 className="font-serif text-2xl font-bold text-slate-950">Spawn research dive</h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Search the broader AGI channel corpus for related thinking, then synthesize a
                follow-on research report. This usually takes 20-40 seconds.
              </p>
              <a
                href={deepDiveHref}
                className="mt-3 inline-flex border-2 border-slate-950 bg-slate-950 px-3.5 py-2.5 text-sm font-bold !text-white shadow-sm hover:bg-[#342a1b] focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 focus:ring-offset-[#f8f4ea]"
              >
                Open research dive
              </a>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Opens a full research report page for this story.
              </p>
            </section>

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
  if (isRenderableArticleImageUrl(article.image.url)) {
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
    <div
      data-atlas-photo-status={article.image.status || "pending"}
      className="flex h-72 w-full flex-col justify-between border border-slate-300 bg-[#e8dcc4] p-5"
      aria-label="Photo desk pending"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#cbbf9d] pb-3">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8b5f21]">
          Photo desk pending
        </p>
        <span className="h-2.5 w-2.5 rounded-full bg-[#8b5f21]" aria-hidden="true" />
      </div>
      <p className="max-w-3xl text-sm leading-6 text-[#342a1b]">
        {article.image.prompt || article.dek}
      </p>
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
              {citation.body && (
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  {cleanAtlasReaderText(citation.body)}
                </p>
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
