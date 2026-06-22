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

import { MUTSUKI_KAVITA_BUILD } from "./build-info.js";
import { KavitaClient, type KavitaTransport } from "./client.js";
import { getKavitaDiscoverItems, getKavitaDiscoverSections } from "./discovery.js";
import { getKavitaSettings, KavitaSettingsForm } from "./settings.js";
import { kavitaSeriesIdFromMangaId, sourceMangaFromKavitaSeries } from "./metadata.js";
import { getKavitaImageChapterDetails, mapKavitaMangaChapters } from "./manga-reader.js";
import { getNovelChapterDetails, getNovelChaptersFromBook } from "./novel-reader.js";
import { novelListingModeDiagnosticName } from "./novel-listing-mode.js";
import type { NovelPhysicalBook } from "./models.js";
import { buildWholeBookChapterId, summarizeNovelToc } from "./toc.js";
import {
  compareNovelPhysicalBooks,
  normalizePhysicalBookTitle,
  resolveNovelVolume,
} from "./novel-volume.js";
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
    const settings = getKavitaSettings();
    const seriesId = kavitaSeriesIdFromMangaId(sourceManga.mangaId);
    const serverSourceManga = sourceMangaFromKavitaSeries(
      await client.getSeriesDetails(seriesId),
      (id) => client.getSeriesCoverUrl(id),
    );
    const chapters = parseKavitaChapterDtos(await client.getVolumes(seriesId));

    if (serverSourceManga.mangaInfo.contentType === "novel") {
      const novelSourceManga = correctedNovelSourceManga(sourceManga, serverSourceManga);
      const physicalBooks = await Promise.all(
        chapters.map(async (chapter, index): Promise<NovelPhysicalBook> => {
          const bookInfo = await client.getBookInfo(chapter.id);
          const info =
            typeof bookInfo === "object" && bookInfo !== null
              ? (bookInfo as Record<string, unknown>)
              : {};
          const resolvedVolume = resolveNovelVolume({
            chapter,
            bookInfo: info,
            seriesTitle: serverSourceManga.mangaInfo.primaryTitle,
          });
          return {
            kavitaChapterId: chapter.id,
            kavitaVolumeId: numberValue(info.volumeId),
            sourceVolumeIndex: chapter.sourceVolumeIndex ?? index,
            sourceChapterIndex: chapter.sourceChapterIndex ?? index,
            rawVolume: chapter.volumeNumber,
            resolvedVolume,
            volumeResolutionSource: resolvedVolume.source,
            title: stringValue(info.bookTitle) ?? chapter.title,
            range: chapter.chapterNumber,
            fileName: stringValue(info.fileName ?? info.filename ?? info.filePath),
            pageCount: numberValue(info.pages) ?? chapter.pages,
            chapter,
          };
        }),
      );

      const sortedBooks = [...physicalBooks].sort(compareNovelPhysicalBooks);
      if (settings.novelListingMode === "physical-books") {
        const physicalChapters: Chapter[] = [];
        for (const book of sortedBooks) {
          const tocSummary = await maybeSummarizeNovelBook({
            client,
            book,
            includePublisherExtras: settings.includePublisherExtras,
            debugLogging: settings.debugLogging,
          });
          const chapter = physicalBookToPaperback({
            sourceManga: novelSourceManga,
            kavitaSeriesId: seriesId,
            book,
            seriesTitle: serverSourceManga.mangaInfo.primaryTitle,
            sortingIndex: physicalChapters.length,
          });
          physicalChapters.push(chapter);
          logNovelBook({
            book,
            listingMode: settings.novelListingMode,
            summary: tocSummary,
            debugLogging: settings.debugLogging,
          });
        }
        return physicalChapters;
      }

      const novelChapters: Chapter[] = [];
      for (const book of sortedBooks) {
        const tocSummary = await maybeSummarizeNovelBook({
          client,
          book,
          includePublisherExtras: settings.includePublisherExtras,
          debugLogging: settings.debugLogging,
        });
        const expanded = await getNovelChaptersFromBook({
          sourceManga: novelSourceManga,
          client,
          kavitaSeriesId: seriesId,
          kavitaVolumeId: book.kavitaVolumeId,
          kavitaChapterId: book.kavitaChapterId,
          volumeNumber: book.resolvedVolume.value,
          fallbackTitle: book.title,
          totalPages: book.pageCount,
          includePublisherExtras: settings.includePublisherExtras,
        });
        for (const chapter of expanded) {
          const projected = { ...chapter, sortingIndex: novelChapters.length };
          novelChapters.push(projected);
          logNovelProjection({
            chapter: projected,
            debugLogging: settings.debugLogging,
          });
        }
        logNovelBook({
          book,
          listingMode: settings.novelListingMode,
          summary: tocSummary,
          debugLogging: settings.debugLogging,
        });
      }
      return novelChapters;
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
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function physicalBookToPaperback(input: {
  sourceManga: SourceManga;
  kavitaSeriesId: number;
  book: NovelPhysicalBook;
  seriesTitle?: string;
  sortingIndex: number;
}): Chapter {
  const chapterId = buildWholeBookChapterId(input.book.kavitaChapterId);
  return {
    chapterId,
    sourceManga: input.sourceManga,
    langCode: "en",
    chapNum: input.sortingIndex + 1,
    title: normalizePhysicalBookTitle({
      seriesTitle: input.seriesTitle,
      bookTitle: input.book.title,
      volume: input.book.resolvedVolume.value,
    }),
    volume: input.book.resolvedVolume.value,
    sortingIndex: input.sortingIndex,
    additionalInfo: {
      kavitaSeriesId: String(input.kavitaSeriesId),
      kavitaVolumeId:
        input.book.kavitaVolumeId === undefined ? "" : String(input.book.kavitaVolumeId),
      kavitaChapterId: String(input.book.kavitaChapterId),
      startPage: "0",
      endPage: String(Math.max(0, input.book.pageCount - 1)),
      isSpecial: "false",
      isLastInVolume: "true",
      listingMode: "physical-books",
      role: "physical-book",
      localChapterNumber: "1",
      physicalBookNumber: String(input.sortingIndex + 1),
      volumeResolutionSource: input.book.volumeResolutionSource,
      physicalVolumeNumber:
        input.book.resolvedVolume.value === undefined
          ? ""
          : String(input.book.resolvedVolume.value),
    },
  } as Chapter;
}

async function maybeSummarizeNovelBook(input: {
  client: KavitaClient;
  book: NovelPhysicalBook;
  includePublisherExtras: boolean;
  debugLogging: boolean;
}): Promise<ReturnType<typeof summarizeNovelToc> | undefined> {
  if (!input.debugLogging) return undefined;
  try {
    return summarizeNovelToc({
      toc: await input.client.getBookChapters(input.book.kavitaChapterId),
      totalPages: input.book.pageCount,
      includePublisherExtras: input.includePublisherExtras,
    });
  } catch {
    return undefined;
  }
}

function logNovelBook(input: {
  book: NovelPhysicalBook;
  listingMode: "physical-books" | "internal-chapters";
  summary: ReturnType<typeof summarizeNovelToc> | undefined;
  debugLogging: boolean;
}): void {
  if (!input.debugLogging) return;
  const summary = input.summary;
  console.log(
    [
      "[MutsukiNovelBook]",
      `physicalChapterId=${input.book.kavitaChapterId}`,
      `volumeId=${input.book.kavitaVolumeId ?? ""}`,
      `sourceVolumeIndex=${input.book.sourceVolumeIndex}`,
      `sourceChapterIndex=${input.book.sourceChapterIndex}`,
      `rawVolume=${sanitizeLogText(input.book.rawVolume)}`,
      `resolvedVolume=${input.book.resolvedVolume.value ?? ""}`,
      `resolutionSource=${input.book.resolvedVolume.source}`,
      `bookTitle=${sanitizeLogText(input.book.title)}`,
      `pageCount=${input.book.pageCount}`,
      `rawTocCount=${summary?.rawTocCount ?? 0}`,
      `structuralFiltered=${summary?.structuralFiltered ?? 0}`,
      `publisherFiltered=${summary?.publisherFiltered ?? 0}`,
      `frontmatterCount=${summary?.frontmatterCount ?? 0}`,
      `specialCount=${summary?.specialCount ?? 0}`,
      `narrativeCount=${summary?.narrativeCount ?? 0}`,
      `listingMode=${novelListingModeDiagnosticName(input.listingMode)}`,
    ].join(" "),
  );
}

function logNovelProjection(input: { chapter: Chapter; debugLogging: boolean }): void {
  if (!input.debugLogging) return;
  const info = input.chapter.additionalInfo ?? {};
  console.log(
    [
      "[MutsukiNovelProjection]",
      `physicalChapterId=${sanitizeLogText(info.kavitaChapterId)}`,
      `volume=${input.chapter.volume ?? ""}`,
      `localChapter=${input.chapter.chapNum}`,
      `role=${sanitizeLogText(info.role)}`,
      `sortingIndex=${input.chapter.sortingIndex ?? ""}`,
      `startPage=${sanitizeLogText(info.startPage)}`,
      `endPage=${sanitizeLogText(info.endPage)}`,
      `title=${sanitizeLogText(input.chapter.title)}`,
    ].join(" "),
  );
}

function sanitizeLogText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\?.*$/u, "")
    .replace(/[^\p{L}\p{N} .:_-]+/gu, "")
    .slice(0, 80);
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
