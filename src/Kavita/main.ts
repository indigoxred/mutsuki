import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type ChapterProviding,
  type DiscoverSection,
  type DiscoverSectionItem,
  type DiscoverSectionProviding,
  type Extension,
  type Form,
  type MangaProviding,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
} from "@paperback/types";

import { parseVolumeNumber } from "../shared/numbers.js";
import { MUTSUKI_KAVITA_BUILD } from "./build-info.js";
import { KavitaClient, type KavitaTransport } from "./client.js";
import { getKavitaDiscoverItems, getKavitaDiscoverSections } from "./discovery.js";
import { getKavitaSettings, KavitaSettingsForm } from "./settings.js";
import { kavitaSeriesIdFromMangaId, sourceMangaFromKavitaSeries } from "./metadata.js";
import { getKavitaImageChapterDetails, mapKavitaMangaChapters } from "./manga-reader.js";
import { getNovelChapterDetails, getNovelChaptersFromBook } from "./novel-reader.js";
import { searchKavita } from "./search.js";
import { parseKavitaChapterDtos } from "./volume-parser.js";

type KavitaImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  SettingsFormProviding;

export class MutsukiKavitaExtension implements KavitaImplementation {
  async initialise(): Promise<void> {}

  async getSettingsForm(): Promise<Form> {
    return new KavitaSettingsForm();
  }

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return getKavitaDiscoverSections(getKavitaSettings());
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata?: Metadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) return { items: [] };
    try {
      return await getKavitaDiscoverItems(this.client(), section.id, settings.pageSize, metadata);
    } catch {
      return { items: [] };
    }
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) return { items: [] };
    return { items: await searchKavita(this.client(), query.title, settings.pageSize) };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) {
      return {
        mangaId,
        mangaInfo: {
          thumbnailUrl: "",
          synopsis: "Configure Kavita settings before browsing this title.",
          primaryTitle: "Mutsuki Kavita",
          secondaryTitles: [],
          contentRating: ContentRating.EVERYONE,
        },
      };
    }
    const client = this.client();
    return sourceMangaFromKavitaSeries(
      await client.getSeriesDetails(kavitaSeriesIdFromMangaId(mangaId)),
      (seriesId) => client.getSeriesCoverUrl(seriesId),
    );
  }

  async getChapters(sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    const client = this.client();
    const seriesId = kavitaSeriesIdFromMangaId(sourceManga.mangaId);
    const serverSourceManga = sourceMangaFromKavitaSeries(
      await client.getSeriesDetails(seriesId),
      (id) => client.getSeriesCoverUrl(id),
    );
    const chapters = parseKavitaChapterDtos(await client.getVolumes(seriesId));

    if (serverSourceManga.mangaInfo.contentType === "novel") {
      const novelSourceManga = correctedNovelSourceManga(sourceManga, serverSourceManga);
      const novelChapters: Chapter[] = [];
      const physicalBooks = await Promise.all(
        chapters.map(async (chapter, index): Promise<PhysicalNovelBook> => {
          const bookInfo = await client.getBookInfo(chapter.id);
          const info =
            typeof bookInfo === "object" && bookInfo !== null
              ? (bookInfo as Record<string, unknown>)
              : {};
          return {
            kavitaChapterId: chapter.id,
            kavitaVolumeId: numberValue(info.volumeId),
            sourceVolumeIndex: index,
            sourceChapterIndex: index,
            originalVolumeNumber: chapter.volumeNumber,
            resolvedVolume: resolveNovelVolume(chapter, info),
            title: stringValue(info.bookTitle) ?? chapter.title,
            range: chapter.chapterNumber,
            fileName: stringValue(info.fileName ?? info.filename ?? info.filePath),
            pageCount: numberValue(info.pages) ?? chapter.pages,
            chapter,
          };
        }),
      );

      const sortedBooks = [...physicalBooks].sort(comparePhysicalNovelBooks);
      for (const book of sortedBooks) {
        const firstSortingIndex = novelChapters.length;
        const expanded = await getNovelChaptersFromBook({
          sourceManga: novelSourceManga,
          client,
          kavitaSeriesId: seriesId,
          kavitaVolumeId: book.kavitaVolumeId,
          kavitaChapterId: book.kavitaChapterId,
          volumeNumber: book.resolvedVolume.value,
          fallbackTitle: book.title,
          totalPages: book.pageCount,
        });
        novelChapters.push(...expanded);
        logNovelOrder({
          book,
          logicalChapterCount: expanded.length,
          firstSortingIndex,
          lastSortingIndex: novelChapters.length - 1,
          debugLogging: getKavitaSettings().debugLogging,
        });
      }
      return novelChapters.map((chapter, sortingIndex) => ({ ...chapter, sortingIndex }));
    }

    return mapKavitaMangaChapters(sourceManga, chapters, client);
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const settings = getKavitaSettings();
    const client = this.client();
    if (chapter.chapterId.startsWith("kavita-book:")) {
      return getNovelChapterDetails({
        sourceManga: chapter.sourceManga,
        chapter,
        client,
        renderingMode: settings.novelRenderingMode,
        maxResourceBytes: settings.htmlResourceSizeLimit,
        maxChapterBytes: settings.htmlChapterSizeLimit,
        debugLogging: settings.debugLogging,
        build: MUTSUKI_KAVITA_BUILD,
        incomingContentType: chapter.sourceManga.mangaInfo.contentType,
        resolvedContentType: "novel",
        kavitaFormat: chapter.sourceManga.mangaInfo.additionalInfo?.format,
      });
    }

    const kavitaChapterId = Number(
      chapter.additionalInfo?.kavitaChapterId ?? chapter.chapterId.replace(/^kavita-chapter:/u, ""),
    );
    const info = await client.getChapterInfo(kavitaChapterId);
    const record =
      typeof info === "object" && info !== null ? (info as Record<string, unknown>) : {};
    return getKavitaImageChapterDetails(
      chapter.sourceManga,
      {
        id: kavitaChapterId,
        title: chapter.title,
        chapterNumber: String(chapter.chapNum),
        volumeNumber: chapter.volume === undefined ? undefined : String(chapter.volume),
        pages: numberValue(record.pages) ?? numberValue(record.Pages) ?? 0,
        isSpecial: chapter.additionalInfo?.isSpecial === "true",
      },
      client,
    );
  }

  private client(): KavitaClient {
    const settings = getKavitaSettings();
    return new KavitaClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      transport: paperbackTransport,
    });
  }
}

