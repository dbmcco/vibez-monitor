"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

interface AtlasCitation {
  ref: string;
  type: "message" | "link";
  id: string;
  label: string;
  channel?: string;
  sender?: string;
  timestamp?: number;
  body?: string;
  topics?: string[];
  relevance_score?: number | null;
  url?: string;
  title?: string;
}

interface AtlasMatrixCell {
  channel: string;
  topic: string;
  message_count: number;
  people: string[];
  latest_timestamp: number;
  avg_relevance: number | null;
  citation_refs: string[];
}

interface AtlasNarrative {
  title: string;
  summary: string;
  report: {
    headline: string;
    kicker: string;
    lead: string;
    what_matters: string[];
    what_to_watch: string[];
    evidence_refs: string[];
  };
  paragraphs: string[];
  main_topic: {
    title: string;
    topic: string | null;
    paragraphs: string[];
    citation_refs: string[];
  };
  week_in_review: {
    title: string;
    bullets: string[];
  };
}

interface AtlasSnapshot {
  generated_at: string;
  window: { start: string; end: string; hours: number };
  overview: {
    messages: number;
    people: number;
    channels: number;
    topics: number;
    links: number;
  };
  channels: Array<{
    name: string;
    message_count: number;
    people: string[];
    top_topics: Array<{ name: string; count: number }>;
    citation_refs: string[];
  }>;
  topics: Array<{
    name: string;
    message_count: number;
    channels: string[];
    people: string[];
    citation_refs: string[];
  }>;
  matrix: AtlasMatrixCell[];
  concerns: Array<{
    kind: "hot_alert" | "unresolved_question" | "under_covered";
    title: string;
    detail: string;
    citation_refs: string[];
  }>;
  links: Array<{
    ref: string;
    url: string;
    title: string;
    category: string;
    shared_by: string;
    source_group: string;
    last_seen: string | null;
  }>;
  citations: Record<string, AtlasCitation>;
  narrative: AtlasNarrative;
}

