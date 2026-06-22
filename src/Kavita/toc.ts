import { parseChapterNumber } from "../shared/numbers.js";
import type { KavitaTocItem, MutsukiLogicalChapter, NovelTocRole } from "./models.js";
import {
  classifyNovelTocTitle,
  isNovelTocRoleSpecial,
  novelTocRolePriority,
} from "./toc-classifier.js";

export interface LogicalChapterInput {
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  volumeNumber?: number;
  fallbackTitle?: string;
  totalPages: number;
  toc: KavitaTocItem[];
  includePublisherExtras?: boolean;
  listingMode?: "internal-chapters";
}

interface FlatTocItem {
  title: string;
  page: number;
  tocPath: string[];
  part?: string;
  traversalIndex: number;
}

interface RangedTocItem {
  item: FlatTocItem;
  role: NovelTocRole;
  startPage: number;
  endPage: number;
}

interface TocCounts {
  structuralFiltered: number;
  publisherFiltered: number;
  frontmatterCount: number;
  specialCount: number;
  narrativeCount: number;
  parsedWordChapterNumberCount: number;
}

const KAVITA_SENTINEL_READING_NUMBER = 10000;
const SENTINEL_TITLE_PATTERN = /^(?:chapter|volume|vol\.?|ch\.?)?\s*-?\d+(?:\.0+)?$/iu;

export function flattenKavitaToc(toc: KavitaTocItem[], totalPages: number): FlatTocItem[] {
  const flattened: FlatTocItem[] = [];
  let traversalIndex = 0;

  const visit = (item: KavitaTocItem, parents: string[]): void => {
    const title = item.title.trim() || `Page ${item.page}`;
    const tocPath = [...parents, title];
    const part = stringValue(item.part ?? item.anchor ?? item.href);
    if (Number.isInteger(item.page) && item.page >= 0 && item.page < totalPages) {
      flattened.push({ title, page: item.page, tocPath, part, traversalIndex });
      traversalIndex += 1;
    }
    for (const child of item.children ?? []) {
      visit(child, tocPath);
    }
  };

  for (const item of toc) {
    visit(item, []);
  }

  return flattened.sort((a, b) => a.page - b.page || a.traversalIndex - b.traversalIndex);
}

export function logicalChaptersFromToc(input: LogicalChapterInput): MutsukiLogicalChapter[] {
  const totalPages = Math.max(1, input.totalPages);
  const finalPage = totalPages - 1;
  const flat = flattenKavitaToc(input.toc, totalPages);
  const ranged = rangeTocItems(flat, finalPage);
  const counts = countTocRoles(ranged, Boolean(input.includePublisherExtras));
  const exposed = selectExposedTocItems(ranged, Boolean(input.includePublisherExtras));

  if (exposed.length === 0) {
    return [fallbackPhysicalVolumeChapter(input, finalPage, counts)];
  }

  let narrativeFallbackNumber = 0;
  const chapters: MutsukiLogicalChapter[] = exposed.map(({ item, role, startPage, endPage }) => {
    const parsed = validChapterNumber(item.title);
    const fallbackNumber = nextFallbackNumber({
      parsed,
      role,
      narrativeFallbackNumber,
    });
    narrativeFallbackNumber = fallbackNumber.narrativeFallbackNumber;
    return {
      kavitaSeriesId: input.kavitaSeriesId,
      kavitaVolumeId: input.kavitaVolumeId,
      kavitaChapterId: input.kavitaChapterId,
      title: normalizedTocTitle(item.title, fallbackNumber.chapterNumber, parsed),
      tocPath: item.tocPath,
      startPage,
      endPage,
      part: item.part,
      chapterNumber: fallbackNumber.chapterNumber,
      volumeNumber: input.volumeNumber,
      isSpecial: isNovelTocRoleSpecial(role),
      role,
      isLastInVolume: false,
      structuralTocEntriesFiltered: counts.structuralFiltered,
      publisherTocEntriesFiltered: counts.publisherFiltered,
      frontmatterTocEntries: counts.frontmatterCount,
      readableSpecialTocEntries: counts.specialCount,
      narrativeTocEntries: counts.narrativeCount,
      parsedWordChapterNumberCount: counts.parsedWordChapterNumberCount,
    };
  });

  const lastReadable = chapters.at(-1);
  if (lastReadable) lastReadable.isLastInVolume = true;
  return chapters;
}