const paperbackTransport: KavitaTransport = async (request) => {
  const [response, buffer] = await Application.scheduleRequest(request);
  const contentType = response.headers["content-type"] ?? response.mimeType;
  const isText = contentType?.includes("json") || contentType?.startsWith("text/");
  return {
    status: response.status,
    headers: response.headers,
    body: isText ? Application.arrayBufferToUTF8String(buffer) : buffer,
  };
};

export const Kavita = new MutsukiKavitaExtension();
export const MutsukiKavita = Kavita;

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

interface ResolvedNovelVolume {
  value?: number;
  source:
    | "book-title"
    | "book-metadata"
    | "chapter-title"
    | "file-range"
    | "kavita-volume"
    | "series-title"
    | "unknown";
  confidence: number;
  isDecimal: boolean;
}

interface PhysicalNovelBook {
  kavitaChapterId: number;
  kavitaVolumeId?: number;
  sourceVolumeIndex: number;
  sourceChapterIndex: number;
  originalVolumeNumber?: string;
  resolvedVolume: ResolvedNovelVolume;
  title?: string;
  range?: string;
  fileName?: string;
  pageCount: number;
  chapter: { title?: string; volumeNumber?: string };
}

function resolveNovelVolume(
  chapter: { title?: string; volumeNumber?: string },
  bookInfo: Record<string, unknown>,
): ResolvedNovelVolume {
  const rawKavitaVolume =
    validStandaloneVolume(bookInfo.volumeNumber) ?? validStandaloneVolume(chapter.volumeNumber);
  const candidates = [
    bookTitleVolumeCandidate(stringValue(bookInfo.bookTitle), rawKavitaVolume),
    resolvedVolumeCandidate("book-metadata", bookInfo.volumeNumber, 90, "standalone"),
    resolvedVolumeCandidate("chapter-title", chapter.title, 80, "marker"),
    resolvedVolumeCandidate(
      "file-range",
      stringValue(bookInfo.range ?? bookInfo.fileName ?? bookInfo.filename ?? bookInfo.filePath),
      75,
      "marker",
    ),
    resolvedVolumeCandidate("kavita-volume", chapter.volumeNumber, 70, "standalone"),
    resolvedVolumeCandidate("series-title", stringValue(bookInfo.seriesName), 50, "marker"),
  ].filter((candidate): candidate is ResolvedNovelVolume => candidate.value !== undefined);

  candidates.sort(
    (a, b) => b.confidence - a.confidence || Number(b.isDecimal) - Number(a.isDecimal),
  );
  return (
    candidates[0] ?? {
      value: undefined,
      source: "unknown",
      confidence: 0,
      isDecimal: false,
    }
  );
}

