import { describe, expect, test, vi } from "vitest";

import { buildAtlasSnapshotFromRows } from "./atlas";
import {
  buildAtlasReportEvidence,
  buildAtlasReportMessages,
  generateAtlasEditorialReport,
  normalizeAtlasEditorialReport,
} from "./atlas-report";

const baseTs = Date.parse("2026-05-16T12:00:00Z");

function sampleAtlas() {
  return buildAtlasSnapshotFromRows({
    generatedAt: "2026-05-16T13:00:00Z",
    windowStart: "2026-05-14T13:00:00Z",
    windowEnd: "2026-05-16T13:00:00Z",
    messages: [
      {
        id: "m1",
        room_name: "Agents",
        sender_name: "Dana",
        body: "The evaluation loop is blocking agent work, but the citation trail makes it fixable.",
        timestamp: baseTs,
        relevance_score: 9,
        topics: JSON.stringify(["agents", "evaluation"]),
        alert_level: "hot",
      },
      {
        id: "m2",
        room_name: "Tools",
        sender_name: "Lee",
        body: "Can we connect the tool catalog back to durable records before the weekly readout?",
        timestamp: baseTs - 10_000,
        relevance_score: 8,
        topics: JSON.stringify(["agents"]),
        alert_level: "normal",
      },
    ],
    links: [
      {
        id: 11,
        url: "https://example.com/evals",
        title: "Agent eval notes",
        category: "reference",
        relevance: "Background on evaluation loops",
        shared_by: "Dana",
        source_group: "Agents",
        last_seen: "2026-05-16T12:30:00Z",
        value_score: 4,
      },
    ],
  });
}

function completeArticle(title: string, role = "secondary", ref = "vibez:message:m1") {
  return {
    article: {
      role,
      section: role === "lead" ? "Agent Harnesses" : "Personal Workflows",
      title,
      dek: "A complete deck grounded in evidence.",
      summary: "A complete article summary grounded in evidence.",
      body: [
        "The article opens with the concrete thing that happened.",
        "The evidence paragraph names what the citation shows.",
        "The analysis paragraph explains the implication.",
        "The value paragraph explains why the reader should care.",
        "The action paragraph names the next useful move.",
      ],
      actions: ["Check the cited thread."],
      evidence_refs: [ref],
      link_refs: [],
      channels: [role === "lead" ? "Agents" : "Tools"],
      image: { kind: "generated", prompt: "newspaper illustration", alt: "Editorial illustration" },
      related_article_slugs: [],
    },
  };
}