interface AtlasEditorialReport {
  issue: {
    date: string;
    title: string;
    subtitle: string;
    edition_label: string;
  };
  headline: string;
  dek: string;
  what_happened: string[];
  what_it_means: string[];
  why_care: string[];
  valuable: string[];
  actions: string[];
  main_topic: {
    title: string;
    paragraphs: string[];
    evidence_refs: string[];
  };
  articles: AtlasEditorialArticle[];
  briefs: Array<{
    title: string;
    text: string;
    evidence_refs: string[];
  }>;
  crosscurrents: Array<{
    title: string;
    text: string;
    channels: string[];
    evidence_refs: string[];
  }>;
  themes: Array<{
    title: string;
    analysis: string;
    evidence_refs: string[];
  }>;
  evidence: Array<{
    ref: string;
    label: string;
    why_it_matters: string;
  }>;
  generated_at: string;
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

type Lens = "themes" | "rooms" | "evidence" | "diagnostics";

const LENSES: Array<{ key: Lens; label: string }> = [
  { key: "themes", label: "Themes" },
  { key: "rooms", label: "Rooms" },
  { key: "evidence", label: "Evidence" },
  { key: "diagnostics", label: "Diagnostics" },
];

export default function AtlasPage() {
  const [atlas, setAtlas] = useState<AtlasSnapshot | null>(null);
  const [editorialReport, setEditorialReport] = useState<AtlasEditorialReport | null>(null);
  const [editorialError, setEditorialError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowHours, setWindowHours] = useState(48);
  const [lens, setLens] = useState<Lens>("themes");
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [selectedCitationRef, setSelectedCitationRef] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/atlas?hours=${windowHours}`)
      .then((response) => response.json())
      .then((payload: {
        atlas: AtlasSnapshot | null;
        editorial_report: AtlasEditorialReport | null;
        editorial_error?: string | null;
      }) => {
        if (!active) return;
        setAtlas(payload.atlas);
        setEditorialReport(payload.editorial_report);
        setEditorialError(payload.editorial_error || null);
        setSelectedCellKey(payload.atlas?.matrix[0] ? cellKey(payload.atlas.matrix[0]) : null);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Atlas data is unavailable right now.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [windowHours]);

  const selectedCell = useMemo(() => {
    if (!atlas || !selectedCellKey) return atlas?.matrix[0] || null;
    return atlas.matrix.find((cell) => cellKey(cell) === selectedCellKey) || atlas.matrix[0] || null;
  }, [atlas, selectedCellKey]);

  const selectedCitation =
    atlas && selectedCitationRef ? atlas.citations[selectedCitationRef] || null : null;

  function handleWindowHoursChange(hours: number) {
    if (hours === windowHours) return;
    setLoading(true);
    setError(null);
    setEditorialReport(null);
    setEditorialError(null);
    setSelectedCitationRef(null);
    setWindowHours(hours);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Header />
        <div className="rounded-xl border border-[#cbbf9d] bg-[#f4ead7] p-6 text-[#1f1a12] shadow-[0_18px_60px_rgba(32,24,12,0.22)]">
          <div className="border-b-4 border-double border-[#1f1a12] pb-4 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#786846]">
              Daily Edition | Last 48 Hours
            </p>
            <h2 className="mt-2 font-serif text-4xl font-black text-[#1f1a12] sm:text-6xl">
              THE VIBEZ ATLAS
            </h2>
            <p className="mt-3 text-sm text-[#5e5238]">
              Setting type, checking citations, and sending the newsroom back for one more pass...
            </p>
          </div>
          <div className="mt-6 grid gap-5 lg:grid-cols-[0.9fr_1.35fr_0.9fr]">
            <div className="h-52 border border-[#cbbf9d] bg-[#fffaf0]/55" />
            <div className="h-72 border border-[#cbbf9d] bg-[#fffaf0]/65" />
            <div className="h-52 border border-[#cbbf9d] bg-[#fffaf0]/55" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !atlas) {
    return (
      <div className="space-y-4">
        <Header />
        <div className="rounded-xl border border-[#cbbf9d] bg-[#f4ead7] p-5 text-sm text-[#342a1b]">
          {error || "Atlas data is unavailable right now."}
        </div>
      </div>
    );
  }

  const matrixTopics = atlas.topics.slice(0, 8).map((topic) => topic.name);
  const matrixChannels = atlas.channels.slice(0, 12).map((channel) => channel.name);

  return (
    <div className="fade-up -m-2 space-y-6 rounded-xl border border-[#cbbf9d] bg-[#efe3cc] p-3 text-[#1f1a12] shadow-[0_22px_80px_rgba(18,14,8,0.26)] sm:-m-4 sm:p-5">
      <Header />

      <NarrativeReport
        atlas={atlas}
        editorialReport={editorialReport}
        editorialError={editorialError}
        windowHours={windowHours}
        onWindowHoursChange={handleWindowHoursChange}
      />

      <section className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-bold text-[#1f1a12]">Below the Fold</h2>
            <p className="mt-1 text-sm text-[#5e5238]">
              Read the themes first. Use diagnostics only when you need the raw shape.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {LENSES.map((item) => (
              <button
                key={item.key}
                onClick={() => setLens(item.key)}
                className={`rounded border px-3 py-1.5 text-sm font-semibold ${
                  lens === item.key
                    ? "border-[#1f1a12] bg-[#1f1a12] text-[#f8f4ea]"
                    : "border-[#b9aa86] bg-[#fffaf0]/45 text-[#342a1b] hover:border-[#1f1a12]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_0.8fr]">
        <div className="space-y-4">
          {lens === "themes" && <TopicLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "rooms" && <ChannelLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "evidence" && <EvidenceLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "diagnostics" && (
            <Matrix
              atlas={atlas}
              channels={matrixChannels}
              topics={matrixTopics}
              selectedCellKey={selectedCell ? cellKey(selectedCell) : null}
              onSelectCell={(cell) => setSelectedCellKey(cellKey(cell))}
            />
          )}
        </div>

        {lens === "diagnostics" ? (
          <DetailRail
            atlas={atlas}
            cell={selectedCell}
            onOpenCitation={setSelectedCitationRef}
          />
        ) : (
          <AtAGlance atlas={atlas} />
        )}
      </section>

      {selectedCitation && (
        <EvidenceDrawer
          citation={selectedCitation}
          onClose={() => setSelectedCitationRef(null)}
        />
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4 text-[#1f1a12]">
      <p className="text-xs font-bold tracking-[0.16em] text-[#786846] uppercase">
        Vibez
      </p>
      <h1 className="mt-1 font-serif text-3xl font-black text-[#1f1a12] sm:text-4xl">
        The Vibez Atlas
      </h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5e5238]">
        A daily newspaper front page for the rooms, themes, evidence, and arguments worth reading.
      </p>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-[#cbbf9d] bg-[#fffaf0]/45 p-3">
      <div className="text-xs text-[#786846]">{label}</div>
      <div className="mt-1 font-serif text-2xl font-bold text-[#1f1a12]">{value.toLocaleString()}</div>
    </div>
  );
}

function NarrativeReport({
  atlas,
  editorialReport,
  editorialError,
  windowHours,
  onWindowHoursChange,
}: {
  atlas: AtlasSnapshot;
  editorialReport: AtlasEditorialReport | null;
  editorialError: string | null;
  windowHours: number;
  onWindowHoursChange: (hours: number) => void;
}) {
  const report = editorialReport;
  const leadArticle = report?.articles.find((article) => article.role === "lead") || report?.articles[0] || null;
  const sideArticles = report?.articles.filter((article) => article.slug !== leadArticle?.slug).slice(0, 4) || [];
  const leftArticle = sideArticles[0] || null;
  const rightArticle = sideArticles[1] || null;
  const belowArticles = sideArticles.slice(2);
  return (
    <section className="rounded-xl border border-[#b9aa86] bg-[#f8f4ea] p-4 text-[#1f1a12] shadow-[0_18px_60px_rgba(32,24,12,0.18)] sm:p-6">
      <div className="border-b-4 border-double border-[#1f1a12] pb-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#786846]">
          <span>{report?.issue.edition_label || atlas.narrative.title}</span>
          <span>|</span>
          <span>{report?.issue.date || atlas.window.end.slice(0, 10)}</span>
        </div>
        <h2 className="mt-2 font-serif text-4xl font-black tracking-normal text-[#1f1a12] sm:text-6xl">
          {report?.issue.title || "The Vibez Atlas"}
        </h2>
        <p className="mx-auto mt-2 max-w-3xl text-sm leading-6 text-[#5e5238] sm:text-base">
          {report?.issue.subtitle ||
            report?.dek ||
            `The Atlas evidence loaded, but the editorial analysis did not. ${editorialError || "Try again after the report model is available."}`}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {[48, 168].map((hours) => (
            <button
              key={hours}
              onClick={() => onWindowHoursChange(hours)}
              className={`rounded border px-3 py-1.5 text-sm ${
                windowHours === hours
                  ? "border-[#1f1a12] bg-[#1f1a12] text-[#f8f4ea]"
                  : "border-[#b9aa86] bg-transparent text-[#342a1b] hover:border-[#1f1a12]"
              }`}
            >
              {hours === 48 ? "48h" : "Week"}
            </button>
          ))}
        </div>
      </div>

      {report && leadArticle ? (
        <>
          <div className="mt-6 grid gap-5 lg:grid-cols-[0.9fr_1.35fr_0.9fr]">
            <div className="space-y-5 lg:border-r lg:border-[#cbbf9d] lg:pr-5">
              {leftArticle && (
                <NewspaperArticleCard
                  article={leftArticle}
                  issueDate={report.issue.date}
                  compact
                />
              )}
            </div>
            <NewspaperArticleCard
              article={leadArticle}
              issueDate={report.issue.date}
              lead
            />
            <div className="space-y-5 lg:border-l lg:border-[#cbbf9d] lg:pl-5">
              {rightArticle && (
                <NewspaperArticleCard
                  article={rightArticle}
                  issueDate={report.issue.date}
                  compact
                />
              )}
              {!rightArticle && (
                <div className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4">
                  <h3 className="font-serif text-xl font-bold text-[#1f1a12]">
                    Evidence Desk
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#5e5238]">
                    The matrix, citations, stats, and links sit below the fold.
                  </p>
                </div>
              )}
            </div>
          </div>

          {belowArticles.length > 0 && (
            <div className="mt-6 grid gap-4 border-t border-[#cbbf9d] pt-4 lg:grid-cols-2">
              {belowArticles.map((article) => (
                <NewspaperArticleCard
                  key={article.slug}
                  article={article}
                  issueDate={report.issue.date}
                  compact
                />
              ))}
            </div>
          )}

          <div className="mt-6 border-t-2 border-[#1f1a12] pt-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <NewspaperList title="Briefs" items={report.briefs.map((brief) => brief.text)} />
              <NewspaperList
                title="Crosscurrents"
                items={report.crosscurrents.map((item) => `${item.title}: ${item.text}`)}
              />
            </div>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <NewspaperList title="What to do next" items={report.actions} />
            <NewspaperList title="Why it matters" items={report.why_care} />
          </div>
        </>
      ) : (
        <div className="mt-5 rounded border border-[#b3833a]/40 bg-[#f1dfb8] p-4 text-sm leading-relaxed text-[#4a3214]">
          The data is here, but the editorial layer failed. Atlas is showing diagnostics below
          instead of filling the gap with fake narrative.
        </div>
      )}
    </section>
  );
}

function NewspaperArticleCard({
  article,
  issueDate,
  lead = false,
  compact = false,
}: {
  article: AtlasEditorialArticle;
  issueDate: string;
  lead?: boolean;
  compact?: boolean;
}) {
  return (
    <article className={lead ? "" : "border-b border-[#cbbf9d] pb-4 last:border-b-0"}>
      <ImageBlock article={article} lead={lead} />
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em]">
        <span className="text-[#8b5f21]">{article.section}</span>
        {lead && <span className="text-[#786846]">Lead Story</span>}
      </div>
      <h3 className={`mt-1 font-serif font-black leading-none text-slate-950 ${
        lead ? "text-4xl sm:text-5xl" : "text-2xl"
      }`}>
        {article.title}
      </h3>
      <p className={`mt-3 leading-7 text-[#5e5238] ${compact ? "text-sm" : "text-base"}`}>
        {article.summary || article.dek}
      </p>
      <Link
        href={`/atlas/issues/${issueDate}/${article.slug}`}
        className="mt-3 inline-flex border border-[#1f1a12] px-3 py-1.5 text-sm font-semibold text-[#1f1a12] hover:bg-[#1f1a12] hover:text-[#f8f4ea]"
      >
        Read full article
      </Link>
    </article>
  );
}

function ImageBlock({ article, lead }: { article: AtlasEditorialArticle; lead: boolean }) {
  if (article.image.url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={article.image.url}
        alt={article.image.alt || article.title}
        className={`w-full border border-[#cbbf9d] object-cover ${lead ? "h-64" : "h-32"}`}
      />
    );
  }
  return (
    <div className={`flex w-full items-center justify-center border border-[#cbbf9d] bg-[#e4d7bd] px-3 text-center text-xs uppercase tracking-wide text-[#786846] ${
      lead ? "h-64" : "h-32"
    }`}>
      {article.image.kind === "generated" ? "Editorial image prompt ready" : "Article image"}
    </div>
  );
}

function NewspaperList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4">
      <h3 className="font-serif text-2xl font-bold text-[#1f1a12]">{title}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item, index) => (
          <p key={index} className="text-sm leading-6 text-[#5e5238]">
            {item}
          </p>
        ))}
      </div>
    </section>
  );
}

