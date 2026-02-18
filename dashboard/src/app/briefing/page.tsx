"use client";

import { useEffect, useState } from "react";
import { BriefingView } from "@/components/BriefingView";

interface Report {
  report_date: string;
  briefing_json: string | null;
  trends: string | null;
}

export default function BriefingPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/briefing")
      .then((r) => r.json())
      .then((data) => { setReport(data.report); setLoading(false); });
  }, []);

  if (loading) return <div className="text-zinc-500">Loading...</div>;
  if (!report) return <div className="text-zinc-500">No briefings yet. Run the synthesis agent to generate one.</div>;

  return <BriefingView briefing_json={report.briefing_json} trends={report.trends} report_date={report.report_date} />;
}