export function summarizeNovelToc(input: {
  toc: KavitaTocItem[];
  totalPages: number;
  includePublisherExtras?: boolean;
}): TocCounts & { rawTocCount: number } {
  const flat = flattenKavitaToc(input.toc, Math.max(1, input.totalPages));
  return {
    rawTocCount: flat.length,
    ...countTocRoles(
      rangeTocItems(flat, Math.max(0, input.totalPages - 1)),
      Boolean(input.includePublisherExtras),
    ),
  };
}

function rangeTocItems(flat: FlatTocItem[], finalPage: number): RangedTocItem[] {
  return flat.map((item, index) => {
    const nextDistinctPage = flat.slice(index + 1).find((candidate) => candidate.page > item.page);
    return {
      item,
      role: classifyNovelTocTitle(item.title),
      startPage: item.page,
      endPage: nextDistinctPage ? Math.max(item.page, nextDistinctPage.page - 1) : finalPage,
    };
  });
}

function selectExposedTocItems(
  ranged: RangedTocItem[],
  includePublisherExtras: boolean,
): RangedTocItem[] {
  const selected: RangedTocItem[] = [];

  for (const item of ranged) {
    if (item.role === "structural") continue;
    if (item.role === "publisher-backmatter" && !includePublisherExtras) continue;

    const duplicateIndex =
      item.item.part === undefined
        ? selected.findIndex(
            (candidate) =>
              candidate.item.part === undefined &&
              candidate.startPage === item.startPage &&
              candidate.endPage === item.endPage,
          )
        : -1;

    if (duplicateIndex >= 0) {
      const existing = selected[duplicateIndex];
      if (existing && novelTocRolePriority(item.role) > novelTocRolePriority(existing.role)) {
        selected[duplicateIndex] = item;
      }
      continue;
    }

    selected.push(item);
  }

  return selected;
}

function countTocRoles(ranged: RangedTocItem[], includePublisherExtras: boolean): TocCounts {
  return {
    structuralFiltered: ranged.filter((item) => item.role === "structural").length,
    publisherFiltered: includePublisherExtras
      ? 0
      : ranged.filter((item) => item.role === "publisher-backmatter").length,
    frontmatterCount: ranged.filter((item) => item.role === "frontmatter").length,
    specialCount: ranged.filter((item) => item.role === "readable-special").length,
    narrativeCount: ranged.filter((item) => item.role === "narrative").length,
    parsedWordChapterNumberCount: ranged.filter(({ item }) =>
      hasParsedWordChapterNumber(item.title),
    ).length,
  };
}

function fallbackPhysicalVolumeChapter(
  input: LogicalChapterInput,
  finalPage: number,
  counts: TocCounts,
): MutsukiLogicalChapter {
  const title =
    input.fallbackTitle?.trim() ||
    (input.volumeNumber === undefined ? "Book" : `Volume ${Number(input.volumeNumber).toString()}`);
  return {
    kavitaSeriesId: input.kavitaSeriesId,
    kavitaVolumeId: input.kavitaVolumeId,
    kavitaChapterId: input.kavitaChapterId,
    title,
    tocPath: [title],
    startPage: 0,
    endPage: finalPage,
    chapterNumber: 1,
    volumeNumber: input.volumeNumber,
    isSpecial: false,
    role: "narrative",
    isLastInVolume: true,
    structuralTocEntriesFiltered: counts.structuralFiltered,
    publisherTocEntriesFiltered: counts.publisherFiltered,
    frontmatterTocEntries: counts.frontmatterCount,
    readableSpecialTocEntries: counts.specialCount,
    narrativeTocEntries: counts.narrativeCount,
    parsedWordChapterNumberCount: counts.parsedWordChapterNumberCount,
  };
}

