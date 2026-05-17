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

interface AtlasPeopleInsights {
  window_days: 7;
  generated_at: string;
  new_faces: Array<{
    name: string;
    sender_id: string | null;
    first_seen: string;
    first_seen_ts: number;
    first_channel: string;
    message_count_7d: number;
    channels: string[];
    intro_refs: string[];
    detection_reasons: Array<"first_seen" | "intros_channel" | "member_event" | "phone_or_name_addition">;
  }>;
  top_contributors: Array<{
    name: string;
    sender_id: string | null;
    message_count_7d: number;
    active_days_7d: number;
    channels: string[];
    latest_seen: string;
    latest_seen_ts: number;
    citation_refs: string[];
  }>;
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
  people: AtlasPeopleInsights;
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
    setSelectedCitationRef(null);
    setWindowHours(hours);
  }

  if (loading) {
    return (
      <div>
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
      <div>
        <div className="rounded-xl border border-[#cbbf9d] bg-[#f4ead7] p-5 text-sm text-[#342a1b]">
          {error || "Atlas data is unavailable right now."}
        </div>
      </div>
    );
  }

  const matrixTopics = atlas.topics.slice(0, 8).map((topic) => topic.name);
  const matrixChannels = atlas.channels.slice(0, 12).map((channel) => channel.name);

  return (
    <div className="atlas-newspaper fade-up -m-2 space-y-6 rounded-xl border border-[#cbbf9d] bg-[#efe3cc] p-3 text-[#1f1a12] shadow-[0_22px_80px_rgba(18,14,8,0.26)] sm:-m-4 sm:p-5">
      <NarrativeReport
        atlas={atlas}
        editorialReport={editorialReport}
        windowHours={windowHours}
        onWindowHoursChange={handleWindowHoursChange}
        onOpenCitation={setSelectedCitationRef}
      />

      <PeopleDesk atlas={atlas} onOpenCitation={setSelectedCitationRef} />

      <section className="rounded border border-[#cbbf9d] bg-[#f7edd9] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-bold text-[#1f1a12]">Below the Fold</h2>
            <p className="mt-1 text-sm text-[#5e5238]">
              The front page explains the story. This section shows value, evidence, rooms, links,
              and the raw diagnostic map.
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

      <ValueAssessment report={editorialReport} atlas={atlas} />

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
  windowHours,
  onWindowHoursChange,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  editorialReport: AtlasEditorialReport | null;
  windowHours: number;
  onWindowHoursChange: (hours: number) => void;
  onOpenCitation: (ref: string) => void;
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
            wireSubtitle(atlas)}
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
          <div className="mt-6 grid gap-5 min-[1500px]:grid-cols-[0.9fr_1.35fr_0.9fr]">
            <div className="space-y-5 min-[1500px]:border-r min-[1500px]:border-[#cbbf9d] min-[1500px]:pr-5">
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
            <div className="space-y-5 min-[1500px]:border-l min-[1500px]:border-[#cbbf9d] min-[1500px]:pl-5">
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
            <div className="mt-6 grid gap-4 border-t border-[#cbbf9d] pt-4 min-[1500px]:grid-cols-2">
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
        <WireDeskFrontPage atlas={atlas} onOpenCitation={onOpenCitation} />
      )}
    </section>
  );
}

