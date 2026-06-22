import type { Chapter, ChapterDetails, SourceManga } from "@paperback/types";

import { assembleHtmlChapter, type RawEpubPage } from "./html-assembler.js";
import { KavitaRequestError, type KavitaClient } from "./client.js";
import { novelChapterToPaperback } from "./chapter-mapper.js";
import type { KavitaTocItem } from "./models.js";
import {
  novelRenderingModeDiagnosticName,
  type NovelRenderingMode,
} from "./novel-rendering-mode.js";
import {
  createChapterResourceBudget,
  omittedIllustrationPlaceholder,
  rewriteHtmlResources,
  type ChapterResourceBudget,
  type ResourceFetchCache,
  type ResourceRewriteStats,
} from "./resource-rewriter.js";
import { logicalChaptersFromToc } from "./toc.js";

const STATIC_PROBE_PARAGRAPH =
  "Mutsuki HTML reader probe paragraph for deterministic pagination. " +
  "This diagnostic text is intentionally plain, local, and repeated so Paperback has enough visible content to paginate without fetching Kavita resources.";

export const STATIC_PROBE_HTML =
  '<html xmlns="http://www.w3.org/1999/xhtml">' +
  "<head></head>" +
  "<body>" +
  Array.from(
    { length: 16 },
    (_unused, index) => `<p>${STATIC_PROBE_PARAGRAPH} Paragraph ${index + 1}.</p>`,
  ).join("") +
  "</body>" +
  "</html>";

type HtmlChapterDetails = ChapterDetails & { type: "html"; html: string };

export async function getNovelChaptersFromBook(input: {
  sourceManga: SourceManga;
  client: KavitaClient;
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  volumeNumber?: number;
  fallbackTitle?: string;
  totalPages: number;
  includePublisherExtras?: boolean;
  toc?: KavitaTocItem[];
}): Promise<Chapter[]> {
  if (!Number.isFinite(input.totalPages) || input.totalPages < 1) return [];

  const toc = input.toc ?? (await input.client.getBookChapters(input.kavitaChapterId));
  return logicalChaptersFromToc({
    kavitaSeriesId: input.kavitaSeriesId,
    kavitaVolumeId: input.kavitaVolumeId,
    kavitaChapterId: input.kavitaChapterId,
    volumeNumber: input.volumeNumber,
    fallbackTitle: input.fallbackTitle,
    totalPages: input.totalPages,
    includePublisherExtras: input.includePublisherExtras,
    listingMode: "internal-chapters",
    toc,
  }).map(
    (logicalChapter, index) =>
      novelChapterToPaperback({
        sourceManga: input.sourceManga,
        logicalChapter,
        html: "",
        sortingIndex: index,
      }).chapter as Chapter,
  );
}

