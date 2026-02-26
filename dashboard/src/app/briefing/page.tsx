"use client";

import { useEffect, useState } from "react";
import { BriefingView } from "@/components/BriefingView";
import { StatusPanel } from "@/components/StatusPanel";

interface Report {
  report_date: string;
  briefing_json: string | null;
  contributions: string | null;
  trends: string | null;
  daily_memo: string | null;
  conversation_arcs: string | null;
}

interface EvidenceMessage {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface RecentUpdateQuote {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

interface RecentUpdateTopic {
  topic: string;
  count: number;
}

interface RecentUpdateChannel {
  name: string;
  count: number;
}

interface RecentUpdateSnapshot {
  window_start_iso: string;
  window_end_iso: string;
  window_label: string;
  next_refresh_iso: string;
  next_refresh_label: string;
  refresh_cadence: string;
  message_count: number;
  active_users: number;
  active_channels: number;
  top_topics: RecentUpdateTopic[];
  top_channels: RecentUpdateChannel[];
  quotes: RecentUpdateQuote[];
  summary: string;
}

interface VibezRadarGapQuote {
  id: string;
  timestamp: number;
  room_name: string;
  sender_name: string;
  body: string;
  relevance_score: number | null;
}

interface VibezRadarGap {
  topic: string;
  message_count: number;
  people: number;
  channels: number;
  first_seen: string;
  last_seen: string;
  avg_relevance: number | null;
  reason: string;
  sample_quote: VibezRadarGapQuote | null;
}

interface VibezRadarRedundancy {
  type: "thread_overlap" | "message_duplication";
  score_pct: number;
  title: string;
  detail: string;
}

interface VibezRadarThreadQuality {
  thread_title: string;
  evidence_messages: number;
  evidence_people: number;
  newest_evidence: string | null;
  quality: "strong" | "mixed" | "thin";
  notes: string[];
}

interface VibezRadarSnapshot {
  generated_at: string;
  window_hours: number;
  window_start_iso: string;
  coverage: {
    topic_coverage_pct: number;
    classification_coverage_pct: number;
    duplicate_pressure_pct: number;
  };
  totals: {
    messages: number;
    people: number;
    channels: number;
    briefing_threads: number;
  };
  gaps: VibezRadarGap[];
  redundancies: VibezRadarRedundancy[];
  thread_quality: VibezRadarThreadQuality[];
}

function localIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function BriefingPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [previousReport, setPreviousReport] = useState<Report | null>(null);
  const [evidenceMessages, setEvidenceMessages] = useState<EvidenceMessage[]>([]);
  const [recentUpdate, setRecentUpdate] = useState<RecentUpdateSnapshot | null>(null);
  const [radar, setRadar] = useState<VibezRadarSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      fetch("/api/briefing").then((r) => r.json()),
      fetch("/api/messages?limit=240&minRelevance=6").then((r) => r.json()),
    ])
      .then(([briefingResult, messageResult]) => {
        if (!active) return;
        if (briefingResult.status === "fulfilled") {
          const payload = briefingResult.value as {
            report: Report | null;
            previous_report: Report | null;
            recent_update: RecentUpdateSnapshot | null;
            radar: VibezRadarSnapshot | null;
          };
          setReport(payload.report || null);
          setPreviousReport(payload.previous_report || null);
          setRecentUpdate(payload.recent_update || null);
          setRadar(payload.radar || null);
        } else {
          setReport(null);
          setPreviousReport(null);
          setRecentUpdate(null);
          setRadar(null);
        }
        if (messageResult.status === "fulfilled") {
          const payload = messageResult.value as { messages?: EvidenceMessage[] };
          setEvidenceMessages(Array.isArray(payload.messages) ? payload.messages : []);
        } else {
          setEvidenceMessages([]);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setReport(null);
        setPreviousReport(null);
        setRecentUpdate(null);
        setRadar(null);
        setEvidenceMessages([]);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <StatusPanel
        loading
        title="Loading briefing"
        detail="Pulling the latest synthesis and evidence links from today's pipeline."
        steps={[
          "Loading latest daily report",
          "Ranking evidence quotes from recent messages",
          "Preparing thread-level deep dives",
        ]}
      />
    );
  }
  if (!report) {
    return (
      <StatusPanel
        title="No briefing available yet"
        detail="The daily synthesis pipeline runs automatically. This page will populate after the first successful run."
      />
    );
  }

  const isTodayReport = report.report_date === localIsoDate();

  return (
    <div className="space-y-4">
      {!isTodayReport && (
        <StatusPanel
          title="Awaiting today's run"
          detail={`Latest available briefing is from ${report.report_date}. Daily synthesis runs automatically.`}
        />
      )}
      <BriefingView
        briefing_json={report.briefing_json}
        contributions_json={report.contributions}
        trends={report.trends}
        daily_memo={report.daily_memo}
        conversation_arcs_json={report.conversation_arcs}
        previous_report_date={previousReport?.report_date || null}
        previous_daily_memo={previousReport?.daily_memo || null}
        previous_briefing_json={previousReport?.briefing_json || null}
        previous_trends={previousReport?.trends || null}
        report_date={report.report_date}
        evidence_messages={evidenceMessages}
        recent_update={recentUpdate}
        radar={radar}
      />
    </div>
  );
}
