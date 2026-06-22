import type { LargeEpubHandling } from "./large-epub-handling.js";
import type { KavitaTocItem, NovelReadingUnit } from "./models.js";
import { classifyNovelTocTitle } from "./toc-classifier.js";
import { buildWholeBookChapterId } from "./toc.js";

export interface NovelReadingPlan {
  physicalChapterId: number;
  totalPages: number;
  largeBookHandling: LargeEpubHandling;
  autoSplitTriggered: boolean;
  topLevelBoundaryCount: number;
  segmentCount: number;
  largestSegmentPageCount: number;
  smallestSegmentPageCount: number;
  frontMatterSegmentCount: number;
  units: NovelReadingUnit[];
}

export interface NovelReadingPlanInput {
  physicalChapterId: number;
  physicalVolumeId?: number;
  physicalVolumeNumber?: number;
  title?: string;
  totalPages: number;
  toc: KavitaTocItem[];
  largeBookHandling: LargeEpubHandling;
  targetPagesPerPart: number;
  hardMaxPagesPerPart?: number;
}

interface CandidateRange {
  title: string;
  startPage: number;
  endPage: number;
  role: NovelReadingUnit["role"];
  sourceTocPath: string[];
  descendantPages: number[];
}

interface RawUnit {
  title: string;
  startPage: number;
  endPage: number;
  role: NovelReadingUnit["role"];
  sourceTocPath: string[];
}

export function shouldAutoSplitLargeEpub(
  totalPages: number,
  largeBookHandling: LargeEpubHandling,
): boolean {
  return largeBookHandling === "auto-split" && Number.isFinite(totalPages) && totalPages > 256;
}

export function buildSegmentChapterId(input: {
  physicalChapterId: number;
  startPage: number;
  endPage: number;
  segmentIndex: number;
  isLastInPhysicalBook: boolean;
}): string {
  return `kavita-book:${input.physicalChapterId}:segment:v1:page:${input.startPage}:end:${
    input.endPage
  }:index:${input.segmentIndex}:last:${input.isLastInPhysicalBook ? 1 : 0}`;
}

export function planNovelReadingUnits(input: NovelReadingPlanInput): NovelReadingPlan {
  const totalPages = Math.max(1, Math.floor(input.totalPages));
  const finalPage = totalPages - 1;
  const targetPages = clampInteger(input.targetPagesPerPart, 32, 256, 96);
  const hardMaxPages = clampInteger(
    input.hardMaxPagesPerPart ?? Math.ceil((targetPages * 4) / 3),
    targetPages,
    512,
    Math.ceil((targetPages * 4) / 3),
  );
  const topLevelRanges = preferredTopLevelRanges(input.toc, finalPage);
  const autoSplitTriggered = shouldAutoSplitLargeEpub(totalPages, input.largeBookHandling);

  if (!autoSplitTriggered) {
    const title = input.title?.trim() || "Book";
    const units = finalizeUnits(
      [
        {
          title,
          startPage: 0,
          endPage: finalPage,
          role: "narrative",
          sourceTocPath: [title],
        },
      ],
      input,
    );
    return summarizePlan(input, totalPages, false, topLevelRanges.length, units);
  }

  const ranges =
    topLevelRanges.length > 0
      ? rangesWithFrontMatter(topLevelRanges, finalPage)
      : [
          {
            title: input.title?.trim() || "Book",
            startPage: 0,
            endPage: finalPage,
            role: "narrative" as const,
            sourceTocPath: [input.title?.trim() || "Book"],
            descendantPages: [],
          },
        ];

  const rawUnits = ranges.flatMap((range) => splitRange(range, targetPages, hardMaxPages));
  const units = finalizeUnits(rawUnits, input);
  return summarizePlan(input, totalPages, true, topLevelRanges.length, units);
}

function preferredTopLevelRanges(toc: KavitaTocItem[], finalPage: number): CandidateRange[] {
  const boundaries = toc
    .filter(
      (item) => isPageInRange(item.page, finalPage) && isPreferredTopLevelBoundary(item.title),
    )
    .sort((a, b) => a.page - b.page);

  const topLevel = boundaries.map((item, index, items): CandidateRange => {
    const next = items[index + 1];
    return {
      title: item.title.trim(),
      startPage: item.page,
      endPage: next ? Math.max(item.page, next.page - 1) : finalPage,
      role: roleFromTitle(item.title),
      sourceTocPath: [item.title.trim()],
      descendantPages: flattenDescendantPages(item, finalPage),
    };
  });

  return topLevel.filter((range) => range.startPage <= range.endPage);
}

function rangesWithFrontMatter(ranges: CandidateRange[], finalPage: number): CandidateRange[] {
  const output: CandidateRange[] = [];
  const first = ranges[0];
  if (first && first.startPage > 0) {
    output.push({
      title: "Front Matter",
      startPage: 0,
      endPage: first.startPage - 1,
      role: "frontmatter",
      sourceTocPath: ["Front Matter"],
      descendantPages: [],
    });
  }
  output.push(...ranges);

  const last = ranges.at(-1);
  if (last && last.endPage < finalPage) {
    output.push({
      title: "Back Matter",
      startPage: last.endPage + 1,
      endPage: finalPage,
      role: "special",
      sourceTocPath: ["Back Matter"],
      descendantPages: [],
    });
  }
  return output;
}