export async function getNovelChapterDetails(input: {
  sourceManga: SourceManga;
  chapter: Chapter;
  client: KavitaClient;
  renderingMode: NovelRenderingMode;
  maxResourceBytes: number;
  maxChapterBytes: number;
  debugLogging: boolean;
  build: string;
  incomingContentType: string | undefined;
  resolvedContentType: string | undefined;
  kavitaFormat: string | undefined;
}): Promise<ChapterDetails> {
  const info = input.chapter.additionalInfo ?? {};
  const diagnosticBase = {
    build: input.build,
    mode: input.renderingMode,
    seriesId: diagnosticInteger(info.kavitaSeriesId),
    chapterId: input.chapter.chapterId,
    incomingContentType: input.incomingContentType,
    resolvedContentType: input.resolvedContentType,
    kavitaFormat: input.kavitaFormat,
    structuralTocEntriesFiltered: diagnosticCount(info.structuralTocEntriesFiltered),
    parsedWordChapterNumberCount: diagnosticCount(info.parsedWordChapterNumberCount),
    debugLogging: input.debugLogging,
  };

  if (input.renderingMode === "static-probe") {
    const details: HtmlChapterDetails = {
      id: input.chapter.chapterId,
      mangaId: input.chapter.sourceManga.mangaId,
      type: "html",
      html: STATIC_PROBE_HTML,
    };
    assertHtmlNovelDetails(details);
    logNovelDiagnostic({
      ...diagnosticBase,
      startPage: diagnosticInteger(info.startPage),
      endPage: diagnosticInteger(info.endPage),
      fetchedPageCount: 0,
      htmlBytes: htmlByteLength(details.html),
      visibleTextCharacters: extractVisibleText(details.html).length,
      sourceHtmlBytes: 0,
      sourceVisibleTextCharacters: extractVisibleText(details.html).length,
      projectedHtmlBytesBeforeBudget: htmlByteLength(details.html),
      finalHtmlBytes: htmlByteLength(details.html),
      finalVisibleTextCharacters: extractVisibleText(details.html).length,
      chapterSizeLimitBytes: input.maxChapterBytes,
      sizeLimitHit: false,
      textFallbackUsed: false,
      inlinedResourceCount: 0,
      inlinedResourceBytes: 0,
      omittedImageCount: 0,
      omittedCssAssetCount: 0,
      missingResourceCount: 0,
      missingStylesheetCount: 0,
      rewrittenHtmlImageCount: 0,
      rewrittenSvgImageCount: 0,
      unresolvedNamespacePrefixCount: 0,
    });
    return details;
  }

  const kavitaChapterId = safeIntegerValue(info.kavitaChapterId, "kavitaChapterId");
  if (kavitaChapterId <= 0) throw new Error("Invalid Kavita EPUB chapter id.");
  const requestedStartPage = safeIntegerValue(info.startPage, "startPage");
  const requestedEndPage = safeIntegerValue(info.endPage, "endPage");
  const bookInfo = recordValue(await input.client.getBookInfo(kavitaChapterId));
  const totalPages = safePositivePageCount(numberField(bookInfo, "pages", "Pages"));
  const { startPage, endPage } = clampPageRange({
    startPage: requestedStartPage,
    endPage: requestedEndPage,
    totalPages,
  });

  if (input.renderingMode === "plain-text") {
    const page = await input.client.getBookPage(kavitaChapterId, startPage);
    const visibleText = extractVisibleText(page);
    const details: HtmlChapterDetails = {
      id: input.chapter.chapterId,
      mangaId: input.chapter.sourceManga.mangaId,
      type: "html",
      html: wrapPlainTextAsXhtml(visibleText),
    };
    assertHtmlNovelDetails(details);
    logNovelDiagnostic({
      ...diagnosticBase,
      startPage,
      endPage,
      fetchedPageCount: 1,
      htmlBytes: htmlByteLength(details.html),
      visibleTextCharacters: visibleText.length,
      sourceHtmlBytes: htmlByteLength(page),
      sourceVisibleTextCharacters: visibleText.length,
      projectedHtmlBytesBeforeBudget: htmlByteLength(details.html),
      finalHtmlBytes: htmlByteLength(details.html),
      finalVisibleTextCharacters: extractVisibleText(details.html).length,
      chapterSizeLimitBytes: input.maxChapterBytes,
      sizeLimitHit: false,
      textFallbackUsed: false,
      inlinedResourceCount: 0,
      inlinedResourceBytes: 0,
      omittedImageCount: 0,
      omittedCssAssetCount: 0,
      missingResourceCount: 0,
      missingStylesheetCount: 0,
      rewrittenHtmlImageCount: 0,
      rewrittenSvgImageCount: 0,
      unresolvedNamespacePrefixCount: 0,
    });
    return details;
  }

  const fetchStartedAt = Date.now();
  const fetched = await fetchBookPagesOrdered({
    client: input.client,
    kavitaChapterId,
    startPage,
    endPage,
    concurrency: 4,
  });
  const fetchDurationMs = Date.now() - fetchStartedAt;
  const pages = fetched.pages;

  const resourceCache: ResourceFetchCache = new Map();
  const rewriteStats = emptyResourceRewriteStats();
  const sourceHtml = pages.map((page) => page.html).join("");
  const sourceHtmlBytes = htmlByteLength(sourceHtml);
  const sourceVisibleText = extractVisibleText(sourceHtml);
  const projectedHtmlBytesBeforeBudget = estimateResourceFreeChapterBytes(
    input.chapter.title ?? `Chapter ${input.chapter.chapNum}`,
    pages,
  );
  const resourceBudget = createChapterResourceBudget(
    input.maxChapterBytes,
    projectedHtmlBytesBeforeBudget,
  );
  const transformStartedAt = Date.now();
  let html = await assembleHtmlChapter({
    title: input.chapter.title ?? `Chapter ${input.chapter.chapNum}`,
    pages,
    rewriteResources: async (fragment, pageNumber) =>
      rewriteAndTrackResources({
        fragment,
        pageNumber,
        maxResourceBytes: input.maxResourceBytes,
        maxChapterBytes: input.maxChapterBytes,
        kavitaChapterId,
        client: input.client,
        resourceCache,
        rewriteStats,
        resourceBudget,
      }),
  });
  const finalized = enforceCompletedHtmlLimit({
    html,
    maxChapterBytes: input.maxChapterBytes,
    sourceVisibleText,
  });
  html = finalized.html;
  const transformDurationMs = Date.now() - transformStartedAt;
  rewriteStats.sizeLimitHit ||= resourceBudget.sizeLimitHit || finalized.sizeLimitHit;
  rewriteStats.inlinedResourceCount = resourceBudget.inlinedResourceCount;
  rewriteStats.inlinedResourceBytes = resourceBudget.inlinedResourceBytes;
  rewriteStats.omittedImageCount = resourceBudget.omittedImageCount + finalized.omittedImageCount;
  rewriteStats.omittedCssAssetCount =
    resourceBudget.omittedCssAssetCount + finalized.omittedCssAssetCount;

  const details: HtmlChapterDetails = {
    id: input.chapter.chapterId,
    mangaId: input.chapter.sourceManga.mangaId,
    type: "html",
    html,
  };
  assertHtmlNovelDetails(details);
  logNovelDiagnostic({
    ...diagnosticBase,
    startPage,
    endPage: pages.at(-1)?.pageNumber ?? endPage,
    fetchedPageCount: pages.length,
    htmlBytes: htmlByteLength(details.html),
    visibleTextCharacters: sourceVisibleText.length,
    sourceHtmlBytes,
    sourceVisibleTextCharacters: sourceVisibleText.length,
    projectedHtmlBytesBeforeBudget,
    finalHtmlBytes: htmlByteLength(details.html),
    finalVisibleTextCharacters: extractVisibleText(details.html).length,
    chapterSizeLimitBytes: input.maxChapterBytes,
    sizeLimitHit: rewriteStats.sizeLimitHit,
    textFallbackUsed: false,
    inlinedResourceCount: rewriteStats.inlinedResourceCount,
    inlinedResourceBytes: rewriteStats.inlinedResourceBytes,
    omittedImageCount: rewriteStats.omittedImageCount,
    omittedCssAssetCount: rewriteStats.omittedCssAssetCount,
    missingResourceCount: rewriteStats.missingResourceCount,
    missingStylesheetCount: rewriteStats.missingStylesheetCount,
    rewrittenHtmlImageCount: rewriteStats.rewrittenHtmlImageCount,
    rewrittenSvgImageCount: rewriteStats.rewrittenSvgImageCount,
    unresolvedNamespacePrefixCount: countUnresolvedNamespacePrefixes(details.html),
  });
  logNovelRenderDiagnostic({
    build: input.build,
    physicalChapterId: kavitaChapterId,
    segmentIndex: diagnosticCount(info.segmentIndex),
    segmentCount: Math.max(1, diagnosticCount(info.segmentCount)),
    startPage,
    endPage: pages.at(-1)?.pageNumber ?? endPage,
    fetchedPageCount: pages.length,
    fetchConcurrency: fetched.concurrency,
    fetchDurationMs,
    transformDurationMs,
    sourceHtmlBytes,
    finalHtmlBytes: htmlByteLength(details.html),
    sourceVisibleTextCharacters: sourceVisibleText.length,
    finalVisibleTextCharacters: extractVisibleText(details.html).length,
    uniqueStylesheetCount: (details.html.match(/data-mutsuki-css="publisher"/gu) ?? []).length,
    duplicateStylesheetCount: 0,
    insertedSpineBreakCount: Math.max(0, pages.length - 1),
    injectedTitleCount: (details.html.match(/mutsuki-injected-title/gu) ?? []).length,
    omittedImageCount: rewriteStats.omittedImageCount,
    sizeLimitHit: rewriteStats.sizeLimitHit,
    semanticFallbackUsed: finalized.semanticFallbackUsed,
    plainTextFallbackUsed: false,
    debugLogging: input.debugLogging,
  });
  return details;
}

