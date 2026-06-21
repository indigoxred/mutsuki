import { classifySpecialTitle, parseChapterNumber } from "../shared/numbers.js";
import type { KavitaTocItem, MutsukiLogicalChapter } from "./models.js";

export interface LogicalChapterInput {
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  volumeNumber?: number;
  fallbackTitle?: string;
  totalPages: number;
  toc: KavitaTocItem[];
}

interface FlatTocItem {
  title: string;
  page: number;
  tocPath: string[];
}

const KAVITA_SENTINEL_READING_NUMBER = 10000;
const SENTINEL_TITLE_PATTERN = /^(?:chapter|volume|vol\.?|ch\.?)?\s*-?\d+(?:\.0+)?$/iu;
const STRUCTURAL_TITLE_PATTERN =
  /^(?:navigation|cover|contents|table\s+of\s+contents|title\s+page|copyright|colophon|newsletter)$/iu;

export function flattenKavitaToc(toc: KavitaTocItem[], totalPages: number): FlatTocItem[] {
  const flattened: FlatTocItem[] = [];

  const visit = (item: KavitaTocItem, parents: string[]): void => {
    const title = item.title.trim() || `Page ${item.page}`;
    const tocPath = [...parents, title];
    if (Number.isInteger(item.page) && item.page >= 0 && item.page < totalPages) {
      flattened.push({ title, page: item.page, tocPath });
    }
    for (const child of item.children ?? []) {
      visit(child, tocPath);
    }
  };

  for (const item of toc) {
    visit(item, []);
  }

  const byPage = new Map<number, FlatTocItem>();
  for (const item of flattened.sort((a, b) => a.page - b.page)) {
    if (!byPage.has(item.page)) {
      byPage.set(item.page, item);
    }
  }

  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

export function logicalChaptersFromToc(input: LogicalChapterInput): MutsukiLogicalChapter[] {
  const totalPages = Math.max(1, input.totalPages);
  const finalPage = totalPages - 1;
  const flat = flattenKavitaToc(input.toc, totalPages);

  if (flat.length === 0) {
    return [fallbackPhysicalVolumeChapter(input, finalPage, 0, 0)];
  }

  const ranged = flat.map((item, index) => {
    const next = flat[index + 1];
    return {
      item,
      startPage: item.page,
      endPage: next ? Math.max(item.page, next.page - 1) : finalPage,
    };
  });
  const exposed = ranged.filter(({ item }) => !isStructuralTocTitle(item.title));
  const structuralTocEntriesFiltered = ranged.length - exposed.length;
  const parsedWordChapterNumberCount = exposed.filter(({ item }) =>
    hasParsedWordReadingNumber(item.title),
  ).length;

  if (exposed.length === 0) {
    return [
      fallbackPhysicalVolumeChapter(
        input,
        finalPage,
        structuralTocEntriesFiltered,
        parsedWordChapterNumberCount,
      ),
    ];
  }

  let narrativeFallbackNumber = 0;
  return exposed.map(({ item, startPage, endPage }, index) => {
    const parsed = validReadingNumber(item.title);
    const fallbackNumber = nextFallbackNumber({
      parsed,
      title: item.title,
      narrativeFallbackNumber,
    });
    narrativeFallbackNumber = fallbackNumber.narrativeFallbackNumber;
    const title = normalizedTocTitle(item.title, fallbackNumber.chapterNumber);
    return {
      kavitaSeriesId: input.kavitaSeriesId,
      kavitaVolumeId: input.kavitaVolumeId,
      kavitaChapterId: input.kavitaChapterId,
      title,
      tocPath: item.tocPath,
      startPage,
      endPage,
      chapterNumber: fallbackNumber.chapterNumber,
      volumeNumber: input.volumeNumber,
      isSpecial: classifySpecialTitle(title),
      isLastInVolume: index === exposed.length - 1,
      structuralTocEntriesFiltered,
      parsedWordChapterNumberCount,
    };
  });
}

function fallbackPhysicalVolumeChapter(
  input: LogicalChapterInput,
  finalPage: number,
  structuralTocEntriesFiltered: number,
  parsedWordChapterNumberCount: number,
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
    isLastInVolume: true,
    structuralTocEntriesFiltered,
    parsedWordChapterNumberCount,
  };
}

function nextFallbackNumber(input: {
  parsed: number | undefined;
  title: string;
  narrativeFallbackNumber: number;
}): { chapterNumber: number; narrativeFallbackNumber: number } {
  if (input.parsed !== undefined) {
    const parsedInteger = Number.isInteger(input.parsed) ? input.parsed : Math.floor(input.parsed);
    return {
      chapterNumber: input.parsed,
      narrativeFallbackNumber: Math.max(input.narrativeFallbackNumber, parsedInteger),
    };
  }

  if (classifySpecialTitle(input.title)) {
    return {
      chapterNumber: 0,
      narrativeFallbackNumber: input.narrativeFallbackNumber,
    };
  }

  const narrativeFallbackNumber = input.narrativeFallbackNumber + 1;
  return { chapterNumber: narrativeFallbackNumber, narrativeFallbackNumber };
}

function isStructuralTocTitle(title: string): boolean {
  return STRUCTURAL_TITLE_PATTERN.test(title.trim());
}

function validReadingNumber(title: string): number | undefined {
  const parsed = parseChapterNumber(title)?.value;
  if (parsed === undefined || parsed >= KAVITA_SENTINEL_READING_NUMBER) return undefined;
  return parsed;
}

function hasParsedWordReadingNumber(title: string): boolean {
  if (validReadingNumber(title) === undefined) return false;
  return /\b(?:chapter|ch\.?)\s+[a-z]+(?:[-\s]+[a-z]+)?/iu.test(title);
}

function normalizedTocTitle(title: string, fallbackNumber: number): string {
  const trimmed = title.trim();
  if (SENTINEL_TITLE_PATTERN.test(trimmed) && validReadingNumber(trimmed) === undefined) {
    return `Chapter ${fallbackNumber}`;
  }
  return title;
}

export function buildEpubChapterId(input: {
  physicalChapterId: number;
  startPage: number;
  endPage: number;
  isLastInVolume: boolean;
}): string {
  return `kavita-book:${input.physicalChapterId}:page:${input.startPage}:end:${input.endPage}:last:${
    input.isLastInVolume ? 1 : 0
  }`;
}

export function parseFinalInVolumeFromChapterId(chapterId: string | undefined): boolean {
  return /:last:1$/u.test(chapterId ?? "");
}
