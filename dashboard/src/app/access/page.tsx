"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

function normalizeNextPath(raw: string | null): string {
  const value = (raw || "").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

export default function AccessPage() {
  const router = useRouter();
  const nextPath =
    typeof window !== "undefined"
      ? normalizeNextPath(new URLSearchParams(window.location.search).get("next"))
      : "/";

  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || "Access denied.");
        setSubmitting(false);
        return;
      }
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("Could not verify access code.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <section className="vibe-panel rounded-xl p-6">
        <h1 className="vibe-title text-2xl text-slate-100">Access Required</h1>
        <p className="mt-2 text-sm text-slate-300">
          Enter the access code to open this shared Vibez deployment.
        </p>
        <form className="mt-5 space-y-3" onSubmit={onSubmit}>
          <label className="block text-sm text-slate-300">
            Access code
            <input
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="vibe-input mt-1 w-full rounded-md px-3 py-2 text-sm text-slate-100"
              autoFocus
              autoComplete="current-password"
              placeholder="Enter code"
            />
          </label>
          {error ? <p className="text-xs text-rose-300">{error}</p> : null}
          <button
            type="submit"
            className="vibe-button rounded-md px-4 py-2 text-sm"
            disabled={submitting}
          >
            {submitting ? "Checking..." : "Enter"}
          </button>
        </form>
      </section>
    </div>
  );
}
