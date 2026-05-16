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
        <div className="vibe-panel rounded-xl p-5 text-sm text-slate-300">
          Building the latest 48h channel-topic map...
        </div>
      </div>
    );
  }

  if (error || !atlas) {
    return (
      <div className="space-y-4">
        <Header />
        <div className="vibe-panel rounded-xl p-5 text-sm text-slate-300">
          {error || "Atlas data is unavailable right now."}
        </div>
      </div>
    );
  }

  const matrixTopics = atlas.topics.slice(0, 8).map((topic) => topic.name);
  const matrixChannels = atlas.channels.slice(0, 12).map((channel) => channel.name);

  return (
    <div className="fade-up space-y-6">
      <Header />

      <NarrativeReport
        atlas={atlas}
        editorialReport={editorialReport}
        editorialError={editorialError}
        windowHours={windowHours}
        onWindowHoursChange={handleWindowHoursChange}
      />

      <section className="vibe-panel rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="vibe-title text-lg text-slate-100">Explore the evidence</h2>
            <p className="mt-1 text-sm text-slate-400">
              Read the themes first. Use diagnostics only when you need the raw shape.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {LENSES.map((item) => (
              <button
                key={item.key}
                onClick={() => setLens(item.key)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  lens === item.key ? "vibe-button" : "vibe-chip"
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
    <header className="space-y-2">
      <p className="text-xs font-medium tracking-[0.16em] text-cyan-300/90 uppercase">
        Vibez
      </p>
      <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
        The Latest Report
      </h1>
      <p className="vibe-subtitle max-w-3xl">
        A readable brief first. Evidence and diagnostics stay close at hand.
      </p>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-800/80 bg-slate-950/35 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="vibe-title mt-1 text-2xl text-slate-100">{value.toLocaleString()}</div>
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
  return (
    <section className="vibe-panel rounded-xl bg-[#f8f4ea] p-4 text-slate-950 sm:p-6">
      <div className="border-b-4 border-double border-slate-900 pb-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          <span>{report?.issue.edition_label || atlas.narrative.title}</span>
          <span>|</span>
          <span>{report?.issue.date || atlas.window.end.slice(0, 10)}</span>
        </div>
        <h2 className="mt-2 font-serif text-4xl font-black tracking-normal text-slate-950 sm:text-6xl">
          {report?.issue.title || "The Vibez Atlas"}
        </h2>
        <p className="mx-auto mt-2 max-w-3xl text-sm leading-6 text-slate-700 sm:text-base">
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
                  ? "border-slate-900 bg-slate-900 text-[#f8f4ea]"
                  : "border-slate-400 bg-transparent text-slate-800 hover:border-slate-900"
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
            <div className="space-y-5 lg:border-r lg:border-slate-300 lg:pr-5">
              {sideArticles.slice(0, 2).map((article) => (
                <NewspaperArticleCard
                  key={article.slug}
                  article={article}
                  issueDate={report.issue.date}
                  compact
                />
              ))}
            </div>
            <NewspaperArticleCard
              article={leadArticle}
              issueDate={report.issue.date}
              lead
            />
            <div className="space-y-5 lg:border-l lg:border-slate-300 lg:pl-5">
              {sideArticles.slice(2, 4).map((article) => (
                <NewspaperArticleCard
                  key={article.slug}
                  article={article}
                  issueDate={report.issue.date}
                  compact
                />
              ))}
              {sideArticles.length < 3 && (
                <div className="border border-slate-300 bg-white/35 p-4">
                  <h3 className="font-serif text-xl font-bold text-slate-950">
                    Evidence Desk
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    The matrix, citations, stats, and links sit below the fold.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 border-t-2 border-slate-900 pt-4">
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
        <div className="mt-5 rounded border border-amber-700/30 bg-amber-100 p-4 text-sm leading-relaxed text-amber-950">
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
    <article className={lead ? "" : "border-b border-slate-300 pb-4 last:border-b-0"}>
      <ImageBlock article={article} lead={lead} />
      <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-800">
        {lead ? "Lead Story" : "Article"}
      </p>
      <h3 className={`mt-1 font-serif font-black leading-none text-slate-950 ${
        lead ? "text-4xl sm:text-5xl" : "text-2xl"
      }`}>
        {article.title}
      </h3>
      <p className={`mt-3 leading-7 text-slate-700 ${compact ? "text-sm" : "text-base"}`}>
        {article.summary || article.dek}
      </p>
      <Link
        href={`/atlas/issues/${issueDate}/${article.slug}`}
        className="mt-3 inline-flex border border-slate-900 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-slate-900 hover:text-[#f8f4ea]"
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
        className={`w-full border border-slate-300 object-cover ${lead ? "h-64" : "h-32"}`}
      />
    );
  }
  return (
    <div className={`flex w-full items-center justify-center border border-slate-300 bg-slate-200 text-center text-xs uppercase tracking-wide text-slate-500 ${
      lead ? "h-64" : "h-32"
    }`}>
      {article.image.kind === "generated" ? "Editorial image prompt ready" : "Article image"}
    </div>
  );
}

function NewspaperList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="border border-slate-300 bg-white/35 p-4">
      <h3 className="font-serif text-2xl font-bold text-slate-950">{title}</h3>
      <div className="mt-3 space-y-2">
        {items.map((item, index) => (
          <p key={index} className="text-sm leading-6 text-slate-700">
            {item}
          </p>
        ))}
      </div>
    </section>
  );
}

function AtAGlance({ atlas }: { atlas: AtlasSnapshot }) {
  return (
    <aside className="vibe-panel rounded-xl p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
        At a glance
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Messages" value={atlas.overview.messages} />
        <Metric label="People" value={atlas.overview.people} />
        <Metric label="Rooms" value={atlas.overview.channels} />
        <Metric label="Themes" value={atlas.overview.topics} />
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Useful links</p>
        {atlas.links.slice(0, 4).map((link) => (
          <a
            key={link.ref}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded border border-slate-800/80 bg-slate-950/40 p-2 text-xs text-slate-300 hover:border-cyan-400/40 hover:text-slate-100"
          >
            {link.title}
          </a>
        ))}
        {atlas.links.length === 0 && (
          <p className="text-sm text-slate-400">No links in this report.</p>
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
    <div className="vibe-panel overflow-x-auto rounded-xl p-4">
      <div
        className="grid min-w-[760px] gap-1"
        style={{ gridTemplateColumns: `minmax(160px, 1.2fr) repeat(${topics.length}, minmax(86px, 1fr))` }}
      >
        <div className="px-2 py-2 text-xs font-semibold text-slate-400">Channel</div>
        {topics.map((topic) => (
          <div key={topic} className="px-2 py-2 text-xs font-semibold text-slate-300">
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
      <div className="rounded bg-slate-900/45 px-2 py-2 text-sm font-medium text-slate-100">
        {channel}
      </div>
      {topics.map((topic) => {
        const cell = atlas.matrix.find((item) => item.channel === channel && item.topic === topic);
        if (!cell) {
          return <div key={topic} className="rounded border border-slate-800/80 bg-slate-950/35" />;
        }
        const selected = selectedCellKey === cellKey(cell);
        return (
          <button
            key={topic}
            onClick={() => onSelectCell(cell)}
            className={`rounded border px-2 py-2 text-left transition ${
              selected
                ? "border-cyan-300/70 bg-cyan-400/15"
                : "border-slate-700/80 bg-slate-900/50 hover:border-cyan-400/50"
            }`}
          >
            <span className="block text-sm font-semibold text-slate-100">
              {cell.message_count}
            </span>
            <span className="block text-[11px] text-slate-400">
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
      <aside className="vibe-panel rounded-xl p-5 text-sm text-slate-400">
        Select a matrix cell to inspect its evidence.
      </aside>
    );
  }

  return (
    <aside className="vibe-panel rounded-xl p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Selected intersection</p>
      <h2 className="vibe-title mt-2 text-xl text-slate-100">{cell.topic}</h2>
      <p className="mt-1 text-sm text-slate-400">{cell.channel}</p>
      <div className="mt-4 grid gap-2 text-sm text-slate-300">
        <p>{cell.message_count} messages from {cell.people.length} people.</p>
        <p>Average relevance: {cell.avg_relevance ?? "n/a"}</p>
        <p>Latest activity: {formatTimestamp(cell.latest_timestamp)}</p>
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Citations</p>
        {cell.citation_refs.map((ref) => (
          <CitationButton key={ref} citation={atlas.citations[ref]} onOpen={() => onOpenCitation(ref)} />
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/stats" className="vibe-chip rounded px-2.5 py-1 text-xs">
          Open Stats
        </Link>
        <Link href="/links" className="vibe-chip rounded px-2.5 py-1 text-xs">
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
        <article key={channel.name} className="vibe-panel rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-100">{channel.name}</p>
          <p className="mt-1 text-xs text-slate-400">
            {channel.message_count} messages | {channel.people.length} people
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {channel.top_topics.map((topic) => (
              <span key={topic.name} className="vibe-chip rounded px-2 py-0.5 text-xs">
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
        <article key={topic.name} className="vibe-panel rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-100">{topic.name}</p>
          <p className="mt-1 text-xs text-slate-400">
            {topic.message_count} messages | {topic.channels.length} channels
          </p>
          <p className="mt-2 text-xs text-slate-500">{topic.channels.slice(0, 5).join(", ")}</p>
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
        <article key={link.ref} className="vibe-panel rounded-xl p-4">
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold">
            {link.title}
          </a>
          <p className="mt-1 text-xs text-slate-400">
            {link.category} | {link.shared_by} | {link.source_group}
          </p>
          <button
            onClick={() => onOpenCitation(link.ref)}
            className="mt-3 rounded border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-xs text-cyan-100"
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
        <h3 className="vibe-title text-lg text-slate-100">Open questions</h3>
        <div className="mt-3 space-y-3">
          {atlas.concerns.map((concern, index) => (
            <article key={`${concern.kind}-${index}`} className="vibe-panel rounded-xl p-4">
              <p className="text-sm font-semibold text-slate-100">{concern.title}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{concern.detail}</p>
              <CitationList atlas={atlas} refs={concern.citation_refs} onOpenCitation={onOpenCitation} />
            </article>
          ))}
          {atlas.concerns.length === 0 && (
            <div className="vibe-panel rounded-xl p-4 text-sm text-slate-400">
              No open questions stand out in this report.
            </div>
          )}
        </div>
      </div>
      <div>
        <h3 className="vibe-title text-lg text-slate-100">Shared links</h3>
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
      className="block w-full rounded border border-slate-700/70 bg-slate-900/45 px-3 py-2 text-left text-xs text-slate-300 hover:border-cyan-400/45 hover:text-slate-100"
    >
      <span className="block font-medium text-slate-100">{citation.label}</span>
      <span className="mt-0.5 block text-slate-500">{citation.ref}</span>
    </button>
  );
}

function EvidenceDrawer({ citation, onClose }: { citation: AtlasCitation; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="ml-auto h-full max-w-xl overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">{citation.type} citation</p>
            <h2 className="vibe-title mt-2 text-xl text-slate-100">{citation.label}</h2>
          </div>
          <button onClick={onClose} className="vibe-chip rounded px-2 py-1 text-xs">
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
          <p className="mt-5 rounded-lg border border-slate-700/70 bg-slate-900/55 p-3 text-sm leading-relaxed text-slate-200">
            {citation.body}
          </p>
        )}
        {citation.url && (
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 inline-flex rounded-md border border-cyan-400/35 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-100"
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
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-200">{value}</dd>
    </div>
  );
}

function cellKey(cell: AtlasMatrixCell): string {
  return `${cell.channel}||${cell.topic}`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
