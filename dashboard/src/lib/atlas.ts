export interface AtlasMessageRow {
  id: string;
  room_id?: string | null;
  room_name: string;
  sender_id?: string | null;
  sender_name: string;
  body: string;
  timestamp: number;
  raw_event?: string | null;
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

export type AtlasNewFaceReason =
  | "first_seen"
  | "intros_channel"
  | "member_event"
  | "phone_or_name_addition";

export interface AtlasNewFace {
  name: string;
  sender_id: string | null;
  first_seen: string;
  first_seen_ts: number;
  first_channel: string;
  message_count_7d: number;
  channels: string[];
  intro_refs: string[];
  detection_reasons: AtlasNewFaceReason[];
}

export type AtlasIdentitySignalReason = Exclude<AtlasNewFaceReason, "first_seen">;

export interface AtlasIdentitySignal {
  name: string;
  sender_id: string | null;
  first_seen: string;
  first_seen_ts: number;
  signal_seen: string;
  signal_seen_ts: number;
  signal_channel: string;
  message_count_7d: number;
  channels: string[];
  intro_refs: string[];
  signal_reasons: AtlasIdentitySignalReason[];
}

export interface AtlasTopContributor {
  name: string;
  sender_id: string | null;
  message_count_7d: number;
  active_days_7d: number;
  channels: string[];
  latest_seen: string;
  latest_seen_ts: number;
  citation_refs: string[];
}

export interface AtlasPeopleInsights {
  window_days: 7;
  generated_at: string;
  new_faces: AtlasNewFace[];
  identity_signals: AtlasIdentitySignal[];
  top_contributors: AtlasTopContributor[];
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
  people: AtlasPeopleInsights;
  narrative: AtlasNarrative;
  citations: Record<string, AtlasCitation>;
}

export function buildAtlasSnapshotFromRows(input: {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  messages: AtlasMessageRow[];
  links: AtlasLinkRow[];
  people?: AtlasPeopleInsights;
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
    people: input.people || buildFallbackPeopleInsights(input.generatedAt, input.messages),
    narrative,
    citations,
  };
}

function buildFallbackPeopleInsights(generatedAt: string, messages: AtlasMessageRow[]): AtlasPeopleInsights {
  const sevenDayCutoff = Date.parse(generatedAt) - 7 * 24 * 60 * 60 * 1000;
  const people = new Map<string, {
    name: string;
    senderId: string | null;
    count: number;
    activeDays: Set<string>;
    channels: Set<string>;
    latestTs: number;
    citations: string[];
  }>();

  for (const row of messages) {
    if (row.timestamp < sevenDayCutoff) continue;
    const name = row.sender_name || "Unknown";
    const key = row.sender_id || name.toLowerCase();
    const entry = people.get(key) || {
      name,
      senderId: row.sender_id || null,
      count: 0,
      activeDays: new Set<string>(),
      channels: new Set<string>(),
      latestTs: row.timestamp,
      citations: [],
    };
    entry.count += 1;
    entry.activeDays.add(new Date(row.timestamp).toISOString().slice(0, 10));
    entry.channels.add(row.room_name || "Unknown");
    entry.latestTs = Math.max(entry.latestTs, row.timestamp);
    pushUnique(entry.citations, messageRef(row.id), 4);
    people.set(key, entry);
  }

  return {
    window_days: 7,
    generated_at: generatedAt,
    new_faces: [],
    identity_signals: [],
    top_contributors: Array.from(people.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .map((entry) => ({
        name: entry.name,
        sender_id: entry.senderId,
        message_count_7d: entry.count,
        active_days_7d: entry.activeDays.size,
        channels: Array.from(entry.channels).sort(),
        latest_seen: new Date(entry.latestTs).toISOString(),
        latest_seen_ts: entry.latestTs,
        citation_refs: entry.citations,
      })),
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
  const topTopicName = topTopic ? humanizeTopic(topTopic.name) : "";
  const topicList = humanList(input.topics.slice(0, 4).map((topic) => humanizeTopic(topic.name)));
  const channelList = input.channels.slice(0, 3).map((channel) => channel.name).join(", ");
  const headline = topChannel
    ? `${topChannel.name} drove the conversation`
    : "The conversation needs more evidence";
  const lead = topChannel && topTopic
    ? `${topChannel.name} was the busiest room. The clearest theme was ${topTopicName}.`
    : "There is activity here, but not enough tagged evidence to tell a strong story yet.";
  const paragraphs = [
    lead,
    topTopic
      ? `${sentenceCase(topTopicName)} ran through ${humanList(topTopic.channels.slice(0, 4))}. It mattered because people returned to it from more than one room.`
      : "The report needs more classified messages before it can name the main theme with confidence.",
    topCell
      ? `Start with ${topCell.channel}. That is where ${humanizeTopic(topCell.topic)} had the clearest shape and the most useful evidence.`
      : "Start with the busiest rooms, then read the citations before drawing a conclusion.",
    unresolved.length > 0
      ? "The open questions deserve attention. They mark places where the group has not yet settled what to do next."
      : "No urgent concern dominates the report. The useful work is to follow the strongest theme and read the evidence behind it.",
  ];

  const whatMatters = [
    topTopic
      ? `${sentenceCase(topTopicName)} crossed ${pluralize(topTopic.channels.length, "channel")}.`
      : "The main theme is still unclear.",
    topChannel
      ? `${topChannel.name} carried the most activity.`
      : "No room carried the discussion.",
  ];
  if (input.links.length > 0) {
    whatMatters.push(`${pluralize(input.links.length, "shared link")} can anchor follow-up.`);
  }
  if (underCovered) {
    whatMatters.push("Some messages still need classification before the report is complete.");
  }

  const whatToWatch = [
    unresolved.length > 0
      ? "Resolve the open questions before treating this as settled."
      : "Watch whether this theme repeats in the next report.",
    topicList ? `Scan related themes: ${topicList}.` : "Refresh classifications if the report feels thin.",
  ];

  return {
    title,
    summary: lead,
    report: {
      headline,
      kicker: title,
      lead,
      what_matters: whatMatters,
      what_to_watch: whatToWatch,
      evidence_refs: topTopic?.citation_refs || topChannel?.citation_refs || [],
    },
    paragraphs,
    main_topic: buildMainTopicNarrative(topTopic, topCell, input.channels),
    week_in_review: {
      title: "Week in Review",
      bullets: [
        channelList ? `Most active channels: ${channelList}.` : "No active channels were found.",
        topicList ? `Recurring themes: ${topicList}.` : "No recurring themes were found.",
        unresolved.length > 0
          ? `${unresolved.length} concern or open-question signals remain unresolved.`
          : "No unresolved concern dominates the report.",
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
      title: "Main theme: not enough evidence",
      topic: null,
      paragraphs: [
        "There is not enough tagged evidence to name a main theme.",
        "The right move is to refresh the recent classifications, then read the strongest citations.",
        "Until then, the report can show activity, but it should not pretend to know more than it does.",
        "Look first at the busiest rooms and the open questions.",
        "Once the evidence improves, this section will become a short editorial note.",
      ],
      citation_refs: [],
    };
  }

  const topicName = humanizeTopic(topic.name);
  const channelNames = humanList(topic.channels.slice(0, 4));
  const peopleNames = humanList(topic.people.slice(0, 5));
  const strongestIntersection =
    topCell && topCell.topic === topic.name
      ? `${topCell.channel}, where ${pluralize(topCell.message_count, "message")} gave the theme shape`
      : `${topic.channels[0] || "the leading channel"}, where the theme first appeared`;
  const adjacentChannels = channels
    .filter((channel) => channel.top_topics.some((entry) => entry.name === topic.name))
    .slice(0, 4)
    .map((channel) => channel.name)
    .join(", ");

  return {
    title: `Main theme: ${topicName}`,
    topic: topic.name,
    paragraphs: [
      `${sentenceCase(topicName)} led the report because people returned to it more than any other theme.`,
      `It was not confined to one room. It appeared in ${channelNames || "several rooms"}, which gives it weight.`,
      `The best place to start is ${strongestIntersection}.`,
      peopleNames
        ? `${peopleNames} were visible in the cited evidence, so this reads like a conversation rather than a private note.`
        : "The evidence does not yet show a broad set of people, so read this cautiously.",
      adjacentChannels
        ? `Next, read the citations and compare them with ${adjacentChannels}. That will show whether this is one story or several related questions.`
        : "Next, read the citations and compare the next report. That will show whether this theme lasts.",
    ],
    citation_refs: topic.citation_refs,
  };
}

function humanizeTopic(topic: string): string {
  return topic.replace(/[-_]+/g, " ").trim();
}

function sentenceCase(text: string): string {
  if (!text) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function humanList(items: string[]): string {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