function resolvedVolumeCandidate(
  source: ResolvedNovelVolume["source"],
  value: unknown,
  confidence: number,
  mode: "marker" | "standalone",
): ResolvedNovelVolume {
  const parsed =
    mode === "standalone" ? validStandaloneVolume(value) : parseVolumeNumber(stringValue(value));
  if (parsed === undefined) {
    return { value: undefined, source: "unknown", confidence: 0, isDecimal: false };
  }
  return { value: parsed.value, source, confidence, isDecimal: parsed.isDecimal };
}

function bookTitleVolumeCandidate(
  title: string | undefined,
  rawKavitaVolume: { value: number; isDecimal: boolean } | undefined,
): ResolvedNovelVolume {
  const explicit = resolvedVolumeCandidate("book-title", title, 100, "marker");
  if (explicit.value !== undefined) return explicit;
  const refined = trailingDecimalRefinement(title, rawKavitaVolume);
  if (refined !== undefined) {
    return { value: refined, source: "book-title", confidence: 100, isDecimal: true };
  }
  return { value: undefined, source: "unknown", confidence: 0, isDecimal: false };
}

function trailingDecimalRefinement(
  title: string | undefined,
  rawKavitaVolume: { value: number; isDecimal: boolean } | undefined,
): number | undefined {
  if (title === undefined || rawKavitaVolume === undefined || rawKavitaVolume.isDecimal) {
    return undefined;
  }
  const decimalText = /\b(\d+\.\d+)\s*$/u.exec(title.trim())?.[1];
  if (decimalText === undefined) return undefined;
  const decimal = Number(decimalText);
  if (!Number.isFinite(decimal) || Math.trunc(decimal) !== rawKavitaVolume.value) {
    return undefined;
  }
  return decimal;
}

function validStandaloneVolume(value: unknown): { value: number; isDecimal: boolean } | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return undefined;
  const parsed = parseVolumeNumber(text);
  return parsed;
}

function comparePhysicalNovelBooks(a: PhysicalNovelBook, b: PhysicalNovelBook): number {
  const aVolume = a.resolvedVolume.value;
  const bVolume = b.resolvedVolume.value;
  if (aVolume !== undefined && bVolume !== undefined && aVolume !== bVolume) {
    return aVolume - bVolume;
  }
  if (aVolume !== undefined && bVolume === undefined) return -1;
  if (aVolume === undefined && bVolume !== undefined) return 1;
  return (
    a.sourceVolumeIndex - b.sourceVolumeIndex ||
    a.sourceChapterIndex - b.sourceChapterIndex ||
    a.kavitaChapterId - b.kavitaChapterId
  );
}

function logNovelOrder(input: {
  book: PhysicalNovelBook;
  logicalChapterCount: number;
  firstSortingIndex: number;
  lastSortingIndex: number;
  debugLogging: boolean;
}): void {
  if (!input.debugLogging) return;
  console.log(
    [
      "[MutsukiNovelOrder]",
      `chapterId=${input.book.kavitaChapterId}`,
      `sourceVolumeIndex=${input.book.sourceVolumeIndex}`,
      `sourceChapterIndex=${input.book.sourceChapterIndex}`,
      `rawVolume=${input.book.originalVolumeNumber ?? ""}`,
      `bookTitleVolume=${parseVolumeNumber(input.book.title)?.value ?? ""}`,
      `resolvedVolume=${input.book.resolvedVolume.value ?? ""}`,
      `resolutionSource=${input.book.resolvedVolume.source}`,
      `logicalChapterCount=${input.logicalChapterCount}`,
      `firstSortingIndex=${input.firstSortingIndex}`,
      `lastSortingIndex=${input.lastSortingIndex}`,
    ].join(" "),
  );
}

function correctedNovelSourceManga(
  sourceManga: SourceManga,
  serverSourceManga: SourceManga,
): SourceManga {
  return {
    ...sourceManga,
    mangaInfo: {
      ...sourceManga.mangaInfo,
      ...serverSourceManga.mangaInfo,
      additionalInfo: {
        ...sourceManga.mangaInfo.additionalInfo,
        ...serverSourceManga.mangaInfo.additionalInfo,
      },
      contentType: "novel",
    },
  };
}
