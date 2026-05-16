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

export interface AtlasNarrative {
  title: string;
  summary: string;
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
  narrative: AtlasNarrative;
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

  const windowHours = Math.max(
    1,
    Math.round(
      (Date.parse(input.windowEnd) - Date.parse(input.windowStart)) / 36e5,
    ),
  );
  const narrative = buildNarrative({
    windowHours,
    messageCount: input.messages.length,
    peopleCount: people.size,
    channels,
    topics,
    matrix,
    concerns: concerns.slice(0, 12),
    links: linkSummaries,
  });

  return {
    generated_at: input.generatedAt,
    window: {
      start: input.windowStart,
      end: input.windowEnd,
      hours: windowHours,
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
    narrative,
    citations,
  };
}

function buildNarrative(input: {
  windowHours: number;
  messageCount: number;
  peopleCount: number;
  channels: AtlasChannelSummary[];
  topics: AtlasTopicSummary[];
  matrix: AtlasMatrixCell[];
  concerns: AtlasConcern[];
  links: AtlasLinkSummary[];
}): AtlasNarrative {
  const topChannel = input.channels[0] || null;
  const topTopic = input.topics[0] || null;
  const topCell = input.matrix[0] || null;
  const unresolved = input.concerns.filter((concern) => concern.kind !== "under_covered");
  const underCovered = input.concerns.find((concern) => concern.kind === "under_covered");
  const title = input.windowHours >= 120 ? "Week in Review" : "Latest 48h Report";
  const windowLabel = input.windowHours >= 120 ? "the week" : "the last 48 hours";
  const topicList = input.topics.slice(0, 4).map((topic) => topic.name).join(", ");
  const channelList = input.channels.slice(0, 3).map((channel) => channel.name).join(", ");

  const paragraphs = [
    `${title}: ${input.messageCount} messages from ${input.peopleCount} people moved through ${input.channels.length} channels during ${windowLabel}.`,
    topTopic
      ? `The strongest narrative thread is ${topTopic.name}, appearing in ${topTopic.message_count} messages across ${topTopic.channels.length} channels.`
      : "There is not enough topic coverage yet to identify a dominant thread.",
    topChannel
      ? `${topChannel.name} is the busiest channel, with ${topChannel.message_count} messages and visible overlap with ${topChannel.top_topics.map((topic) => topic.name).join(", ") || "uncategorized discussion"}.`
      : "No channel has enough activity in this window to anchor the report.",
    topCell
      ? `The clearest intersection is ${topCell.topic} inside ${topCell.channel}, with ${topCell.message_count} cited messages from ${topCell.people.length} people.`
      : "The channel-topic matrix is still sparse, so the report should be read as a coverage map rather than a settled story.",
    unresolved.length > 0
      ? `${unresolved.length} concern or open-question signals need review before this becomes a stable narrative.`
      : "No hot-alert or open-question signal stands out in the current window.",
  ];

  if (input.links.length > 0) {
    paragraphs.push(`${input.links.length} shared links are available as durable artifacts for follow-up.`);
  }
  if (underCovered) {
    paragraphs.push(`Topic coverage remains incomplete: ${underCovered.detail}`);
  }
  if (topicList) {
    paragraphs.push(`Secondary threads to scan next: ${topicList}.`);
  }

  return {
    title,
    summary: paragraphs.slice(0, 2).join(" "),
    paragraphs,
    main_topic: buildMainTopicNarrative(topTopic, topCell, input.channels),
    week_in_review: {
      title: "Week in Review",
      bullets: [
        channelList ? `Most active channels: ${channelList}.` : "No active channels were found.",
        topicList ? `Recurring themes: ${topicList}.` : "No recurring themes were found.",
        unresolved.length > 0
          ? `${unresolved.length} concern or open-question signals remain unresolved.`
          : "No unresolved concern cluster dominates the window.",
        input.links.length > 0
          ? `${input.links.length} shared links provide follow-up material.`
          : "No fresh shared links were captured for this window.",
      ],
    },
  };
}

function buildMainTopicNarrative(
  topic: AtlasTopicSummary | null,
  topCell: AtlasMatrixCell | null,
  channels: AtlasChannelSummary[],
): AtlasNarrative["main_topic"] {
  if (!topic) {
    return {
      title: "Main topic: not enough coverage",
      topic: null,
      paragraphs: [
        "The current window does not have enough topic-tagged messages to support a main-topic narrative.",
        "That usually means the classifier needs to catch up before the report can connect channels into a useful story.",
        "The matrix can still show where activity happened, but it should not be treated as thematic synthesis yet.",
        "The most useful next step is to inspect unclassified channels and refresh the recent classification queue.",
        "Once topic coverage improves, this section will become a five-paragraph write-up of the leading thread.",
      ],
      citation_refs: [],
    };
  }

  const channelNames = topic.channels.slice(0, 4).join(", ");
  const peopleNames = topic.people.slice(0, 5).join(", ");
  const strongestIntersection =
    topCell && topCell.topic === topic.name
      ? `${topCell.channel}, where ${topCell.message_count} messages clustered around the topic`
      : `${topic.channels[0] || "the leading channel"}, where the theme first concentrates`;
  const adjacentChannels = channels
    .filter((channel) => channel.top_topics.some((entry) => entry.name === topic.name))
    .slice(0, 4)
    .map((channel) => channel.name)
    .join(", ");

  return {
    title: `Main topic: ${topic.name}`,
    topic: topic.name,
    paragraphs: [
      `${topic.name} is the main topic because it has the highest classified volume in this window, with ${topic.message_count} messages across ${topic.channels.length} channels.`,
      `The theme is not isolated to one room; it shows up across ${channelNames || "multiple channels"}, which is why it has more narrative value than a single-channel spike.`,
      `The strongest intersection is ${strongestIntersection}, giving the report a concrete place to start reading the evidence.`,
      peopleNames
        ? `The people most visible in the cited evidence include ${peopleNames}, so the thread has enough participation to be read as conversation rather than a one-person note.`
        : "The cited evidence does not yet show a broad participant base, so the thread should be treated cautiously.",
      adjacentChannels
        ? `For follow-up, read the citations first, then compare adjacent channel appearances in ${adjacentChannels} to see whether this is one narrative or several related concerns.`
        : "For follow-up, read the citations first and compare later windows to see whether this becomes a recurring narrative.",
    ],
    citation_refs: topic.citation_refs,
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