function AtAGlance({ atlas }: { atlas: AtlasSnapshot }) {
  return (
    <aside className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8b5f21]">
        At a glance
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Messages" value={atlas.overview.messages} />
        <Metric label="People" value={atlas.overview.people} />
        <Metric label="Rooms" value={atlas.overview.channels} />
        <Metric label="Themes" value={atlas.overview.topics} />
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#786846]">Useful links</p>
        {atlas.links.slice(0, 4).map((link) => (
          <a
            key={link.ref}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded border border-[#cbbf9d] bg-[#fffaf0]/45 p-2 text-xs text-[#342a1b] hover:border-[#1f1a12]"
          >
            {link.title}
          </a>
        ))}
        {atlas.links.length === 0 && (
          <p className="text-sm text-[#786846]">No links in this report.</p>
        )}
      </div>
    </aside>
  );
}

function Matrix({
  atlas,
  channels,
  topics,
  selectedCellKey,
  onSelectCell,
}: {
  atlas: AtlasSnapshot;
  channels: string[];
  topics: string[];
  selectedCellKey: string | null;
  onSelectCell: (cell: AtlasMatrixCell) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
      <div
        className="grid min-w-[760px] gap-1"
        style={{ gridTemplateColumns: `minmax(160px, 1.2fr) repeat(${topics.length}, minmax(86px, 1fr))` }}
      >
        <div className="px-2 py-2 text-xs font-semibold text-[#786846]">Channel</div>
        {topics.map((topic) => (
          <div key={topic} className="px-2 py-2 text-xs font-semibold text-[#342a1b]">
            {topic}
          </div>
        ))}
        {channels.map((channel) => (
          <MatrixRow
            key={channel}
            atlas={atlas}
            channel={channel}
            topics={topics}
            selectedCellKey={selectedCellKey}
            onSelectCell={onSelectCell}
          />
        ))}
      </div>
    </div>
  );
}

