export interface AtlasMessageRow {
  id: string;
  room_name: string;
  sender_name: string;
  body: string;
  timestamp: number;
  relevance_score: number | null;
  topics: string | null;
  alert_level: string | null;
}

export interface AtlasLinkRow {
  id: number | string;
  url: string;
  title: string | null;
  category: string | null;
  relevance: string | null;
  shared_by: string | null;
  source_group: string | null;
  last_seen: string | null;
  value_score: number | null;
}

export interface AtlasCitation {
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

export interface AtlasMatrixCell {
  channel: string;
  topic: string;
  message_count: number;
  people: string[];
  latest_timestamp: number;
  avg_relevance: number | null;
  citation_refs: string[];
}

export interface AtlasChannelSummary {
  name: string;
  message_count: number;
  people: string[];
  top_topics: Array<{ name: string; count: number }>;
  citation_refs: string[];
}

export interface AtlasTopicSummary {
  name: string;
  message_count: number;
  channels: string[];
  people: string[];
  citation_refs: string[];
}

export interface AtlasConcern {
  kind: "hot_alert" | "unresolved_question" | "under_covered";
  title: string;
  detail: string;
  citation_refs: string[];
}

export interface AtlasLinkSummary {
  ref: string;
  url: string;
  title: string;
  category: string;
  shared_by: string;
  source_group: string;
  last_seen: string | null;
}

export interface AtlasSnapshot {
  generated_at: string;
  window: {
    start: string;
    end: string;
    hours: number;
  };
  overview: {
    messages: number;
    people: number;
    channels: number;
    topics: number;
    links: number;
  };
  channels: AtlasChannelSummary[];
  topics: AtlasTopicSummary[];
  matrix: AtlasMatrixCell[];
  concerns: AtlasConcern[];
  links: AtlasLinkSummary[];
  citations: Record<string, AtlasCitation>;
}

export function buildAtlasSnapshotFromRows(input: {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  messages: AtlasMessageRow[];
  links: AtlasLinkRow[];
}): AtlasSnapshot {
  const citations: Record<string, AtlasCitation> = {};
  const people = new Set<string>();
  const channelAcc = new Map<string, {
    count: number;
    people: Set<string>;
    topics: Map<string, number>;
    citations: string[];
  }>();
  const topicAcc = new Map<string, {
    count: number;
    channels: Set<string>;
    people: Set<string>;
    citations: string[];
  }>();
  const cellAcc = new Map<string, {
    channel: string;
    topic: string;
    count: number;
    people: Set<string>;
    latest: number;
    relevanceTotal: number;
    relevanceCount: number;
    citations: string[];
  }>();
  const concerns: AtlasConcern[] = [];
  let underCovered = 0;

  for (const row of input.messages) {
    const sender = row.sender_name || "Unknown";
    const channel = row.room_name || "Unknown";
    const topics = parseTopics(row.topics);
    const citationRef = messageRef(row.id);
    people.add(sender);
    citations[citationRef] = {
      ref: citationRef,
      type: "message",
      id: row.id,
      label: `${sender} in ${channel}`,
      channel,
      sender,
      timestamp: row.timestamp,
      body: row.body,
      topics,
      relevance_score: row.relevance_score,
    };

    const channelEntry = channelAcc.get(channel) || {
      count: 0,
      people: new Set<string>(),
      topics: new Map<string, number>(),
      citations: [],
    };
    channelEntry.count += 1;
    channelEntry.people.add(sender);
    pushUnique(channelEntry.citations, citationRef, 4);
    channelAcc.set(channel, channelEntry);

    if (topics.length === 0) {
      underCovered += 1;
    }

    if (row.alert_level === "hot") {
      concerns.push({
        kind: "hot_alert",
        title: `Hot signal in ${channel}`,
        detail: excerpt(row.body, 150),
        citation_refs: [citationRef],
      });
    }

    if (row.body.includes("?") || /\b(worried|concern|risk|blocked|stuck)\b/i.test(row.body)) {
      concerns.push({
        kind: "unresolved_question",
        title: `Open tension in ${channel}`,
        detail: excerpt(row.body, 150),
        citation_refs: [citationRef],
      });
    }

    for (const topic of topics) {
      channelEntry.topics.set(topic, (channelEntry.topics.get(topic) || 0) + 1);

      const topicEntry = topicAcc.get(topic) || {
        count: 0,
        channels: new Set<string>(),
        people: new Set<string>(),
        citations: [],
      };
      topicEntry.count += 1;
      topicEntry.channels.add(channel);
      topicEntry.people.add(sender);
      pushUnique(topicEntry.citations, citationRef, 4);
      topicAcc.set(topic, topicEntry);

      const cellKey = `${channel}||${topic}`;
      const cellEntry = cellAcc.get(cellKey) || {
        channel,
        topic,
        count: 0,
        people: new Set<string>(),
        latest: row.timestamp,
        relevanceTotal: 0,
        relevanceCount: 0,
        citations: [],
      };
      cellEntry.count += 1;
      cellEntry.people.add(sender);
      cellEntry.latest = Math.max(cellEntry.latest, row.timestamp);
      if (row.relevance_score !== null && row.relevance_score !== undefined) {
        cellEntry.relevanceTotal += row.relevance_score;
        cellEntry.relevanceCount += 1;
      }
      pushUnique(cellEntry.citations, citationRef, 4);
      cellAcc.set(cellKey, cellEntry);
    }
  }

  if (underCovered > 0) {
    concerns.push({
      kind: "under_covered",
      title: "Messages without topic coverage",
      detail: `${underCovered} messages in this window do not have topic tags yet.`,
      citation_refs: [],
    });
  }

  const linkSummaries = input.links.slice(0, 12).map((link) => {
    const ref = linkRef(link.id);
    const title = link.title || host(link.url) || link.url;
    citations[ref] = {
      ref,
      type: "link",
      id: String(link.id),
      label: title,
      url: link.url,
      title,
      channel: link.source_group || undefined,
      sender: link.shared_by || undefined,
    };
    return {
      ref,
      url: link.url,
      title,
      category: link.category || "link",
      shared_by: link.shared_by || "Unknown",
      source_group: link.source_group || "Unknown",
      last_seen: link.last_seen,
    };
  });

  const channels = Array.from(channelAcc.entries())
    .map(([name, acc]) => ({
      name,
      message_count: acc.count,
      people: Array.from(acc.people).sort(),
      top_topics: topEntries(acc.topics, 5),
      citation_refs: acc.citations,
    }))
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 20);