function WireDeskFrontPage({
  atlas,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  onOpenCitation: (ref: string) => void;
}) {
  const topTopic = atlas.topics[0] || null;
  const topChannel = atlas.channels[0] || null;
  const topCell = atlas.matrix[0] || null;
  const primaryRefs =
    topCell?.citation_refs.length
      ? topCell.citation_refs
      : topTopic?.citation_refs.length
      ? topTopic.citation_refs
      : topChannel?.citation_refs || [];
  const stories = buildWireStories(atlas, primaryRefs);
  const leftStory = stories.secondary[0] || null;
  const rightStory = stories.secondary[1] || null;
  const belowStories = stories.secondary.slice(2);

  return (
    <div className="mt-6 space-y-5">
      <div className="grid gap-5 min-[1500px]:grid-cols-[0.9fr_1.35fr_0.9fr]">
        <div className="space-y-4 min-[1500px]:border-r min-[1500px]:border-[#cbbf9d] min-[1500px]:pr-5">
          {leftStory ? (
            <WireStoryCard story={leftStory} atlas={atlas} onOpenCitation={onOpenCitation} compact />
          ) : (
            <WireList
              title="Leading Themes"
              items={atlas.topics.slice(0, 4).map((topic) =>
                `${topic.name}: ${topic.message_count.toLocaleString()} messages across ${topic.channels.length.toLocaleString()} rooms`,
              )}
            />
          )}
        </div>

        <article className="border-y-2 border-[#1f1a12] py-4 min-[1500px]:border-y-0 min-[1500px]:py-0">
          <WireStoryCard story={stories.lead} atlas={atlas} onOpenCitation={onOpenCitation} lead />
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Metric label="Themes" value={atlas.overview.topics} />
            <Metric label="Links" value={atlas.overview.links} />
            <Metric label="Intersections" value={atlas.matrix.length} />
          </div>
          <div className="mt-5 border-t border-[#cbbf9d] pt-4">
            <h4 className="font-serif text-2xl font-bold text-[#1f1a12]">Start Here</h4>
            <p className="mt-2 text-sm leading-6 text-[#5e5238]">
              {topTopic ? `Top theme: ${topTopic.name}. ` : "No top theme is available. "}
              {topChannel ? `Busiest room: ${topChannel.name}. ` : "No busiest room is available. "}
              {topCell
                ? `Strongest intersection: ${topCell.channel} / ${topCell.topic}.`
                : "No channel-theme intersection is available."}
            </p>
            <CitationList
              atlas={atlas}
              refs={primaryRefs.slice(0, 3)}
              onOpenCitation={onOpenCitation}
            />
          </div>
        </article>

        <div className="space-y-4 min-[1500px]:border-l min-[1500px]:border-[#cbbf9d] min-[1500px]:pl-5">
          {rightStory ? (
            <WireStoryCard story={rightStory} atlas={atlas} onOpenCitation={onOpenCitation} compact />
          ) : (
            <p className="text-sm leading-6 text-[#5e5238]">
              No open-question signals stand out in this window.
            </p>
          )}
        </div>
      </div>

      {belowStories.length > 0 && (
        <div className="grid gap-4 border-t border-[#cbbf9d] pt-4 min-[1500px]:grid-cols-2">
          {belowStories.map((story) => (
            <WireStoryCard
              key={`${story.section}-${story.title}`}
              story={story}
              atlas={atlas}
              onOpenCitation={onOpenCitation}
              compact
            />
          ))}
        </div>
      )}

      <div className="grid gap-4 border-t-2 border-[#1f1a12] pt-4 lg:grid-cols-2">
        <WireList
          title="Most Active Rooms"
          items={atlas.channels.slice(0, 5).map((channel) =>
            `${channel.name}: ${channel.message_count.toLocaleString()} messages, ${channel.people.length.toLocaleString()} community members`,
          )}
        />
        <WireList
          title="Shared Links"
          items={atlas.links.slice(0, 5).map((link) =>
            `${link.title} | ${link.source_group || "source room unavailable"}`,
          )}
        />
      </div>
    </div>
  );
}

interface WireStory {
  section: string;
  title: string;
  dek: string;
  paragraphs: string[];
  citation_refs: string[];
}