function MatrixRow({
  atlas,
  channel,
  topics,
  selectedCellKey,
  onSelectCell,
}: {
  atlas: AtlasSnapshot;
  channel: string;
  topics: string[];
  selectedCellKey: string | null;
  onSelectCell: (cell: AtlasMatrixCell) => void;
}) {
  return (
    <>
      <div className="rounded bg-[#e4d7bd] px-2 py-2 text-sm font-medium text-[#1f1a12]">
        {channel}
      </div>
      {topics.map((topic) => {
        const cell = atlas.matrix.find((item) => item.channel === channel && item.topic === topic);
        if (!cell) {
          return <div key={topic} className="rounded border border-[#d8ccb2] bg-[#fffaf0]/35" />;
        }
        const selected = selectedCellKey === cellKey(cell);
        return (
          <button
            key={topic}
            onClick={() => onSelectCell(cell)}
            className={`rounded border px-2 py-2 text-left transition ${
              selected
                ? "border-[#1f1a12] bg-[#1f1a12]/10"
                : "border-[#cbbf9d] bg-[#fffaf0]/45 hover:border-[#1f1a12]"
            }`}
          >
            <span className="block text-sm font-semibold text-[#1f1a12]">
              {cell.message_count}
            </span>
            <span className="block text-[11px] text-[#786846]">
              {cell.citation_refs.length} refs
            </span>
          </button>
        );
      })}
    </>
  );
}