async function rewriteAndTrackResources(input: {
  fragment: string;
  pageNumber: number;
  maxResourceBytes: number;
  maxChapterBytes: number;
  kavitaChapterId: number;
  client: KavitaClient;
  resourceCache: ResourceFetchCache;
  rewriteStats: ResourceRewriteStats;
  resourceBudget: ChapterResourceBudget;
}): Promise<string> {
  const rewritten = await rewriteHtmlResources({
    html: input.fragment,
    basePath: `page-${input.pageNumber}.xhtml`,
    maxResourceBytes: input.maxResourceBytes,
    maxChapterBytes: input.maxChapterBytes,
    resourceCache: input.resourceCache,
    resourceBudget: input.resourceBudget,
    fetchResource: async (path) => input.client.getBookResource(input.kavitaChapterId, path),
  });
  mergeResourceRewriteStats(input.rewriteStats, rewritten.stats);
  return rewritten.html;
}

function estimateResourceFreeChapterBytes(title: string, pages: RawEpubPage[]): number {
  const strippedPages = pages.map((page) => stripResourceReferencesForBudget(page.html)).join("");
  return htmlByteLength(
    [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeXml(title)}</title>`,
      "<style>body{line-height:1.65;margin:0;padding:1rem;}img{max-width:100%;height:auto;}table{max-width:100%;}</style>",
      "</head>",
      "<body>",
      strippedPages,
      "</body>",
      "</html>",
    ].join(""),
  );
}

function stripResourceReferencesForBudget(html: string): string {
  return html
    .replace(/<link\b[^>]*\brel\s*=\s*(["'])[^"']*\bstylesheet\b[^"']*\1[^>]*>/giu, "")
    .replace(/@import\s+(?:url\(\s*)?(?:(["'])([^"']+)\1|([^"')\s;]+))\s*\)?[^;]*;/giu, "")
    .replace(/url\(\s*(["']?)(?!data:|#)([^"')]+)\1\s*\)/giu, "none")
    .replace(/<svg\b[\s\S]*?<\/svg>/giu, omittedIllustrationPlaceholder(""))
    .replace(/<img\b([^>]*)>/giu, (_match: string, attributes: string) => {
      const alt = extractAttribute(attributes, "alt") ?? "";
      return omittedIllustrationPlaceholder(alt);
    });
}

function enforceCompletedHtmlLimit(input: {
  html: string;
  maxChapterBytes: number;
  sourceVisibleText: string;
}): {
  html: string;
  sizeLimitHit: boolean;
  semanticFallbackUsed: boolean;
  omittedImageCount: number;
  omittedCssAssetCount: number;
} {
  let html = input.html;
  let sizeLimitHit = htmlByteLength(html) > input.maxChapterBytes;
  let semanticFallbackUsed = false;
  let omittedImageCount = 0;
  let omittedCssAssetCount = 0;

  if (sizeLimitHit) {
    const withoutCssDataUrls = html.replace(/url\(\s*(["'])data:[^"')]+\1\s*\)/giu, () => {
      omittedCssAssetCount += 1;
      return "none";
    });
    html = withoutCssDataUrls;
  }

  while (htmlByteLength(html) > input.maxChapterBytes) {
    const replaced = replaceLastDataImage(html, () => {
      omittedImageCount += 1;
    });
    if (replaced === html) break;
    html = replaced;
    sizeLimitHit = true;
  }

  if (htmlByteLength(html) > input.maxChapterBytes) {
    html = stripNonsemanticWeight(html);
    semanticFallbackUsed = true;
    sizeLimitHit = true;
  }

  if (
    htmlByteLength(html) > input.maxChapterBytes ||
    (input.sourceVisibleText.length > 0 && extractVisibleText(html).length === 0)
  ) {
    html = oversizedSemanticNotice();
    semanticFallbackUsed = true;
    sizeLimitHit = true;
  }

  return { html, sizeLimitHit, semanticFallbackUsed, omittedImageCount, omittedCssAssetCount };
}

function replaceLastDataImage(html: string, onReplace: () => void): string {
  const dataImagePattern = /<img\b(?=[^>]*\bsrc\s*=\s*(["'])data:image\/[\s\S]*?\1)[^>]*\/?>/giu;
  const matches = [...html.matchAll(dataImagePattern)];
  const match = matches.at(-1);
  if (match?.index === undefined) return html;
  const imageHtml = match[0];
  const alt = extractAttribute(imageHtml, "alt") ?? "";
  onReplace();
  return (
    html.slice(0, match.index) +
    omittedIllustrationPlaceholder(alt) +
    html.slice(match.index + imageHtml.length)
  );
}

function stripNonsemanticWeight(html: string): string {
  return html
    .replace(/\sstyle\s*=\s*(["'])(.*?)\1/giu, "")
    .replace(
      /\sclass\s*=\s*(["'])(?!mutsuki-spine-item|mutsuki-page-break|mutsuki-injected-title)(.*?)\1/giu,
      "",
    )
    .replace(/<style\b(?![^>]*data-mutsuki-css)[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<style\b[^>]*data-mutsuki-css="publisher"[^>]*>[\s\S]*?<\/style>/giu, "");
}

function oversizedSemanticNotice(): string {
  return [
    '<html xmlns="http://www.w3.org/1999/xhtml">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>EPUB too large</title>",
    "<style>body{line-height:1.65;margin:0;padding:1rem}p{margin:.75em 0}</style>",
    "</head>",
    "<body>",
    '<section class="mutsuki-epub-too-large">',
    "<h1>EPUB too large for Single Entry mode</h1>",
    "<p>This EPUB is too large to render as one formatted Paperback chapter.</p>",
    "<p>Enable Auto split oversized books in Mutsuki Kavita settings.</p>",
    "</section>",
    "</body>",
    "</html>",
  ].join("");
}

async function fetchBookPagesOrdered(input: {
  client: KavitaClient;
  kavitaChapterId: number;
  startPage: number;
  endPage: number;
  concurrency: number;
}): Promise<{ pages: RawEpubPage[]; concurrency: number }> {
  const concurrency = Math.min(6, Math.max(2, Math.floor(input.concurrency)));
  const pageNumbers = Array.from(
    { length: input.endPage - input.startPage + 1 },
    (_unused, index) => input.startPage + index,
  );
  const results = new Map<number, string>();
  let nextIndex = 0;
  let firstError: unknown;
  let trailingUnavailablePage: number | undefined;

  async function worker(): Promise<void> {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      const page = pageNumbers[index];
      if (page === undefined) return;

      try {
        results.set(page, await input.client.getBookPage(input.kavitaChapterId, page));
      } catch (error) {
        if (
          page === input.endPage &&
          page > input.startPage &&
          isTrailingUnavailableBookPage(error)
        ) {
          trailingUnavailablePage = page;
          return;
        }
        firstError = error;
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pageNumbers.length) }, () => worker()),
  );
  if (firstError !== undefined) throw firstError;

  const effectiveEndPage =
    trailingUnavailablePage === undefined ? input.endPage : input.endPage - 1;
  return {
    concurrency,
    pages: pageNumbers
      .filter((page) => page <= effectiveEndPage)
      .map((page) => ({ pageNumber: page, html: results.get(page) ?? "" })),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function numberField(item: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function safeIntegerValue(value: unknown, label: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid Kavita EPUB ${label}.`);
  return parsed;
}

