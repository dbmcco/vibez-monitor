"use client";

import { useEffect, useState } from "react";

export interface StarState {
  wisdomTopics: Record<string, true>;
  links: Record<string, true>;
}

const STORAGE_KEY = "vibez-stars-v1";
const CHANGE_EVENT = "vibez:stars-changed";

function normalizeStarMap(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, enabled]) => key.trim().length > 0 && Boolean(enabled))
      .map(([key]) => [key, true]),
  );
}

function emptyStars(): StarState {
  return { wisdomTopics: {}, links: {} };
}

export function loadStars(): StarState {
  if (typeof window === "undefined") return emptyStars();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyStars();
    const parsed = JSON.parse(raw) as Partial<StarState>;
    return {
      wisdomTopics: normalizeStarMap(parsed.wisdomTopics),
      links: normalizeStarMap(parsed.links),
    };
  } catch {
    return emptyStars();
  }
}

function saveStars(state: StarState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Ignore storage failures and keep the in-memory state usable.
  }
}

function toggleRecordValue(record: Record<string, true>, key: string): Record<string, true> {
  if (!key.trim()) return record;
  const next = { ...record };
  if (next[key]) {
    delete next[key];
  } else {
    next[key] = true;
  }
  return next;
}

export function linkStarKey(url: string): string {
  return url.trim();
}

export function useStars() {
  const [stars, setStars] = useState<StarState>(() => emptyStars());

  useEffect(() => {
    function syncStars() {
      setStars(loadStars());
    }

    syncStars();
    if (typeof window === "undefined") return undefined;

    window.addEventListener("storage", syncStars);
    window.addEventListener(CHANGE_EVENT, syncStars);
    return () => {
      window.removeEventListener("storage", syncStars);
      window.removeEventListener(CHANGE_EVENT, syncStars);
    };
  }, []);

  function updateStars(next: StarState) {
    saveStars(next);
    setStars(next);
  }

  function toggleWisdomTopicStar(slug: string) {
    const key = slug.trim();
    if (!key) return;
    const current = loadStars();
    updateStars({
      ...current,
      wisdomTopics: toggleRecordValue(current.wisdomTopics, key),
    });
  }

  function toggleLinkStar(url: string) {
    const key = linkStarKey(url);
    if (!key) return;
    const current = loadStars();
    updateStars({
      ...current,
      links: toggleRecordValue(current.links, key),
    });
  }

  function isWisdomTopicStarred(slug: string): boolean {
    return Boolean(stars.wisdomTopics[slug]);
  }

  function isLinkStarred(url: string): boolean {
    return Boolean(stars.links[linkStarKey(url)]);
  }

  return {
    stars,
    isWisdomTopicStarred,
    isLinkStarred,
    toggleWisdomTopicStar,
    toggleLinkStar,
  };
}