function DetailRail({
  atlas,
  cell,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  cell: AtlasMatrixCell | null;
  onOpenCitation: (ref: string) => void;
}) {
  if (!cell) {
    return (
      <aside className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-5 text-sm text-[#786846]">
        Select a matrix cell to inspect its evidence.
      </aside>
    );
  }

  return (
    <aside className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#8b5f21]">Selected intersection</p>
      <h2 className="mt-2 font-serif text-xl font-bold text-[#1f1a12]">{cell.topic}</h2>
      <p className="mt-1 text-sm text-[#786846]">{cell.channel}</p>
      <div className="mt-4 grid gap-2 text-sm text-[#342a1b]">
        <p>{cell.message_count} messages from {cell.people.length} people.</p>
        <p>Average relevance: {cell.avg_relevance ?? "n/a"}</p>
        <p>Latest activity: {formatTimestamp(cell.latest_timestamp)}</p>
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#786846]">Citations</p>
        {cell.citation_refs.map((ref) => (
          <CitationButton key={ref} citation={atlas.citations[ref]} onOpen={() => onOpenCitation(ref)} />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/stats" className="rounded border border-[#cbbf9d] bg-[#fffaf0]/45 px-2.5 py-1 text-xs text-[#342a1b] hover:border-[#1f1a12]">
          Open Stats
        </Link>
        <Link href="/links" className="rounded border border-[#cbbf9d] bg-[#fffaf0]/45 px-2.5 py-1 text-xs text-[#342a1b] hover:border-[#1f1a12]">
          Open Links
        </Link>
      </div>
    </aside>
  );
}

function ChannelLens({ atlas, onOpenCitation }: { atlas: AtlasSnapshot; onOpenCitation: (ref: string) => void }) {
  return (
    <LensGrid>
      {atlas.channels.map((channel) => (
        <article key={channel.name} className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
          <p className="text-sm font-semibold text-[#1f1a12]">{channel.name}</p>
          <p className="mt-1 text-xs text-[#786846]">
            {channel.message_count} messages | {channel.people.length} people
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {channel.top_topics.map((topic) => (
              <span key={topic.name} className="rounded border border-[#cbbf9d] bg-[#fffaf0]/45 px-2 py-0.5 text-xs text-[#342a1b]">
                {topic.name} | {topic.count}
              </span>
            ))}
          </div>
          <CitationList atlas={atlas} refs={channel.citation_refs} onOpenCitation={onOpenCitation} />
        </article>
      ))}
    </LensGrid>
  );
}

function TopicLens({ atlas, onOpenCitation }: { atlas: AtlasSnapshot; onOpenCitation: (ref: string) => void }) {
  return (
    <LensGrid>
      {atlas.topics.map((topic) => (
        <article key={topic.name} className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
          <p className="text-sm font-semibold text-[#1f1a12]">{topic.name}</p>
          <p className="mt-1 text-xs text-[#786846]">
            {topic.message_count} messages | {topic.channels.length} channels
          </p>
          <p className="mt-2 text-xs text-[#786846]">{topic.channels.slice(0, 5).join(", ")}</p>
          <CitationList atlas={atlas} refs={topic.citation_refs} onOpenCitation={onOpenCitation} />
        </article>
      ))}
    </LensGrid>
  );
}

function LinkLens({ atlas, onOpenCitation }: { atlas: AtlasSnapshot; onOpenCitation: (ref: string) => void }) {
  return (
    <LensGrid>
      {atlas.links.map((link) => (
        <article key={link.ref} className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-[#1f1a12] underline">
            {link.title}
          </a>
          <p className="mt-1 text-xs text-[#786846]">
            {link.category} | {link.shared_by} | {link.source_group}
          </p>
          <button
            onClick={() => onOpenCitation(link.ref)}
            className="mt-3 rounded border border-[#1f1a12] bg-[#1f1a12] px-2 py-1 text-xs text-[#f8f4ea]"
          >
            Open citation
          </button>
        </article>
      ))}
    </LensGrid>
  );
}

function EvidenceLens({
  atlas,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  onOpenCitation: (ref: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-serif text-xl font-bold text-[#1f1a12]">Open questions</h3>
        <div className="mt-3 space-y-3">
          {atlas.concerns.map((concern, index) => (
            <article key={`${concern.kind}-${index}`} className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4">
              <p className="text-sm font-semibold text-[#1f1a12]">{concern.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-[#5e5238]">{concern.detail}</p>
              <CitationList atlas={atlas} refs={concern.citation_refs} onOpenCitation={onOpenCitation} />
            </article>
          ))}
          {atlas.concerns.length === 0 && (
            <div className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4 text-sm text-[#786846]">
              No open questions stand out in this report.
            </div>
          )}
        </div>
      </div>
      <div>
        <h3 className="font-serif text-xl font-bold text-[#1f1a12]">Shared links</h3>
        <div className="mt-3">
          <LinkLens atlas={atlas} onOpenCitation={onOpenCitation} />
        </div>
      </div>
    </div>
  );
}

function LensGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

function CitationList({
  atlas,
  refs,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  refs: string[];
  onOpenCitation: (ref: string) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {refs.map((ref) => (
        <CitationButton key={ref} citation={atlas.citations[ref]} onOpen={() => onOpenCitation(ref)} />
      ))}
    </div>
  );
}

function CitationButton({ citation, onOpen }: { citation?: AtlasCitation; onOpen: () => void }) {
  if (!citation) return null;
  return (
    <button
      onClick={onOpen}
      className="block w-full rounded border border-[#cbbf9d] bg-[#fffaf0]/45 px-3 py-2 text-left text-xs text-[#5e5238] hover:border-[#1f1a12]"
    >
      <span className="block font-medium text-[#1f1a12]">{citation.label}</span>
      <span className="mt-0.5 block text-[#786846]">{citation.ref}</span>
    </button>
  );
}

function EvidenceDrawer({ citation, onClose }: { citation: AtlasCitation; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-[#1f1a12]/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="ml-auto h-full max-w-xl overflow-y-auto rounded-xl border border-[#cbbf9d] bg-[#f8f4ea] p-5 text-[#1f1a12] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-[#8b5f21]">{citation.type} citation</p>
            <h2 className="mt-2 font-serif text-xl font-bold text-[#1f1a12]">{citation.label}</h2>
          </div>
          <button onClick={onClose} className="rounded border border-[#cbbf9d] bg-[#fffaf0]/45 px-2 py-1 text-xs text-[#342a1b]">
            Close
          </button>
        </div>
        <dl className="mt-5 grid gap-3 text-sm">
          <EvidenceRow label="Ref" value={citation.ref} />
          {citation.channel && <EvidenceRow label="Channel" value={citation.channel} />}
          {citation.sender && <EvidenceRow label="Sender" value={citation.sender} />}
          {citation.timestamp && <EvidenceRow label="Time" value={formatTimestamp(citation.timestamp)} />}
          {citation.relevance_score !== undefined && (
            <EvidenceRow label="Relevance" value={String(citation.relevance_score ?? "n/a")} />
          )}
          {citation.topics && citation.topics.length > 0 && (
            <EvidenceRow label="Topics" value={citation.topics.join(", ")} />
          )}
        </dl>
        {citation.body && (
          <p className="mt-5 rounded-lg border border-[#cbbf9d] bg-[#fffaf0]/55 p-3 text-sm leading-relaxed text-[#342a1b]">
            {citation.body}
          </p>
        )}
        {citation.url && (
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex rounded-md border border-[#1f1a12] bg-[#1f1a12] px-3 py-2 text-sm text-[#f8f4ea]"
          >
            Open source link
          </a>
        )}
      </aside>
    </div>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[#786846]">{label}</dt>
      <dd className="mt-0.5 break-words text-[#342a1b]">{value}</dd>
    </div>
  );
}

function cellKey(cell: AtlasMatrixCell): string {
  return `${cell.channel}||${cell.topic}`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