function diagnosticInteger(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function diagnosticCount(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safePositivePageCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid Kavita EPUB page count.");
  }
  return value;
}

function clampPageRange(input: { startPage: number; endPage: number; totalPages: number }): {
  startPage: number;
  endPage: number;
} {
  const lastPage = input.totalPages - 1;
  const startPage = clamp(input.startPage, 0, lastPage);
  const requestedEndPage = Math.max(input.startPage, input.endPage);
  const endPage = Math.max(startPage, clamp(requestedEndPage, 0, lastPage));
  return { startPage, endPage };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function wrapPlainTextAsXhtml(text: string): string {
  return (
    '<html xmlns="http://www.w3.org/1999/xhtml">' +
    "<head></head>" +
    `<body><p>${escapeXml(text)}</p></body>` +
    "</html>"
  );
}

function extractVisibleText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/giu, " ")
      .replace(/<iframe\b[\s\S]*?<\/iframe>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const value = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    if (lower.startsWith("#")) {
      const value = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[lower] ?? entity;
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function extractAttribute(html: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${escapeRegex(name)}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(html);
  return match?.[2];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertHtmlNovelDetails(details: ChapterDetails): asserts details is HtmlChapterDetails {
  const record = details as Record<string, unknown>;
  if (record.type !== "html") throw new Error("Invalid Kavita EPUB details type.");
  if (typeof record.html !== "string" || record.html.length === 0) {
    throw new Error("Invalid Kavita EPUB HTML details.");
  }
  if ("pages" in record) throw new Error("Invalid Kavita EPUB details include pages.");
}

function htmlByteLength(html: string): number {
  return new TextEncoder().encode(html).byteLength;
}

function emptyResourceRewriteStats(): ResourceRewriteStats {
  return {
    missingResourceCount: 0,
    missingStylesheetCount: 0,
    rewrittenHtmlImageCount: 0,
    rewrittenSvgImageCount: 0,
    unresolvedNamespacePrefixCount: 0,
    sizeLimitHit: false,
    inlinedResourceCount: 0,
    inlinedResourceBytes: 0,
    omittedImageCount: 0,
    omittedCssAssetCount: 0,
  };
}

function mergeResourceRewriteStats(
  target: ResourceRewriteStats,
  source: ResourceRewriteStats,
): void {
  target.missingResourceCount += source.missingResourceCount;
  target.missingStylesheetCount += source.missingStylesheetCount;
  target.rewrittenHtmlImageCount += source.rewrittenHtmlImageCount;
  target.rewrittenSvgImageCount += source.rewrittenSvgImageCount;
  target.unresolvedNamespacePrefixCount += source.unresolvedNamespacePrefixCount;
  target.sizeLimitHit ||= source.sizeLimitHit;
  target.inlinedResourceCount += source.inlinedResourceCount;
  target.inlinedResourceBytes += source.inlinedResourceBytes;
  target.omittedImageCount += source.omittedImageCount;
  target.omittedCssAssetCount += source.omittedCssAssetCount;
}

function countUnresolvedNamespacePrefixes(html: string): number {
  return html.match(/\b(?:epub|xlink):[\w-]+/giu)?.length ?? 0;
}

function isTrailingUnavailableBookPage(error: unknown): boolean {
  return (
    error instanceof KavitaRequestError &&
    error.status === 400 &&
    /\/Book\/\d+\/book-page$/u.test(error.path) &&
    /could not find the appropriate html for that page/iu.test(error.responseMessage)
  );
}

function logNovelRenderDiagnostic(input: {
  build: string;
  physicalChapterId: number;
  segmentIndex: number;
  segmentCount: number;
  startPage: number;
  endPage: number;
  fetchedPageCount: number;
  fetchConcurrency: number;
  fetchDurationMs: number;
  transformDurationMs: number;
  sourceHtmlBytes: number;
  finalHtmlBytes: number;
  sourceVisibleTextCharacters: number;
  finalVisibleTextCharacters: number;
  uniqueStylesheetCount: number;
  duplicateStylesheetCount: number;
  insertedSpineBreakCount: number;
  injectedTitleCount: number;
  omittedImageCount: number;
  sizeLimitHit: boolean;
  semanticFallbackUsed: boolean;
  plainTextFallbackUsed: boolean;
  debugLogging: boolean;
}): void {
  if (!input.debugLogging) return;
  console.log(
    [
      "[MutsukiNovelRender]",
      `build=${input.build}`,
      `physicalChapterId=${input.physicalChapterId}`,
      `segmentIndex=${input.segmentIndex}`,
      `segmentCount=${input.segmentCount}`,
      `startPage=${input.startPage}`,
      `endPage=${input.endPage}`,
      `fetchedPageCount=${input.fetchedPageCount}`,
      `fetchConcurrency=${input.fetchConcurrency}`,
      `fetchDurationMs=${input.fetchDurationMs}`,
      `transformDurationMs=${input.transformDurationMs}`,
      `sourceHtmlBytes=${input.sourceHtmlBytes}`,
      `finalHtmlBytes=${input.finalHtmlBytes}`,
      `sourceVisibleTextCharacters=${input.sourceVisibleTextCharacters}`,
      `finalVisibleTextCharacters=${input.finalVisibleTextCharacters}`,
      `uniqueStylesheetCount=${input.uniqueStylesheetCount}`,
      `duplicateStylesheetCount=${input.duplicateStylesheetCount}`,
      `insertedSpineBreakCount=${input.insertedSpineBreakCount}`,
      `injectedTitleCount=${input.injectedTitleCount}`,
      `omittedImageCount=${input.omittedImageCount}`,
      `sizeLimitHit=${input.sizeLimitHit}`,
      `semanticFallbackUsed=${input.semanticFallbackUsed}`,
      `plainTextFallbackUsed=${input.plainTextFallbackUsed}`,
    ].join(" "),
  );
}

function logNovelDiagnostic(input: {
  build: string;
  mode: NovelRenderingMode;
  seriesId: number;
  chapterId: string;
  incomingContentType: string | undefined;
  resolvedContentType: string | undefined;
  kavitaFormat: string | undefined;
  startPage: number;
  endPage: number;
  fetchedPageCount: number;
  htmlBytes: number;
  visibleTextCharacters: number;
  sourceHtmlBytes: number;
  sourceVisibleTextCharacters: number;
  projectedHtmlBytesBeforeBudget: number;
  finalHtmlBytes: number;
  finalVisibleTextCharacters: number;
  chapterSizeLimitBytes: number;
  sizeLimitHit: boolean;
  textFallbackUsed: boolean;
  inlinedResourceCount: number;
  inlinedResourceBytes: number;
  omittedImageCount: number;
  omittedCssAssetCount: number;
  missingResourceCount: number;
  missingStylesheetCount: number;
  rewrittenHtmlImageCount: number;
  rewrittenSvgImageCount: number;
  unresolvedNamespacePrefixCount: number;
  structuralTocEntriesFiltered: number;
  parsedWordChapterNumberCount: number;
  debugLogging: boolean;
}): void {
  if (!input.debugLogging) return;
  console.log(
    [
      "[MutsukiNovel]",
      `build=${input.build}`,
      `mode=${novelRenderingModeDiagnosticName(input.mode)}`,
      `seriesId=${input.seriesId}`,
      `chapterId=${input.chapterId}`,
      `incomingContentType=${input.incomingContentType ?? ""}`,
      `resolvedContentType=${input.resolvedContentType ?? ""}`,
      `kavitaFormat=${input.kavitaFormat ?? ""}`,
      "detailsType=html",
      `startPage=${input.startPage}`,
      `endPage=${input.endPage}`,
      `fetchedPageCount=${input.fetchedPageCount}`,
      `htmlBytes=${input.htmlBytes}`,
      `visibleTextCharacters=${input.visibleTextCharacters}`,
      `sourceHtmlBytes=${input.sourceHtmlBytes}`,
      `sourceVisibleTextCharacters=${input.sourceVisibleTextCharacters}`,
      `projectedHtmlBytesBeforeBudget=${input.projectedHtmlBytesBeforeBudget}`,
      `finalHtmlBytes=${input.finalHtmlBytes}`,
      `finalVisibleTextCharacters=${input.finalVisibleTextCharacters}`,
      `chapterSizeLimitBytes=${input.chapterSizeLimitBytes}`,
      `sizeLimitHit=${input.sizeLimitHit}`,
      `textFallbackUsed=${input.textFallbackUsed}`,
      `inlinedResourceCount=${input.inlinedResourceCount}`,
      `inlinedResourceBytes=${input.inlinedResourceBytes}`,
      `omittedImageCount=${input.omittedImageCount}`,
      `omittedCssAssetCount=${input.omittedCssAssetCount}`,
      `missingResourceCount=${input.missingResourceCount}`,
      `missingStylesheetCount=${input.missingStylesheetCount}`,
      `rewrittenHtmlImageCount=${input.rewrittenHtmlImageCount}`,
      `rewrittenSvgImageCount=${input.rewrittenSvgImageCount}`,
      `unresolvedNamespacePrefixCount=${input.unresolvedNamespacePrefixCount}`,
      `structuralTocEntriesFiltered=${input.structuralTocEntriesFiltered}`,
      `parsedWordChapterNumberCount=${input.parsedWordChapterNumberCount}`,
    ].join(" "),
  );
}
