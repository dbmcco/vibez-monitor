#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const targetUrl = process.env.VIBEZ_ATLAS_UX_URL || "http://127.0.0.1:3100/atlas";
const outputDir = path.resolve(process.cwd(), ".generated", "atlas-ux");
const viewports = [
  { name: "desktop-1440", width: 1440, height: 1100 },
  { name: "wide-1728", width: 1728, height: 1100 },
  { name: "mobile-390", width: 390, height: 900 },
];

function fail(message) {
  throw new Error(`Atlas UX check failed: ${message}`);
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    fail("playwright is unavailable; run with `npx -y -p playwright node scripts/check-atlas-ux.mjs`.");
  }
}

async function pageMetrics(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText;
    const root = document.documentElement;
    const articleLinks = Array.from(document.querySelectorAll("a"))
      .filter((link) => link.textContent?.toLowerCase().includes("read full article"))
      .length;
    const usefulLinkCount = Array.from(document.querySelectorAll("a"))
      .filter((link) => link.textContent?.toLowerCase().includes("open link"))
      .length;
    const imageElements = Array.from(document.querySelectorAll("img"));
    const articleImageCount = imageElements
      .filter((image) => image.getAttribute("src")?.includes("/api/atlas/image/"))
      .length;
    const hasImagePlaceholder = /Image (pending|failed)|Editorial image brief/.test(bodyText) ||
      imageElements.some((image) => image.getAttribute("src")?.startsWith("data:image/svg+xml"));
    const requiredSections = [
      "Signals Worth Acting On",
      "Unresolved Questions",
      "Useful Links",
    ];
    const missingSections = requiredSections.filter((section) => !bodyText.includes(section));
    const overflowingElements = Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        return rect.right > window.innerWidth + 2 || rect.left < -2;
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || "").trim().slice(0, 80),
        width: Math.round(element.getBoundingClientRect().width),
      }));
    const bleedingText = Array.from(document.querySelectorAll("article, section, aside, div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 20) return false;
        return element.scrollWidth > element.clientWidth + 2;
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent || "").trim().slice(0, 80),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
    return {
      title: document.title,
      scrollWidth: root.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyText,
      articleLinks,
      usefulLinkCount,
      articleImageCount,
      hasImagePlaceholder,
      missingSections,
      hasTopFoldEvidenceFallback: bodyText.includes("The matrix, citations, stats, and links sit below the fold."),
      hasEvidenceDesk: bodyText.includes("Evidence Desk"),
      hasEditionNotes: bodyText.includes("Edition notes"),
      hasRawMarkup: /<br|<pre|<code|&quot;|<\/?[a-z][\s>]/i.test(bodyText),
      overflowingElements,
      bleedingText,
    };
  });
}

const { chromium } = await loadPlaywright();
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();
const results = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 45_000 });
    const metrics = await pageMetrics(page);
    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}.png`),
      fullPage: true,
    });
    if (!metrics.bodyText.includes("The Vibez Atlas")) {
      fail(`${viewport.name} did not render the Atlas newspaper`);
    }
    if (metrics.scrollWidth > metrics.viewportWidth + 2) {
      fail(`${viewport.name} has horizontal overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`);
    }
    if (metrics.missingSections.length > 0) {
      fail(`${viewport.name} is missing below-fold sections: ${metrics.missingSections.join(", ")}`);
    }
    if (metrics.articleLinks < 5) {
      fail(`${viewport.name} renders only ${metrics.articleLinks} story links`);
    }
    if (metrics.hasTopFoldEvidenceFallback) {
      fail(`${viewport.name} still renders the obsolete top-fold Evidence Desk fallback`);
    }
    if (metrics.hasEvidenceDesk) {
      fail(`${viewport.name} still renders the obsolete Evidence Desk section`);
    }
    if (metrics.hasEditionNotes) {
      fail(`${viewport.name} still renders the obsolete Edition notes rail`);
    }
    if (metrics.hasRawMarkup) {
      fail(`${viewport.name} renders raw HTML or markdown-like markup in reader text`);
    }
    if (metrics.usefulLinkCount < 1) {
      fail(`${viewport.name} renders no contextual useful-link actions`);
    }
    if (metrics.articleImageCount < 5) {
      fail(`${viewport.name} renders only ${metrics.articleImageCount} real article images`);
    }
    if (metrics.hasImagePlaceholder) {
      fail(`${viewport.name} still renders pending, failed, or placeholder article images`);
    }
    if (metrics.overflowingElements.length > 0 || metrics.bleedingText.length > 0) {
      fail(`${viewport.name} has element bleed: ${JSON.stringify({
        overflowing: metrics.overflowingElements,
        text: metrics.bleedingText,
      })}`);
    }
    await page.close();
    results.push({
      viewport: viewport.name,
      screenshot: path.join(outputDir, `${viewport.name}.png`),
      article_links: metrics.articleLinks,
    });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, url: targetUrl, results }, null, 2));
