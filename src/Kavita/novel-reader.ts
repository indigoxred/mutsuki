import type { Chapter, ChapterDetails, SourceManga } from "@paperback/types";

import { assembleHtmlChapter } from "./html-assembler.js";
import type { KavitaClient } from "./client.js";
import { novelChapterToPaperback } from "./chapter-mapper.js";
import {
  novelRenderingModeDiagnosticName,
  type NovelRenderingMode,
} from "./novel-rendering-mode.js";
import {
  rewriteHtmlResources,
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
  totalPages: number;
}): Promise<Chapter[]> {
  if (!Number.isFinite(input.totalPages) || input.totalPages < 1) return [];

  const toc = await input.client.getBookChapters(input.kavitaChapterId);
  return logicalChaptersFromToc({
    kavitaSeriesId: input.kavitaSeriesId,
    kavitaVolumeId: input.kavitaVolumeId,
    kavitaChapterId: input.kavitaChapterId,
    volumeNumber: input.volumeNumber,
    totalPages: input.totalPages,
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
      missingResourceCount: 0,
      missingStylesheetCount: 0,
      rewrittenHtmlImageCount: 0,
      rewrittenSvgImageCount: 0,
      unresolvedNamespacePrefixCount: 0,
    });
    return details;
  }

  const pages: string[] = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(await input.client.getBookPage(kavitaChapterId, page));
  }

  const resourceCache: ResourceFetchCache = new Map();
  const rewriteStats = emptyResourceRewriteStats();
  const html = await assembleHtmlChapter({
    title: input.chapter.title ?? `Chapter ${input.chapter.chapNum}`,
    pages,
    rewriteResources: async (fragment) =>
      rewriteAndTrackResources({
        fragment,
        startPage,
        maxResourceBytes: input.maxResourceBytes,
        maxChapterBytes: input.maxChapterBytes,
        kavitaChapterId,
        client: input.client,
        resourceCache,
        rewriteStats,
      }),
  });

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
    endPage,
    fetchedPageCount: pages.length,
    htmlBytes: htmlByteLength(details.html),
    visibleTextCharacters: extractVisibleText(pages.join(" ")).length,
    missingResourceCount: rewriteStats.missingResourceCount,
    missingStylesheetCount: rewriteStats.missingStylesheetCount,
    rewrittenHtmlImageCount: rewriteStats.rewrittenHtmlImageCount,
    rewrittenSvgImageCount: rewriteStats.rewrittenSvgImageCount,
    unresolvedNamespacePrefixCount: countUnresolvedNamespacePrefixes(details.html),
  });
  return details;
}

async function rewriteAndTrackResources(input: {
  fragment: string;
  startPage: number;
  maxResourceBytes: number;
  maxChapterBytes: number;
  kavitaChapterId: number;
  client: KavitaClient;
  resourceCache: ResourceFetchCache;
  rewriteStats: ResourceRewriteStats;
}): Promise<string> {
  const rewritten = await rewriteHtmlResources({
    html: input.fragment,
    basePath: `page-${input.startPage}.xhtml`,
    maxResourceBytes: input.maxResourceBytes,
    maxChapterBytes: input.maxChapterBytes,
    resourceCache: input.resourceCache,
    fetchResource: async (path) => input.client.getBookResource(input.kavitaChapterId, path),
  });
  mergeResourceRewriteStats(input.rewriteStats, rewritten.stats);
  return rewritten.html;
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
}

function countUnresolvedNamespacePrefixes(html: string): number {
  return html.match(/\b(?:epub|xlink):[\w-]+/giu)?.length ?? 0;
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
