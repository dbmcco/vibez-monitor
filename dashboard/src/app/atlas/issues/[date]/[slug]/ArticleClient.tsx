"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  atlasArticleHref,
  atlasFrontPageHref,
  isRenderableArticleImageUrl,
} from "@/lib/atlas-ui";

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

export default function AtlasArticleClient({
  articleDate,
  articleSlug,
  initialWindowHours,
  initialPayload,
  initialDeepDive,
  initialDeepDiveError,
  deepDiveHref,
}: {
  articleDate: string;
  articleSlug: string;
  initialWindowHours: number;
  initialPayload: AtlasPayload | null;
  initialDeepDive: AtlasDeeperDive | null;
  initialDeepDiveError: string | null;
  deepDiveHref: string;
}) {
  const [windowHours] = useState(initialWindowHours);
  const [payload, setPayload] = useState<AtlasPayload | null>(initialPayload);
  const [loading, setLoading] = useState(!initialPayload);

  useEffect(() => {
    if (initialPayload) {
      return;
    }
    let active = true;
    fetch(`/api/atlas?hours=${windowHours}`)
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
  }, [initialPayload, windowHours]);

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
                        <p className="mt-1 break-words text-xs text-slate-500">{ref}</p>
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
              <h2 className="font-serif text-2xl font-bold text-slate-950">Spawn deeper dive</h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Run retrieval and adversarial analysis against this article. This usually takes
                20-40 seconds.
              </p>
              <a
                href={deepDiveHref}
                className="mt-3 inline-flex border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-[#f8f4ea] hover:bg-[#342a1b] focus:outline-none focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 focus:ring-offset-[#f8f4ea]"
              >
                {initialDeepDive ? "Run deeper dive again" : "Spawn deeper dive"}
              </a>
              {!initialDeepDive && !initialDeepDiveError && (
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Opens a generated deeper-dive view for this story.
                </p>
              )}
              {initialDeepDiveError && (
                <div className="mt-3 border border-red-300 bg-red-50 p-3 text-sm leading-6 text-red-800">
                  <p className="font-semibold">Deeper dive failed.</p>
                  <p className="mt-1">{initialDeepDiveError}</p>
                </div>
              )}
            </section>

            {initialDeepDive && <DeepDivePanel dive={initialDeepDive} citations={citations} />}

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
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={editorialImageDataUri(article)}
      alt={article.image.alt || `Editorial image for ${article.title}`}
      className="h-72 w-full border border-slate-300 object-fill"
    />
  );
}

function editorialImageDataUri(article: AtlasEditorialArticle): string {
  const width = 960;
  const height = 420;
  const section = escapeSvgText(article.section.toUpperCase());
  const prompt = escapeSvgText((article.image.prompt || article.dek).slice(0, 92));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#e8dcc4"/>
      <rect x="18" y="18" width="${width - 36}" height="${height - 36}" fill="#f7edd9" stroke="#111827" stroke-width="3"/>
      <path d="M44 ${height - 82} C 240 ${height - 180}, 420 ${height - 18}, 590 ${height - 118} S 858 ${height - 72}, 922 ${height - 160}" fill="none" stroke="#8b5f21" stroke-width="18" opacity="0.38"/>
      <circle cx="822" cy="92" r="52" fill="#8b5f21" opacity="0.2"/>
      <line x1="44" y1="52" x2="916" y2="52" stroke="#111827" stroke-width="2"/>
      <line x1="44" y1="376" x2="916" y2="376" stroke="#111827" stroke-width="2"/>
      <text x="54" y="92" font-family="Georgia, serif" font-size="26" font-weight="700" fill="#8b5f21" letter-spacing="3">${section}</text>
      <text x="54" y="154" font-family="Georgia, serif" font-size="34" font-weight="900" fill="#111827">Editorial image brief</text>
      <text x="54" y="202" font-family="Arial, sans-serif" font-size="16" fill="#6b7280">${prompt}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
