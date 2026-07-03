"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export interface LinkStarState {
  count: number;
  starred: boolean;
}

const CLIENT_ID_KEY = "vibez-link-star-client-v1";

function getClientId(): string {
  if (typeof window === "undefined") return "";
  const existing = localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const next =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

export function useLinkStars(urls: string[]) {
  const [stars, setStars] = useState<Record<string, LinkStarState>>({});
  const urlKey = useMemo(
    () => Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean))).sort().join("\n"),
    [urls],
  );

  const refresh = useCallback(async () => {
    if (!urlKey) {
      return;
    }
    const currentClientId = getClientId();
    const uniqueUrls = urlKey.split("\n").filter(Boolean);
    const res = await fetch("/api/stars/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: uniqueUrls, clientId: currentClientId }),
    });
    const data = await res.json();
    setStars(data.links || {});
  }, [urlKey]);

  useEffect(() => {
    if (!urlKey) return;
    let cancelled = false;
    void (async () => {
      const currentClientId = getClientId();
      const uniqueUrls = urlKey.split("\n").filter(Boolean);
      const res = await fetch("/api/stars/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: uniqueUrls, clientId: currentClientId }),
      });
      const data = await res.json();
      if (!cancelled) setStars(data.links || {});
    })();
    return () => {
      cancelled = true;
    };
  }, [urlKey]);

  const toggleLinkStar = useCallback(
    async (url: string) => {
      const currentClientId = getClientId();
      const current = stars[url] || { count: 0, starred: false };
      const nextStarred = !current.starred;
      setStars((prev) => ({
        ...prev,
        [url]: {
          count: Math.max(0, (prev[url]?.count || 0) + (nextStarred ? 1 : -1)),
          starred: nextStarred,
        },
      }));
      const res = await fetch("/api/stars/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, clientId: currentClientId, starred: nextStarred }),
      });
      const data = await res.json();
      setStars((prev) => ({
        ...prev,
        [url]: { count: Number(data.count || 0), starred: Boolean(data.starred) },
      }));
    },
    [stars],
  );

  return {
    stars,
    isLinkStarred: (url: string) => Boolean(stars[url]?.starred),
    linkStarCount: (url: string) => Number(stars[url]?.count || 0),
    toggleLinkStar,
    refresh,
  };
}