  const topics = Array.from(topicAcc.entries())
    .map(([name, acc]) => ({
      name,
      message_count: acc.count,
      channels: Array.from(acc.channels).sort(),
      people: Array.from(acc.people).sort(),
      citation_refs: acc.citations,
    }))
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 20);

  const matrix = Array.from(cellAcc.values())
    .map((cell) => ({
      channel: cell.channel,
      topic: cell.topic,
      message_count: cell.count,
      people: Array.from(cell.people).sort(),
      latest_timestamp: cell.latest,
      avg_relevance:
        cell.relevanceCount > 0
          ? Number((cell.relevanceTotal / cell.relevanceCount).toFixed(2))
          : null,
      citation_refs: cell.citations,
    }))
    .sort((a, b) => b.message_count - a.message_count)
    .slice(0, 120);

  return {
    generated_at: input.generatedAt,
    window: {
      start: input.windowStart,
      end: input.windowEnd,
      hours: Math.max(
        1,
        Math.round(
          (Date.parse(input.windowEnd) - Date.parse(input.windowStart)) / 36e5,
        ),
      ),
    },
    overview: {
      messages: input.messages.length,
      people: people.size,
      channels: channelAcc.size,
      topics: topicAcc.size,
      links: linkSummaries.length,
    },
    channels,
    topics,
    matrix,
    concerns: concerns.slice(0, 12),
    links: linkSummaries,
    citations,
  };
}

function parseTopics(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function messageRef(id: string): string {
  return `vibez:message:${id}`;
}

function linkRef(id: number | string): string {
  return `vibez:link:${String(id)}`;
}

function pushUnique(items: string[], item: string, limit: number): void {
  if (items.includes(item) || items.length >= limit) return;
  items.push(item);
}

function topEntries(map: Map<string, number>, limit: number): Array<{ name: string; count: number }> {
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function excerpt(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1)}...`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
