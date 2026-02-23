"use client";

import { useEffect, useState } from "react";
import { BriefingView } from "@/components/BriefingView";
import { StatusPanel } from "@/components/StatusPanel";

interface Report {
  report_date: string;
  briefing_json: string | null;
  contributions: string | null;
  trends: string | null;
}

interface EvidenceMessage {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
}

function localIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function HomePage() {
  const [report, setReport] = useState<Report | null>(null);
  const [evidenceMessages, setEvidenceMessages] = useState<EvidenceMessage[]>([]);
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
          setReport((briefingResult.value as { report: Report | null }).report || null);
        } else {
          setReport(null);
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
        detail="Pulling the latest synthesis from the daily pipeline."
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
        report_date={report.report_date}
        evidence_messages={evidenceMessages}
      />
    </div>
  );
}