function nextFallbackNumber(input: {
  parsed: number | undefined;
  role: NovelTocRole;
  narrativeFallbackNumber: number;
}): { chapterNumber: number; narrativeFallbackNumber: number } {
  if (input.parsed !== undefined) {
    const parsedInteger = Number.isInteger(input.parsed) ? input.parsed : Math.floor(input.parsed);
    return {
      chapterNumber: input.parsed,
      narrativeFallbackNumber:
        input.role === "narrative"
          ? Math.max(input.narrativeFallbackNumber, parsedInteger)
          : input.narrativeFallbackNumber,
    };
  }

  if (input.role !== "narrative") {
    return {
      chapterNumber: 0,
      narrativeFallbackNumber: input.narrativeFallbackNumber,
    };
  }

  const narrativeFallbackNumber = input.narrativeFallbackNumber + 1;
  return { chapterNumber: narrativeFallbackNumber, narrativeFallbackNumber };
}

function validChapterNumber(title: string): number | undefined {
  const parsed = parseChapterNumber(title)?.value;
  if (parsed === undefined || parsed >= KAVITA_SENTINEL_READING_NUMBER) return undefined;
  return parsed;
}

function hasParsedWordChapterNumber(title: string): boolean {
  if (validChapterNumber(title) === undefined) return false;
  return /\b(?:chapter|ch\.?)\s+[a-z]+(?:[-\s]+[a-z]+)?/iu.test(title);
}

function normalizedTocTitle(
  title: string,
  fallbackNumber: number,
  parsedChapterNumber: number | undefined,
): string | undefined {
  const trimmed = title.trim();
  if (SENTINEL_TITLE_PATTERN.test(trimmed) && validChapterNumber(trimmed) === undefined) {
    return undefinedIfRedundant(`Chapter ${fallbackNumber}`, fallbackNumber);
  }
  if (parsedChapterNumber === undefined) return trimmed;
  const withoutPrefix = stripChapterPrefix(trimmed);
  return undefinedIfRedundant(withoutPrefix, parsedChapterNumber);
}

function stripChapterPrefix(title: string): string {
  return title
    .replace(
      /^\s*(?:chapter|ch\.?)\s+(?:\d+(?:\.\d+)?|[ivxlcdm]+|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(?:one|two|three|four|five|six|seven|eight|nine))?)\s*(?::|-)?\s*/iu,
      "",
    )
    .trim();
}

function undefinedIfRedundant(title: string, chapterNumber: number): string | undefined {
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  if (/^chapter\s+\d+(?:\.0+)?$/iu.test(trimmed)) return undefined;
  if (Number.isInteger(chapterNumber) && trimmed === String(chapterNumber)) return undefined;
  return trimmed;
}

export function buildEpubChapterId(input: {
  physicalChapterId: number;
  startPage: number;
  endPage: number;
  isLastInVolume: boolean;
  part?: string;
}): string {
  const part = input.part === undefined ? "" : `:part:${encodeURIComponent(input.part)}`;
  return `kavita-book:${input.physicalChapterId}:toc:v1:page:${input.startPage}:end:${
    input.endPage
  }${part}:last:${input.isLastInVolume ? 1 : 0}`;
}

export function buildWholeBookChapterId(physicalChapterId: number): string {
  return `kavita-book:${physicalChapterId}:whole:v1`;
}

export function parseFinalInVolumeFromChapterId(chapterId: string | undefined): boolean {
  return /:last:1$/u.test(chapterId ?? "") || /:whole:v1$/u.test(chapterId ?? "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