function buildWireStories(atlas: AtlasSnapshot, primaryRefs: string[]): {
  lead: WireStory;
  secondary: WireStory[];
} {
  const lead: WireStory = {
    section: "Lead Story",
    title: atlas.narrative.main_topic.title || atlas.narrative.report.headline,
    dek: atlas.narrative.report.lead || atlas.narrative.summary,
    paragraphs: atlas.narrative.main_topic.paragraphs.length
      ? atlas.narrative.main_topic.paragraphs
      : atlas.narrative.paragraphs,
    citation_refs: atlas.narrative.main_topic.citation_refs.length
      ? atlas.narrative.main_topic.citation_refs
      : primaryRefs,
  };

  const topicStories = atlas.topics.slice(1, 4).map((topic): WireStory => ({
    section: "Theme Watch",
    title: topic.name,
    dek: `${topic.message_count.toLocaleString()} messages across ${topic.channels.length.toLocaleString()} rooms.`,
    paragraphs: [
      `${topic.name} is one of the visible stories in this edition because it appears across ${topic.channels.length.toLocaleString()} rooms.`,
      topic.channels.length
        ? `The first rooms to read are ${topic.channels.slice(0, 4).join(", ")}.`
        : "The room map is thin, so the citations matter more than the label.",
      topic.people.length
        ? `${topic.people.slice(0, 5).join(", ")} appear in the available evidence.`
        : "The current evidence does not show a broad contributor list yet.",
    ],
    citation_refs: topic.citation_refs,
  }));

  const concernStories = atlas.concerns.slice(0, 2).map((concern): WireStory => ({
    section: concern.kind === "hot_alert" ? "Concern" : "Open Question",
    title: concern.title,
    dek: concern.detail,
    paragraphs: [
      concern.detail,
      "This belongs on the front page because it points to a place where the group may need more evidence, a decision, or a follow-up owner.",
      "Read the citations before treating the signal as settled.",
    ],
    citation_refs: concern.citation_refs,
  }));

  const linkStories = atlas.links.slice(0, 1).map((link): WireStory => ({
    section: "Links",
    title: link.title,
    dek: `${link.shared_by || "A community member"} shared this in ${link.source_group || "the group"}.`,
    paragraphs: [
      link.title,
      link.category ? `Atlas classified the link as ${link.category}.` : "Atlas captured this as follow-up material.",
      "Use it as supporting material, not as a substitute for the conversation around it.",
    ],
    citation_refs: [link.ref],
  }));

  return {
    lead,
    secondary: [...topicStories, ...concernStories, ...linkStories],
  };
}

function WireStoryCard({
  story,
  atlas,
  onOpenCitation,
  lead = false,
  compact = false,
}: {
  story: WireStory;
  atlas: AtlasSnapshot;
  onOpenCitation: (ref: string) => void;
  lead?: boolean;
  compact?: boolean;
}) {
  const paragraphs = lead ? story.paragraphs.slice(0, 5) : story.paragraphs.slice(0, 3);
  return (
    <article className={lead ? "" : "border-b border-[#cbbf9d] pb-4 last:border-b-0"}>
      <WireSectionLabel>{story.section}</WireSectionLabel>
      <h3 className={`mt-2 font-serif font-black leading-none text-[#1f1a12] ${
        lead ? "text-3xl sm:text-5xl" : "text-2xl"
      }`}>
        {story.title}
      </h3>
      <p className={`mt-3 leading-7 text-[#5e5238] ${compact ? "text-sm" : "text-base"}`}>
        {story.dek}
      </p>
      <div className="mt-3 space-y-3">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className={`leading-7 text-[#342a1b] ${compact ? "text-sm" : "text-base"}`}>
            {paragraph}
          </p>
        ))}
      </div>
      <CitationList
        atlas={atlas}
        refs={story.citation_refs.slice(0, lead ? 4 : 2)}
        onOpenCitation={onOpenCitation}
      />
    </article>
  );
}

function wireSubtitle(atlas: AtlasSnapshot): string {
  return `A sourced front page for ${atlas.window.hours} hours of activity: ${atlas.overview.messages.toLocaleString()} messages, ${atlas.overview.people.toLocaleString()} community members, ${atlas.overview.channels.toLocaleString()} rooms, and ${atlas.overview.links.toLocaleString()} shared links.`;
}

function WireSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#8b5f21]">
      {children}
    </p>
  );
}

