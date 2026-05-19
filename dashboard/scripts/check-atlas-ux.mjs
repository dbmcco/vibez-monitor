#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const targetUrl = process.env.VIBEZ_ATLAS_UX_URL || "http://127.0.0.1:3100/atlas";
const outputDir = path.resolve(process.cwd(), ".generated", "atlas-ux");
const uxMode = process.env.VIBEZ_ATLAS_UX_MODE || "strict";
const allowNoImages = uxMode === "no-images";
const accessCode = process.env.VIBEZ_ATLAS_UX_ACCESS_CODE || process.env.VIBEZ_ACCESS_CODE || "";
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

async function authenticateIfNeeded(page) {
  if (!accessCode) return;
  const origin = new URL(targetUrl).origin;
  await page.goto(`${origin}/access`, { waitUntil: "networkidle", timeout: 45_000 });
  const authenticated = await page.evaluate(async (code) => {
    const response = await fetch("/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    return response.ok;
  }, accessCode);
  if (!authenticated) {
    fail("access authentication failed");
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
    const fakeImageCount = imageElements
      .filter((image) => image.getAttribute("src")?.startsWith("data:image/svg+xml"))
      .length;
    const photoPendingCount = document.querySelectorAll("[data-atlas-photo-status]").length;
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
      fakeImageCount,
      photoPendingCount,
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

function assertCoreMetrics(metrics, viewportName) {
  if (metrics.scrollWidth > metrics.viewportWidth + 2) {
    fail(`${viewportName} has horizontal overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`);
  }
  if (metrics.hasRawMarkup) {
    fail(`${viewportName} renders raw HTML or markdown-like markup in reader text`);
  }
  if (metrics.overflowingElements.length > 0 || metrics.bleedingText.length > 0) {
    fail(`${viewportName} has element bleed: ${JSON.stringify({
      overflowing: metrics.overflowingElements,
      text: metrics.bleedingText,
    })}`);
  }
}

async function gotoChecked(page, url, label) {
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  const status = response?.status() || 0;
  if (status >= 400) {
    fail(`${label} returned HTTP ${status}`);
  }
  return response;
}

async function runClickThroughGates(page) {
  const firstArticleHref = await page.locator("a", { hasText: "Read full article" }).first().getAttribute("href");
  if (!firstArticleHref) {
    fail("front page has no Read full article href to click");
  }
  await gotoChecked(page, new URL(firstArticleHref, targetUrl).toString(), "first full article");
  await page.screenshot({
    path: path.join(outputDir, "article-clickthrough.png"),
    fullPage: true,
  });
  const articleMetrics = await pageMetrics(page);
  assertCoreMetrics(articleMetrics, "article-clickthrough");
  const articleText = articleMetrics.bodyText;
  if (!articleText.includes("Open research dive")) {
    fail("article page is missing the research dive action");
  }
  if (!articleText.includes("Evidence")) {
    fail("article page is missing the evidence rail");
  }
  if (allowNoImages && (articleMetrics.fakeImageCount > 0 || articleMetrics.photoPendingCount + articleMetrics.articleImageCount < 1)) {
    fail("article no-images state is missing either a real image or deliberate no-photo block");
  }

  const researchHref = await page.locator("a", { hasText: "Open research dive" }).first().getAttribute("href");
  if (!researchHref) {
    fail("article page has no research dive href");
  }
  await gotoChecked(page, new URL(researchHref, targetUrl).toString(), "research dive");
  await page.screenshot({
    path: path.join(outputDir, "research-dive-clickthrough.png"),
    fullPage: true,
  });
  const researchText = await page.locator("body").innerText();
  if (!/Research|dive|report/i.test(researchText) || /Article unavailable/i.test(researchText)) {
    fail("research dive route did not render a usable report page");
  }

  await gotoChecked(page, new URL("/atlas/editions", targetUrl).toString(), "editions archive");
  await page.screenshot({
    path: path.join(outputDir, "editions-archive.png"),
    fullPage: true,
  });
  const archiveText = await page.locator("body").innerText();
  if (!archiveText.includes("Daily Papers") || !archiveText.includes("Sunday Editions")) {
    fail("editions archive did not render daily and Sunday sections");
  }
}

const { chromium } = await loadPlaywright();
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();
const results = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    await authenticateIfNeeded(page);
    await gotoChecked(page, targetUrl, `${viewport.name} front page`);
    const metrics = await pageMetrics(page);
    await page.screenshot({
      path: path.join(outputDir, `${viewport.name}.png`),
      fullPage: true,
    });
    if (!metrics.bodyText.includes("The Vibez Atlas")) {
      fail(`${viewport.name} did not render the Atlas newspaper`);
    }
    assertCoreMetrics(metrics, viewport.name);
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
    if (metrics.usefulLinkCount < 1) {
      fail(`${viewport.name} renders no contextual useful-link actions`);
    }
    if (allowNoImages) {
      if (new URL(targetUrl).searchParams.get("images") === "off" && metrics.articleImageCount > 0) {
        fail(`${viewport.name} images=off rendered ${metrics.articleImageCount} real article images`);
      }
      if (metrics.fakeImageCount > 0 || metrics.hasImagePlaceholder) {
        fail(`${viewport.name} renders fake SVG or legacy image placeholders`);
      }
      if (metrics.photoPendingCount + metrics.articleImageCount < 5) {
        fail(`${viewport.name} renders only ${metrics.photoPendingCount + metrics.articleImageCount} article media blocks`);
      }
    } else {
      if (metrics.articleImageCount < 5) {
        fail(`${viewport.name} renders only ${metrics.articleImageCount} real article images`);
      }
      if (metrics.hasImagePlaceholder) {
        fail(`${viewport.name} still renders pending, failed, or placeholder article images`);
      }
    }
    if (viewport.name === "desktop-1440") {
      await runClickThroughGates(page);
    }
    await page.close();
    results.push({
      viewport: viewport.name,
      screenshot: path.join(outputDir, `${viewport.name}.png`),
      article_links: metrics.articleLinks,
      article_images: metrics.articleImageCount,
      photo_pending_blocks: metrics.photoPendingCount,
    });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ ok: true, url: targetUrl, results }, null, 2));