function splitRange(range: CandidateRange, targetPages: number, hardMaxPages: number): RawUnit[] {
  const pageCount = range.endPage - range.startPage + 1;
  if (pageCount <= hardMaxPages) return [range];

  const boundaries = uniqueSorted(
    range.descendantPages.filter((page) => page > range.startPage && page <= range.endPage),
  );
  const units: RawUnit[] = [];
  let startPage = range.startPage;

  while (startPage <= range.endPage) {
    const targetEnd = Math.min(range.endPage, startPage + targetPages - 1);
    const hardEnd = Math.min(range.endPage, startPage + hardMaxPages - 1);
    const boundary =
      lastAtOrBefore(boundaries, targetEnd + 1, startPage) ??
      lastAtOrBefore(boundaries, hardEnd + 1, startPage);
    const nextStart =
      boundary !== undefined && boundary <= hardEnd + 1
        ? boundary
        : Math.min(range.endPage + 1, startPage + targetPages);
    const endPage = Math.max(startPage, Math.min(range.endPage, nextStart - 1));
    units.push({
      title: range.title,
      startPage,
      endPage,
      role: range.role,
      sourceTocPath: range.sourceTocPath,
    });
    startPage = endPage + 1;
  }

  if (units.length <= 1) return units;
  return units.map((unit, index) => ({
    ...unit,
    title: `${unit.title} - Part ${index + 1} of ${units.length}`,
  }));
}

function finalizeUnits(rawUnits: RawUnit[], input: NovelReadingPlanInput): NovelReadingUnit[] {
  const segmentCount = rawUnits.length;
  return rawUnits.map((unit, index) => {
    const isLastInPhysicalBook = index === segmentCount - 1;
    return {
      id:
        segmentCount === 1 && unit.startPage === 0 && unit.endPage === input.totalPages - 1
          ? buildWholeBookChapterId(input.physicalChapterId)
          : buildSegmentChapterId({
              physicalChapterId: input.physicalChapterId,
              startPage: unit.startPage,
              endPage: unit.endPage,
              segmentIndex: index,
              isLastInPhysicalBook,
            }),
      physicalChapterId: input.physicalChapterId,
      physicalVolumeId: input.physicalVolumeId,
      physicalVolumeNumber: input.physicalVolumeNumber,
      startPage: unit.startPage,
      endPage: unit.endPage,
      segmentIndex: index,
      segmentCount,
      title: unit.title,
      role: unit.role,
      isLastInPhysicalBook,
      sourceTocPath: unit.sourceTocPath,
    };
  });
}

function summarizePlan(
  input: NovelReadingPlanInput,
  totalPages: number,
  autoSplitTriggered: boolean,
  topLevelBoundaryCount: number,
  units: NovelReadingUnit[],
): NovelReadingPlan {
  const pageCounts = units.map((unit) => unit.endPage - unit.startPage + 1);
  return {
    physicalChapterId: input.physicalChapterId,
    totalPages,
    largeBookHandling: input.largeBookHandling,
    autoSplitTriggered,
    topLevelBoundaryCount,
    segmentCount: units.length,
    largestSegmentPageCount: Math.max(...pageCounts),
    smallestSegmentPageCount: Math.min(...pageCounts),
    frontMatterSegmentCount: units.filter((unit) => unit.role === "frontmatter").length,
    units,
  };
}

function isPreferredTopLevelBoundary(title: string): boolean {
  return /^\s*(?:book|part|volume|vol\.?)\s+(?:\d+(?:\.\d+)?|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu.test(
    title,
  );
}

function roleFromTitle(title: string): NovelReadingUnit["role"] {
  const role = classifyNovelTocTitle(title);
  if (role === "frontmatter") return "frontmatter";
  if (role === "readable-special" || role === "publisher-backmatter") return "special";
  return "narrative";
}

function flattenDescendantPages(item: KavitaTocItem, finalPage: number): number[] {
  const pages: number[] = [];
  const visit = (children: KavitaTocItem[] | undefined): void => {
    for (const child of children ?? []) {
      if (
        isPageInRange(child.page, finalPage) &&
        classifyNovelTocTitle(child.title) !== "structural"
      ) {
        pages.push(child.page);
      }
      visit(child.children);
    }
  };
  visit(item.children);
  return pages;
}

function isPageInRange(page: number, finalPage: number): boolean {
  return Number.isInteger(page) && page >= 0 && page <= finalPage;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function lastAtOrBefore(
  values: number[],
  maxValue: number,
  minExclusive: number,
): number | undefined {
  let candidate: number | undefined;
  for (const value of values) {
    if (value <= minExclusive) continue;
    if (value > maxValue) break;
    candidate = value;
  }
  return candidate;
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
