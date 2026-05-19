import Link from "next/link";

import {
  generateAtlasDeeperDive,
  type AtlasDeeperDive,
  type AtlasDeeperDiveCitation,
} from "@/lib/atlas-deeper-dive";
import { atlasArticleHref, parseAtlasWindowHours } from "@/lib/atlas-ui";
import { readAtlasArtifact } from "@/lib/atlas-artifact";
import { cleanAtlasReaderText } from "@/lib/atlas-text";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ date: string; slug: string }> | { date: string; slug: string };
  searchParams?: Promise<{ hours?: string | string[] }> | { hours?: string | string[] };
};

async function resolveMaybe<T>(value: Promise<T> | T): Promise<T> {
  return value;
}

function BackToArticleLink({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex border border-[#cbbf9d] bg-[#f8f4ea] px-3 py-1.5 text-sm !text-[#342a1b]"
    >
      Back to article
    </Link>
  );
}

export default async function AtlasResearchDivePage({ params, searchParams }: PageProps) {
  const resolvedParams = await resolveMaybe(params);
  const resolvedSearchParams = searchParams ? await resolveMaybe(searchParams) : {};
  const rawHours = Array.isArray(resolvedSearchParams.hours)
    ? resolvedSearchParams.hours[0]
    : resolvedSearchParams.hours;
  const windowHours = parseAtlasWindowHours(rawHours);
  const artifact = await readAtlasArtifact(windowHours, resolvedParams.date);
  const article = artifact?.editorial_report.articles.find((item) =>
    item.slug === resolvedParams.slug,
  ) || null;
  const articleHref = atlasArticleHref(resolvedParams.date, resolvedParams.slug, windowHours);

  if (!artifact || !article) {
    return (
      <div className="atlas-newspaper fade-up space-y-4">
        <BackToArticleLink href={articleHref} />
        <section className="border border-[#d6cdbb] bg-[#f8f4ea] p-5 text-sm text-slate-800">
          Research dive unavailable for {resolvedParams.date}/{resolvedParams.slug}.
        </section>
      </div>
    );
  }

  let dive: AtlasDeeperDive | null = null;
  let errorMessage: string | null = null;
  try {
    dive = await generateAtlasDeeperDive({ article, hours: windowHours });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Research dive unavailable.";
  }

  if (!dive) {
    return (
      <div className="atlas-newspaper fade-up space-y-4">
        <BackToArticleLink href={articleHref} />
        <section className="border border-red-300 bg-red-50 p-5 text-sm leading-6 text-red-800">
          <p className="font-semibold">Research dive failed.</p>
          <p className="mt-1">{errorMessage || "Research dive unavailable."}</p>
        </section>
      </div>
    );
  }

  return (
    <ResearchDiveReport
      article={{
        title: article.title,
        dek: article.dek,
        section: article.section,
      }}
      articleHref={articleHref}
      date={artifact.editorial_report.issue.date}
      dive={dive}
    />
  );
}

function ResearchDiveReport({
  article,
  articleHref,
  date,
  dive,
}: {
  article: {
    title: string;
    dek: string;
    section: string;
  };
  articleHref: string;
  date: string;
  dive: AtlasDeeperDive;
}) {
  return (
    <div className="atlas-newspaper fade-up space-y-5">
      <BackToArticleLink href={articleHref} />
      <article className="border border-[#d6cdbb] bg-[#f8f4ea] p-5 text-slate-950 sm:p-8">
        <header className="border-b-4 border-double border-slate-900 pb-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
            <span>Semantic corpus research</span>
            <span>{date}</span>
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-[#8b5f21]">
            Seed story: {article.section}
          </p>
          <h1 className="mt-2 max-w-5xl font-serif text-3xl font-black leading-tight tracking-normal text-slate-950 sm:text-5xl sm:leading-none lg:text-6xl">
            {dive.title}
          </h1>
          <p className="mt-4 max-w-4xl text-lg leading-8 text-slate-700">
            {dive.research_question}
          </p>
        </header>

        <div className="mt-7 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="space-y-7">
            <ReportSection title="What else was said" items={dive.what_else_was_said} featured />
            <ReportSection title="Why it matters" items={dive.why_it_matters} />
            <ReportSection title="Patterns" items={dive.patterns} />
            <ReportSection title="Tensions" items={dive.tensions} />
            <ReportSection title="Open questions" items={dive.open_questions} />
            <ReportSection title="Recommended actions" items={dive.recommended_actions} />
          </main>

          <aside className="space-y-4">
            <section className="border-2 border-slate-900 bg-white/40 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-600">
                Source article
              </p>
              <h2 className="mt-1 font-serif text-2xl font-bold text-slate-950">{article.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-700">{article.dek}</p>
            </section>
            <section className="border border-slate-300 bg-white/35 p-4">
              <h2 className="font-serif text-2xl font-bold text-slate-950">Research citations</h2>
              <div className="mt-3 space-y-3">
                {dive.citation_details.map((citation) => (
                  <CitationCard key={citation.ref} citation={citation} />
                ))}
                {dive.citation_details.length === 0 && (
                  <p className="text-sm leading-6 text-slate-700">
                    The model did not return citation refs that survived validation.
                  </p>
                )}
              </div>
            </section>
          </aside>
        </div>
      </article>
    </div>
  );
}

function ReportSection({
  title,
  items,
  featured = false,
}: {
  title: string;
  items: string[];
  featured?: boolean;
}) {
  return (
    <section className={featured ? "border-b-2 border-slate-900 pb-6" : "border-b border-slate-300 pb-6"}>
      <h2 className="font-serif text-2xl font-bold text-slate-950 sm:text-3xl">{title}</h2>
      <div className="mt-3 space-y-3">
        {items.map((item, index) => (
          <p key={index} className="text-base leading-8 text-slate-800 sm:text-lg">
            {cleanAtlasReaderText(item)}
          </p>
        ))}
      </div>
    </section>
  );
}

function CitationCard({ citation }: { citation: AtlasDeeperDiveCitation }) {
  return (
    <div className="border-b border-slate-300 pb-3 last:border-b-0">
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
}