describe("atlas editorial report", () => {
  test("builds an evidence pack with citations the model can reason from", () => {
    const evidence = buildAtlasReportEvidence(sampleAtlas());

    expect(evidence.overview).toMatchObject({ messages: 2, channels: 2, links: 1 });
    expect(evidence.citations.map((citation) => citation.ref)).toEqual([
      "vibez:message:m1",
      "vibez:message:m2",
      "vibez:link:11",
    ]);
    expect(evidence.citations[0]).toMatchObject({
      channel: "Agents",
      sender: "Dana",
      text: expect.stringContaining("evaluation loop"),
      topics: ["agents", "evaluation"],
    });
    expect(evidence.concerns[0]).toMatchObject({
      title: "Hot signal in Agents",
      citation_refs: ["vibez:message:m1"],
    });
  });

  test("pulls evidence from active channels so the newspaper is not trapped in one theme", () => {
    const atlas = sampleAtlas();
    atlas.narrative.report.evidence_refs = ["vibez:message:m1"];

    const evidence = buildAtlasReportEvidence(atlas);

    expect(evidence.citations.map((citation) => citation.ref)).toContain("vibez:message:m2");
  });

  test("prompts for reader-value analysis instead of link snippets", () => {
    const messages = buildAtlasReportMessages(sampleAtlas());
    const promptText = messages.map((message) => message.content).join("\n");

    expect(promptText).toContain("Edward R. Murrow");
    expect(promptText).toContain("community members");
    expect(promptText).not.toMatch(/\busers\b/i);
    expect(promptText).toContain("daily newspaper issue");
    expect(promptText).toContain("Do not reduce the day to one theme");
    expect(promptText).toContain("MUST include 3 to 6 articles");
    expect(promptText).toContain("section");
    expect(promptText).toContain("at least five paragraphs");
    expect(promptText).toContain("Every article must carry citations");
    expect(promptText).toContain("generated image brief");
    expect(promptText).toContain("What happened?");
    expect(promptText).toContain("What does this mean?");
    expect(promptText).toContain("Why should I care?");
    expect(promptText).toContain("What is valuable here?");
    expect(promptText).toContain("What do I need to action here?");
    expect(promptText).toContain("vibez:message:m1");
    expect(promptText).toContain("Strunk and White");
  });

  test("normalizes a newspaper issue with multiple durable article slugs", () => {
    const report = normalizeAtlasEditorialReport(
      {
        issue: {
          date: "2026-05-16",
          title: "The Vibez Atlas",
          subtitle: "A busy day splits into several stories.",
          edition_label: "Daily Edition",
        },
        headline: "The agent work found its bottleneck",
        dek: "Evaluation, not enthusiasm, is the limiting reagent.",
        what_happened: ["People circled the evaluation loop and the records behind it."],
        what_it_means: ["The project is moving from demo energy to operating discipline."],
        why_care: ["This is where agent work starts to become repeatable."],
        valuable: ["The useful artifact is the citation trail, not the chatter."],
        actions: ["Turn the evaluation question into an owner and a next check."],
        main_topic: {
          title: "Evaluation as leverage",
          paragraphs: [
            "The first paragraph names the theme.",
            "The second paragraph explains what happened.",
            "The third paragraph explains what it means.",
            "The fourth paragraph explains why it matters.",
            "The fifth paragraph names the next useful move.",
          ],
          evidence_refs: ["vibez:message:m1"],
        },
        articles: [
          {
            role: "lead",
            section: "Agent Harnesses",
            title: "Evaluation becomes the work",
            dek: "The room is moving from demos to proof.",
            summary: "The main article explains why evaluation is now the bottleneck.",
            body: [
              "Evaluation moved from background concern to front-page story.",
              "The cited messages show a group asking for proof, not applause.",
              "That matters because repeatable agent work needs durable records.",
              "The useful thing here is the citation trail.",
              "The next move is to assign an owner and check the loop.",
            ],
            actions: ["Assign an owner for the evaluation loop."],
            evidence_refs: ["vibez:message:m1", "vibez:message:nope"],
            link_refs: ["vibez:link:11"],
            channels: ["Agents"],
            image: { kind: "generated", prompt: "newspaper illustration of agent evaluation" },
            related_article_slugs: ["Tooling gaps are product gaps"],
          },
          {
            role: "secondary",
            section: "Personal Workflows",
            title: "Tooling gaps are product gaps",
            dek: "Questions about records point to a product brief.",
            summary: "The side article explains the tooling pain.",
            body: [
              "The side story deserves its own space.",
              "It is related to the lead but not the same story.",
              "The evidence points to records and follow-up.",
              "The value is a product-shaped question.",
              "The next move is to test the workflow.",
            ],
            actions: ["Review the tool catalog."],
            evidence_refs: ["vibez:message:m2"],
            link_refs: [],
            channels: ["Tools"],
          },
          {
            role: "secondary",
            section: "Durable Records",
            title: "Durable records become the archive",
            dek: "The links and citations need a long-lived home.",
            summary: "The third article explains why the record itself matters.",
            body: [
              "A third story completes the front page.",
              "It follows the evidence system rather than the people.",
              "The durable record changes how the group can learn.",
              "The value is continuity.",
              "The next move is to preserve the source trail.",
            ],
            actions: ["Save the source trail."],
            evidence_refs: ["vibez:message:m1"],
            link_refs: ["vibez:link:11"],
            channels: ["Agents", "Tools"],
          },
        ],
        briefs: [
          {
            title: "A useful reference surfaced",
            text: "The eval notes link is worth saving.",
            evidence_refs: ["vibez:link:11"],
          },
        ],
        crosscurrents: [
          {
            title: "Agents and Tools are converging",
            text: "The rooms are asking different versions of the same records question.",
            channels: ["Agents", "Tools"],
            evidence_refs: ["vibez:message:m1", "vibez:message:m2"],
          },
        ],
        themes: [],
        evidence: [],
      },
      sampleAtlas(),
    );

    expect(report.issue).toMatchObject({
      date: "2026-05-16",
      title: "The Vibez Atlas",
      edition_label: "Daily Edition",
    });
    expect(report.articles).toHaveLength(3);
    expect(report.articles[0]).toMatchObject({
      role: "lead",
      section: "Agent Harnesses",
      slug: "evaluation-becomes-the-work",
      evidence_refs: ["vibez:message:m1"],
      link_refs: ["vibez:link:11"],
    });
    expect(report.articles[0].related_article_slugs).toEqual([
      "tooling-gaps-are-product-gaps",
    ]);
    expect(report.briefs[0].evidence_refs).toEqual(["vibez:link:11"]);
    expect(report.crosscurrents[0].channels).toEqual(["Agents", "Tools"]);
  });

  test("cleans article section labels and paragraph scaffolding", () => {
    const report = normalizeAtlasEditorialReport(
      {
        headline: "The agent work found its bottleneck",
        dek: "Evaluation, not enthusiasm, is the limiting reagent.",
        what_happened: ["People circled the evaluation loop."],
        what_it_means: ["The project is moving from demo energy to operating discipline."],
        why_care: ["This is where agent work starts to become repeatable."],
        valuable: ["The useful artifact is the citation trail."],
        actions: ["Turn the evaluation question into an owner and a next check."],
        main_topic: {
          title: "Evaluation as leverage",
          paragraphs: [
            "The first paragraph names the theme.",
            "The second paragraph explains what happened.",
            "The third paragraph explains what it means.",
            "The fourth paragraph explains why it matters.",
            "The fifth paragraph names the next useful move.",
          ],
          evidence_refs: ["vibez:message:m1"],
        },
        articles: [
          {
            role: "lead",
            section: "Personal Agents 🦞🦀🛫😱",
            title: "Evaluation becomes the work",
            dek: "The room is moving from demos to proof.",
            summary: "The main article explains why evaluation is now the bottleneck.",
            body: [
              "Lead paragraph: Evaluation moved from background concern to front-page story.",
              "Evidence: The cited messages show a group asking for proof, not applause.",
              "Analysis paragraph: That matters because repeatable agent work needs durable records.",
              "Value: The useful thing here is the citation trail.",
              "Action paragraph: The next move is to assign an owner and check the loop.",
            ],
            actions: ["Assign an owner for the evaluation loop."],
            evidence_refs: ["vibez:message:m1"],
            link_refs: [],
            channels: ["Agents"],
          },
          {
            role: "secondary",
            section: "Personal Workflows",
            title: "Tooling gaps are product gaps",
            dek: "Questions about records point to a product brief.",
            summary: "The side article explains the tooling pain.",
            body: [
              "The side story deserves its own space.",
              "It is related to the lead but not the same story.",
              "The evidence points to records and follow-up.",
              "The value is a product-shaped question.",
              "The next move is to test the workflow.",
            ],
            actions: ["Review the tool catalog."],
            evidence_refs: ["vibez:message:m2"],
          },
          {
            role: "secondary",
            section: "#ai-oss",
            title: "Durable records become the archive",
            dek: "The links and citations need a long-lived home.",
            summary: "The third article explains why the record itself matters.",
            body: [
              "A third story completes the front page.",
              "It follows the evidence system rather than the people.",
              "The durable record changes how the group can learn.",
              "The value is continuity.",
              "The next move is to preserve the source trail.",
            ],
            actions: ["Save the source trail."],
            evidence_refs: ["vibez:message:m1"],
          },
        ],
      },
      sampleAtlas(),
    );

    expect(report.articles[0].section).toBe("Personal Agents");
    expect(report.articles[0].body[0]).toBe("Evaluation moved from background concern to front-page story.");
    expect(report.articles[2].section).toBe("AI OSS");
  });

  test("normalizes model output and drops unsupported citation refs", () => {
    const report = normalizeAtlasEditorialReport(
      {
        headline: "The agent work found its bottleneck",
        dek: "Evaluation, not enthusiasm, is the limiting reagent.",
        what_happened: ["People circled the evaluation loop and the records behind it."],
        what_it_means: ["The project is moving from demo energy to operating discipline."],
        why_care: ["This is where agent work starts to become repeatable."],
        valuable: ["The useful artifact is the citation trail, not the chatter."],
        actions: ["Turn the evaluation question into an owner and a next check."],
        main_topic: {
          title: "Evaluation as leverage",
          paragraphs: [
            "The first paragraph names the theme.",
            "The second paragraph explains what happened.",
            "The third paragraph explains what it means.",
            "The fourth paragraph explains why it matters.",
            "The fifth paragraph names the next useful move.",
          ],
          evidence_refs: ["vibez:message:m1", "vibez:message:nope"],
        },
        themes: [
          {
            title: "Evaluation as leverage",
            analysis: "The theme matters because it links ambition to proof.",
            evidence_refs: ["vibez:message:m1", "vibez:message:nope"],
          },
        ],
        evidence: [
          {
            ref: "vibez:message:m1",
            label: "Dana in Agents",
            why_it_matters: "It names the blocker plainly.",
          },
        ],
      },
      sampleAtlas(),
    );

    expect(report.themes[0].evidence_refs).toEqual(["vibez:message:m1"]);
    expect(report.main_topic.paragraphs).toHaveLength(5);
    expect(report.main_topic.evidence_refs).toEqual(["vibez:message:m1"]);
    expect(report.evidence[0].why_it_matters).toContain("blocker");
    expect(report.generated_at).toMatch(/T/);
  });

  test("uses the atlas report route and does not synthesize a fake fallback", async () => {
    const generator = vi.fn().mockResolvedValue({
      parsed: {
        headline: "The agent work found its bottleneck",
        dek: "Evaluation, not enthusiasm, is the limiting reagent.",
        what_happened: ["People circled the evaluation loop."],
        what_it_means: ["The project is moving from demo energy to operating discipline."],
        why_care: ["This is where agent work starts to become repeatable."],
        valuable: ["The useful artifact is the citation trail."],
        actions: ["Turn the evaluation question into an owner and a next check."],
        main_topic: {
          title: "Evaluation as leverage",
          paragraphs: [
            "The first paragraph names the theme.",
            "The second paragraph explains what happened.",
            "The third paragraph explains what it means.",
            "The fourth paragraph explains why it matters.",
            "The fifth paragraph names the next useful move.",
          ],
          evidence_refs: ["vibez:message:m1"],
        },
        themes: [],
        evidence: [],
      },
    });

    const report = await generateAtlasEditorialReport(sampleAtlas(), generator);

    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "dashboard.atlas_report",
        messages: expect.any(Array),
      }),
    );
    expect(report.headline).toBe("The agent work found its bottleneck");
  });

  test("asks the model to repair schema-invalid report JSON", async () => {
    const baseReport = {
      headline: "",
      dek: "Evaluation, not enthusiasm, is the limiting reagent.",
      what_happened: ["People circled the evaluation loop."],
      what_it_means: ["The project is moving from demo energy to operating discipline."],
      why_care: ["This is where agent work starts to become repeatable."],
      valuable: ["The useful artifact is the citation trail."],
      actions: ["Turn the evaluation question into an owner and a next check."],
      main_topic: {
        title: "Evaluation as leverage",
        paragraphs: ["Too short."],
        evidence_refs: ["vibez:message:m1"],
      },
      themes: [],
      evidence: [],
    };
    const generator = vi
      .fn()
      .mockResolvedValueOnce({ parsed: baseReport })
      .mockResolvedValueOnce({
        parsed: {
          ...baseReport,
          headline: "The agent work found its bottleneck",
          main_topic: {
            ...baseReport.main_topic,
            paragraphs: [
              "The first paragraph names the theme.",
              "The second paragraph explains what happened.",
              "The third paragraph explains what it means.",
              "The fourth paragraph explains why it matters.",
              "The fifth paragraph names the next useful move.",
            ],
          },
        },
      })
      .mockResolvedValue({ parsed: completeArticle("Evaluation becomes the work", "lead") });

    const report = await generateAtlasEditorialReport(sampleAtlas(), generator);

    expect(generator).toHaveBeenCalledTimes(5);
    expect(generator.mock.calls[1][0].messages.map((message) => message.content).join("\n")).toContain(
      "Repair this issue shell",
    );
    expect(report.main_topic.paragraphs).toHaveLength(5);
  });

  test("writes full articles in article-sized model passes", async () => {
    const baseReport = {
      headline: "The agent work found its bottleneck",
      dek: "Evaluation, not enthusiasm, is the limiting reagent.",
      what_happened: ["People circled the evaluation loop."],
      what_it_means: ["The project is moving from demo energy to operating discipline."],
      why_care: ["This is where agent work starts to become repeatable."],
      valuable: ["The useful artifact is the citation trail."],
      actions: ["Turn the evaluation question into an owner and a next check."],
      main_topic: {
        title: "Evaluation as leverage",
        paragraphs: [
          "The first paragraph names the theme.",
          "The second paragraph explains what happened.",
          "The third paragraph explains what it means.",
          "The fourth paragraph explains why it matters.",
          "The fifth paragraph names the next useful move.",
        ],
        evidence_refs: ["vibez:message:m1"],
      },
      article_seeds: [
        { role: "lead", section: "Agent Harnesses", title: "Evaluation becomes the work", evidence_refs: ["vibez:message:m1"] },
        { role: "secondary", section: "Personal Workflows", title: "Tooling gaps are product gaps", evidence_refs: ["vibez:message:m2"] },
        { role: "secondary", section: "Durable Records", title: "Durable records become the archive", evidence_refs: ["vibez:message:m1"] },
      ],
      briefs: [],
      crosscurrents: [],
      themes: [],
      evidence: [],
    };
    const generator = vi
      .fn()
      .mockResolvedValueOnce({ parsed: baseReport })
      .mockResolvedValueOnce({ parsed: completeArticle("Evaluation becomes the work", "lead") })
      .mockResolvedValueOnce({ parsed: completeArticle("Tooling gaps are product gaps", "secondary", "vibez:message:m2") })
      .mockResolvedValueOnce({ parsed: completeArticle("Durable records become the archive") });

    const report = await generateAtlasEditorialReport(sampleAtlas(), generator);

    expect(generator).toHaveBeenCalledTimes(4);
    expect(generator.mock.calls[1][0].messages.map((message) => message.content).join("\n")).toContain(
      "Write one complete article",
    );
    expect(report.articles).toHaveLength(3);
    expect(report.articles[0].body).toHaveLength(5);
  });

  test("uses active channel seeds when the shell omits article seeds", async () => {
    const baseReport = {
      headline: "The agent work found its bottleneck",
      dek: "Evaluation, not enthusiasm, is the limiting reagent.",
      what_happened: ["People circled the evaluation loop."],
      what_it_means: ["The project is moving from demo energy to operating discipline."],
      why_care: ["This is where agent work starts to become repeatable."],
      valuable: ["The useful artifact is the citation trail."],
      actions: ["Turn the evaluation question into an owner and a next check."],
      main_topic: {
        title: "Evaluation as leverage",
        paragraphs: [
          "The first paragraph names the theme.",
          "The second paragraph explains what happened.",
          "The third paragraph explains what it means.",
          "The fourth paragraph explains why it matters.",
          "The fifth paragraph names the next useful move.",
        ],
        evidence_refs: ["vibez:message:m1"],
      },
      briefs: [],
      crosscurrents: [],
      themes: [],
      evidence: [],
    };
    const generator = vi
      .fn()
      .mockResolvedValueOnce({ parsed: baseReport })
      .mockResolvedValueOnce({ parsed: completeArticle("Evaluation becomes the work", "lead") })
      .mockResolvedValueOnce({ parsed: completeArticle("Tooling gaps are product gaps", "secondary", "vibez:message:m2") })
      .mockResolvedValueOnce({ parsed: completeArticle("Durable records become the archive") });

    const report = await generateAtlasEditorialReport(sampleAtlas(), generator);

    expect(generator).toHaveBeenCalledTimes(4);
    expect(generator.mock.calls[1][0].messages.map((message) => message.content).join("\n")).toContain(
      "Write one complete article",
    );
    expect(report.articles).toHaveLength(3);
    expect(report.articles.every((article) => article.body.length >= 5)).toBe(true);
  });

  test("rejects article pages without five cited paragraphs", () => {
    expect(() =>
      normalizeAtlasEditorialReport(
        {
          headline: "The agent work found its bottleneck",
          dek: "Evaluation, not enthusiasm, is the limiting reagent.",
          what_happened: ["People circled the evaluation loop."],
          what_it_means: ["The project is moving from demo energy to operating discipline."],
          why_care: ["This is where agent work starts to become repeatable."],
          valuable: ["The useful artifact is the citation trail."],
          actions: ["Turn the evaluation question into an owner and a next check."],
          main_topic: {
            title: "Evaluation as leverage",
            paragraphs: [
              "The first paragraph names the theme.",
              "The second paragraph explains what happened.",
              "The third paragraph explains what it means.",
              "The fourth paragraph explains why it matters.",
              "The fifth paragraph names the next useful move.",
            ],
            evidence_refs: ["vibez:message:m1"],
          },
          articles: [
            {
              role: "lead",
              section: "Agent Harnesses",
              title: "Evaluation becomes the work",
              dek: "The room is moving from demos to proof.",
              summary: "The main article explains why evaluation is now the bottleneck.",
              body: [
                "Evaluation moved from background concern to front-page story.",
                "The cited messages show a group asking for proof, not applause.",
                "That matters because repeatable agent work needs durable records.",
              ],
              actions: ["Assign an owner for the evaluation loop."],
              evidence_refs: ["vibez:message:m1"],
              link_refs: ["vibez:link:11"],
              channels: ["Agents"],
              image: { kind: "generated", prompt: "newspaper illustration of agent evaluation" },
              related_article_slugs: [],
            },
            {
              role: "secondary",
              section: "Personal Workflows",
              title: "Tooling gaps are product gaps",
              dek: "Questions about records point to a product brief.",
              summary: "The side article explains the tooling pain.",
              body: [
                "The side story deserves its own space.",
                "It is related to the lead but not the same story.",
                "The evidence points to records and follow-up.",
                "The value is a product-shaped question.",
                "The next move is to test the workflow.",
              ],
              actions: ["Review the tool catalog."],
              evidence_refs: [],
              link_refs: [],
              channels: ["Tools"],
            },
            {
              role: "secondary",
              section: "Durable Records",
              title: "Durable records become the archive",
              dek: "The links and citations need a long-lived home.",
              summary: "The third article explains why the record itself matters.",
              body: [
                "A third story completes the front page.",
                "It follows the evidence system rather than the people.",
                "The durable record changes how the group can learn.",
                "The value is continuity.",
                "The next move is to preserve the source trail.",
              ],
              actions: ["Save the source trail."],
              evidence_refs: ["vibez:message:m1"],
              link_refs: ["vibez:link:11"],
              channels: ["Agents", "Tools"],
            },
          ],
          themes: [],
          evidence: [],
        },
        sampleAtlas(),
      ),
    ).toThrow("five cited paragraphs");
  });
});
