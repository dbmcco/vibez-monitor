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
}

type Lens = "matrix" | "channels" | "topics" | "concerns" | "links";

const LENSES: Array<{ key: Lens; label: string }> = [
  { key: "matrix", label: "Matrix" },
  { key: "channels", label: "Channels" },
  { key: "topics", label: "Topics" },
  { key: "concerns", label: "Concerns" },
  { key: "links", label: "Links" },
];

export default function AtlasPage() {
  const [atlas, setAtlas] = useState<AtlasSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>("matrix");
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [selectedCitationRef, setSelectedCitationRef] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/atlas?hours=48")
      .then((response) => response.json())
      .then((payload: { atlas: AtlasSnapshot | null }) => {
        if (!active) return;
        setAtlas(payload.atlas);
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
  }, []);

  const selectedCell = useMemo(() => {
    if (!atlas || !selectedCellKey) return atlas?.matrix[0] || null;
    return atlas.matrix.find((cell) => cellKey(cell) === selectedCellKey) || atlas.matrix[0] || null;
  }, [atlas, selectedCellKey]);

  const selectedCitation =
    atlas && selectedCitationRef ? atlas.citations[selectedCitationRef] || null : null;

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

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Messages" value={atlas.overview.messages} />
        <Metric label="People" value={atlas.overview.people} />
        <Metric label="Channels" value={atlas.overview.channels} />
        <Metric label="Topics" value={atlas.overview.topics} />
        <Metric label="Links" value={atlas.overview.links} />
      </section>

      <section className="vibe-panel rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="vibe-title text-lg text-slate-100">Latest 48h Report</h2>
            <p className="mt-1 text-sm text-slate-400">
              Channels x topics x citations, generated {formatDate(atlas.generated_at)}.
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
          {lens === "matrix" && (
            <Matrix
              atlas={atlas}
              channels={matrixChannels}
              topics={matrixTopics}
              selectedCellKey={selectedCell ? cellKey(selectedCell) : null}
              onSelectCell={(cell) => setSelectedCellKey(cellKey(cell))}
            />
          )}
          {lens === "channels" && <ChannelLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "topics" && <TopicLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "concerns" && <ConcernLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
          {lens === "links" && <LinkLens atlas={atlas} onOpenCitation={setSelectedCitationRef} />}
        </div>

        <DetailRail
          atlas={atlas}
          cell={selectedCell}
          onOpenCitation={setSelectedCitationRef}
        />
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
        Atlas
      </p>
      <h1 className="vibe-title text-2xl text-slate-100 sm:text-3xl">
        What moved across Vibez
      </h1>
      <p className="vibe-subtitle max-w-3xl">
        A 48-hour map across channels, topics, evidence, and shared artifacts.
      </p>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="vibe-panel rounded-xl p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="vibe-title mt-1 text-2xl text-slate-100">{value.toLocaleString()}</div>
    </div>
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
                {topic.name} · {topic.count}
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

function ConcernLens({ atlas, onOpenCitation }: { atlas: AtlasSnapshot; onOpenCitation: (ref: string) => void }) {
  return (
    <div className="space-y-3">
      {atlas.concerns.map((concern, index) => (
        <article key={`${concern.kind}-${index}`} className="vibe-panel rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-100">{concern.title}</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">{concern.detail}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-slate-500">{concern.kind.replace("_", " ")}</p>
          <CitationList atlas={atlas} refs={concern.citation_refs} onOpenCitation={onOpenCitation} />
        </article>
      ))}
      {atlas.concerns.length === 0 && (
        <div className="vibe-panel rounded-xl p-4 text-sm text-slate-400">
          No diagnostic concerns in this window.
        </div>
      )}
    </div>
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
