import type { ChapterDetails } from "@paperback/types";
import { parseReadingNumber } from "../shared/numbers.js";
import type { MutsukiLogicalChapter } from "./models.js";
import { buildEpubChapterId } from "./toc.js";

type ImageChapterDetails = ChapterDetails & { pages: string[] };
type HtmlChapterDetails = ChapterDetails & { type: "html"; html: string };

interface SourceMangaLike {
  mangaId: string;
  mangaInfo: {
    additionalInfo?: Record<string, string>;
    thumbnailUrl?: string;
    synopsis?: string;
    primaryTitle?: string;
    secondaryTitles?: string[];
    contentRating?: unknown;
    contentType?: "comic" | "novel";
  };
}

interface PaperbackChapterLike {
  chapterId: string;
  sourceManga: SourceMangaLike;
  langCode: string;
  chapNum: number;
  title?: string;
  volume?: number;
  additionalInfo?: Record<string, string>;
  sortingIndex?: number;
}

export interface KavitaChapterDto {
  id: number;
  title?: string;
  chapterNumber?: string;
  volumeNumber?: string;
  pages: number;
  isSpecial?: boolean;
  publishDate?: string;
}

const KAVITA_SENTINEL_READING_NUMBER = 10000;

export function mangaChapterToPaperback(input: {
  sourceManga: SourceMangaLike;
  kavitaChapter: KavitaChapterDto;
  pageUrl: (page: number) => string;
  sortingIndex: number;
}): { chapter: PaperbackChapterLike; details: ImageChapterDetails } {
  const chapterNumber =
    validChapterOrVolumeNumber(
      input.kavitaChapter.isSpecial
        ? undefined
        : (input.kavitaChapter.chapterNumber ?? input.kavitaChapter.title),
    ) ?? input.sortingIndex + 1;
  const volumeNumber = validChapterOrVolumeNumber(
    input.kavitaChapter.isSpecial ? undefined : input.kavitaChapter.volumeNumber,
  );
  const chapterId = `kavita-chapter:${input.kavitaChapter.id}`;

  const chapter: PaperbackChapterLike = {
    chapterId,
    sourceManga: input.sourceManga,
    langCode: "en",
    chapNum: chapterNumber,
    title: input.kavitaChapter.title,
    volume: volumeNumber,
    additionalInfo: {
      kavitaChapterId: String(input.kavitaChapter.id),
      isSpecial: String(input.kavitaChapter.isSpecial ?? false),
    },
    sortingIndex: input.sortingIndex,
  };

  const details: ImageChapterDetails = {
    id: chapterId,
    mangaId: input.sourceManga.mangaId,
    pages: Array.from({ length: Math.max(0, input.kavitaChapter.pages) }, (_unused, page) =>
      input.pageUrl(page),
    ),
  };

  return { chapter, details };
}

function validChapterOrVolumeNumber(input: string | number | undefined): number | undefined {
  const parsed = parseReadingNumber(input)?.value;
  if (parsed === undefined || parsed >= KAVITA_SENTINEL_READING_NUMBER) return undefined;
  return parsed;
}

export function novelChapterToPaperback(input: {
  sourceManga: SourceMangaLike;
  logicalChapter: MutsukiLogicalChapter;
  html: string;
  sortingIndex: number;
}): { chapter: PaperbackChapterLike; details: HtmlChapterDetails } {
  const chapterId = buildEpubChapterId({
    physicalChapterId: input.logicalChapter.kavitaChapterId,
    startPage: input.logicalChapter.startPage,
    endPage: input.logicalChapter.endPage,
    isLastInVolume: input.logicalChapter.isLastInVolume,
  });

  const chapter: PaperbackChapterLike = {
    chapterId,
    sourceManga: input.sourceManga,
    langCode: "en",
    chapNum: input.logicalChapter.chapterNumber,
    title: input.logicalChapter.title,
    volume: input.logicalChapter.volumeNumber,
    additionalInfo: {
      kavitaSeriesId: String(input.logicalChapter.kavitaSeriesId),
      kavitaVolumeId:
        input.logicalChapter.kavitaVolumeId === undefined
          ? ""
          : String(input.logicalChapter.kavitaVolumeId),
      kavitaChapterId: String(input.logicalChapter.kavitaChapterId),
      startPage: String(input.logicalChapter.startPage),
      endPage: String(input.logicalChapter.endPage),
      isSpecial: String(input.logicalChapter.isSpecial),
      isLastInVolume: String(input.logicalChapter.isLastInVolume),
      structuralTocEntriesFiltered: String(input.logicalChapter.structuralTocEntriesFiltered ?? 0),
      parsedWordChapterNumberCount: String(input.logicalChapter.parsedWordChapterNumberCount ?? 0),
    },
    sortingIndex: input.sortingIndex,
  };

  const details: HtmlChapterDetails = {
    id: chapterId,
    mangaId: input.sourceManga.mangaId,
    type: "html",
    html: input.html,
  };

  return { chapter, details };
}