function WireList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4">
      <h3 className="font-serif text-xl font-bold text-[#1f1a12]">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-[#5e5238]">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
        {items.length === 0 && <li>No records in this window.</li>}
      </ul>
    </div>
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
        lead ? "text-3xl sm:text-4xl" : "text-2xl"
      }`}>
        {article.title}
      </h3>
      <p className={`mt-3 leading-7 text-[#5e5238] ${compact ? "text-sm" : "text-base"}`}>
        {article.summary || article.dek}
      </p>
      <Link
        href={`/atlas/issues/${issueDate}/${article.slug}`}
        className="mt-3 inline-flex border border-[#1f1a12] px-3 py-1.5 text-sm font-semibold !text-[#1f1a12] hover:bg-[#1f1a12] hover:!text-[#f8f4ea]"
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
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={editorialImageDataUri(article, lead)}
      alt={article.image.alt || `Editorial image for ${article.title}`}
      className={`w-full border border-[#cbbf9d] object-fill ${lead ? "h-64" : "h-32"}`}
    />
  );
}

function editorialImageDataUri(article: AtlasEditorialArticle, lead: boolean): string {
  const width = lead ? 960 : 640;
  const height = lead ? 420 : 260;
  const section = escapeSvgText(article.section.toUpperCase());
  const accent = lead ? "#8b5f21" : "#5e5238";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#e8dcc4"/>
      <rect x="18" y="18" width="${width - 36}" height="${height - 36}" fill="#f7edd9" stroke="#1f1a12" stroke-width="3"/>
      <path d="M44 ${height - 82} C ${width * 0.24} ${height - 180}, ${width * 0.44} ${height - 20}, ${width * 0.62} ${height - 116} S ${width - 90} ${height - 72}, ${width - 38} ${height - 160}" fill="none" stroke="${accent}" stroke-width="18" opacity="0.38"/>
      <circle cx="${width - 118}" cy="92" r="${lead ? 52 : 34}" fill="${accent}" opacity="0.2"/>
      <line x1="44" y1="52" x2="${width - 44}" y2="52" stroke="#1f1a12" stroke-width="2"/>
      <line x1="44" y1="${height - 44}" x2="${width - 44}" y2="${height - 44}" stroke="#1f1a12" stroke-width="2"/>
      <text x="54" y="92" font-family="Georgia, serif" font-size="${lead ? 26 : 18}" font-weight="700" fill="${accent}" letter-spacing="3">${section}</text>
      <text x="54" y="${lead ? 154 : 128}" font-family="Georgia, serif" font-size="${lead ? 34 : 24}" font-weight="900" fill="#1f1a12">Editorial image brief</text>
      <text x="54" y="${lead ? 202 : 166}" font-family="Arial, sans-serif" font-size="${lead ? 16 : 12}" fill="#786846">${escapeSvgText((article.image.prompt || article.dek).slice(0, lead ? 92 : 58))}</text>
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

function PeopleDesk({
  atlas,
  onOpenCitation,
}: {
  atlas: AtlasSnapshot;
  onOpenCitation: (ref: string) => void;
}) {
  const newFaces = atlas.people?.new_faces || [];
  const topContributors = atlas.people?.top_contributors || [];
  return (
    <section className="rounded-xl border border-[#cbbf9d] bg-[#f7edd9] p-4 text-[#1f1a12]">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#cbbf9d] pb-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#8b5f21]">
            Society Desk
          </p>
          <h2 className="mt-1 font-serif text-2xl font-black">New Faces This Week</h2>
        </div>
        <p className="max-w-xl text-sm leading-6 text-[#5e5238]">
          A rolling seven-day read on who newly appeared, where they surfaced, and who carried the
          conversation.
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.2fr_0.9fr]">
        <div className="grid gap-3 sm:grid-cols-2">
          {newFaces.length > 0 ? (
            newFaces.slice(0, 6).map((person) => (
              <article key={`${person.name}-${person.first_seen_ts}`} className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#8b5f21]">
                  <span>{person.first_channel}</span>
                  {person.detection_reasons.slice(0, 2).map((reason) => (
                    <span key={reason} className="text-[#786846]">
                      {personReasonLabel(reason)}
                    </span>
                  ))}
                </div>
                <h3 className="mt-2 font-serif text-xl font-bold text-[#1f1a12]">
                  {person.name}
                </h3>
                <p className="mt-2 text-sm leading-6 text-[#5e5238]">
                  First seen {formatTimestamp(person.first_seen_ts)}. Posted{" "}
                  {person.message_count_7d.toLocaleString()} time
                  {person.message_count_7d === 1 ? "" : "s"} across{" "}
                  {person.channels.slice(0, 3).join(", ") || "tracked channels"}.
                </p>
                {person.intro_refs[0] && (
                  <button
                    onClick={() => onOpenCitation(person.intro_refs[0])}
                    className="mt-3 border border-[#1f1a12] px-3 py-1.5 text-sm font-semibold text-[#1f1a12] hover:bg-[#1f1a12] hover:text-[#f8f4ea]"
                  >
                    Open intro evidence
                  </button>
                )}
              </article>
            ))
          ) : (
            <div className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4 text-sm leading-6 text-[#5e5238] sm:col-span-2">
              No new-face signals in the rolling seven-day window. The directory and contributor
              list still show who was active.
            </div>
          )}
        </div>

        <aside className="border border-[#cbbf9d] bg-[#fffaf0]/45 p-4">
          <h3 className="font-serif text-xl font-bold text-[#1f1a12]">Top Contributors</h3>
          {newFaces.length > 6 && (
            <p className="mt-1 text-xs leading-5 text-[#786846]">
              Showing 6 of {newFaces.length.toLocaleString()} new-face signals.
            </p>
          )}
          <div className="mt-3 space-y-3">
            {topContributors.slice(0, 8).map((person, index) => (
              <div key={`${person.name}-${person.latest_seen_ts}`} className="border-b border-[#d8cba9] pb-3 last:border-b-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-semibold text-[#1f1a12]">
                    {index + 1}. {person.name}
                  </p>
                  <p className="text-xs text-[#786846]">{person.message_count_7d} msgs</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-[#5e5238]">
                  {person.active_days_7d} active day{person.active_days_7d === 1 ? "" : "s"} ·{" "}
                  {person.channels.slice(0, 3).join(", ") || "tracked channels"}
                </p>
                {person.citation_refs[0] && (
                  <button
                    onClick={() => onOpenCitation(person.citation_refs[0])}
                    className="mt-2 text-xs font-semibold text-[#8b5f21] underline decoration-[#cbbf9d] underline-offset-4 hover:text-[#1f1a12]"
                  >
                    Open recent evidence
                  </button>
                )}
              </div>
            ))}
            {topContributors.length === 0 && (
              <p className="text-sm text-[#786846]">No contributor activity in the seven-day window.</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function ValueAssessment({
  report,
  atlas,
}: {
  report: AtlasEditorialReport | null;
  atlas: AtlasSnapshot;
}) {
  const valueItems = report?.valuable.length ? report.valuable : atlas.narrative.report.what_matters;
  const actionItems = report?.actions.length ? report.actions : atlas.narrative.report.what_to_watch;
  const themeItems = report?.themes.length
    ? report.themes.slice(0, 3).map((theme) => `${theme.title}: ${theme.analysis}`)
    : atlas.topics.slice(0, 3).map((topic) => `${topic.name}: ${topic.message_count} messages across ${topic.channels.length} rooms.`);

  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <AssessmentColumn title="What is valuable here" items={valueItems} />
      <AssessmentColumn title="What needs action" items={actionItems} />
      <AssessmentColumn title="Themes to watch" items={themeItems} />
    </section>
  );
}

function AssessmentColumn({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded border border-[#cbbf9d] bg-[#f8f4ea] p-4">
      <h3 className="font-serif text-xl font-bold text-[#1f1a12]">{title}</h3>
      <div className="mt-3 space-y-3">
        {items.slice(0, 4).map((item, index) => (
          <p key={index} className="border-t border-[#d8cba9] pt-2 text-sm leading-6 text-[#5e5238] first:border-t-0 first:pt-0">
            {item}
          </p>
        ))}
        {items.length === 0 && (
          <p className="text-sm leading-6 text-[#786846]">No clear signal in this window.</p>
        )}
      </div>
    </section>
  );
}

function personReasonLabel(reason: AtlasPeopleInsights["new_faces"][number]["detection_reasons"][number]): string {
  switch (reason) {
    case "first_seen":
      return "new";
    case "intros_channel":
      return "intro";
    case "member_event":
      return "joined";
    case "phone_or_name_addition":
      return "identity";
    default:
      return reason;
  }
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
