import {
  ContentRating,
  type Chapter,
  type ChapterDetails,
  type ChapterProviding,
  type DiscoverSection,
  type DiscoverSectionItem,
  type DiscoverSectionProviding,
  type Extension,
  Form,
  type FormSectionElement,
  LabelRow,
  type MangaProviding,
  type MangaProgress,
  type MangaProgressProviding,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  Section,
  type SortingOption,
  type SourceManga,
  type ChapterReadActionQueueProcessingResult,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import { MUTSUKI_KAVITA_BUILD } from "./build-info.js";
import { KavitaClient, type KavitaTransport } from "./client.js";
import { getKavitaDiscoverItems, getKavitaDiscoverSections } from "./discovery.js";
import { getKavitaSettings, KavitaSettingsForm } from "./settings.js";
import { largeEpubHandlingDiagnosticName } from "./large-epub-handling.js";
import { kavitaSeriesIdFromMangaId, sourceMangaFromKavitaSeries } from "./metadata.js";
import { getKavitaImageChapterDetails, mapKavitaMangaChapters } from "./manga-reader.js";
import { getNovelChapterDetails, getNovelChaptersFromBook } from "./novel-reader.js";
import { novelListingModeDiagnosticName } from "./novel-listing-mode.js";
import { sendProgressBridgeEvent, type ProgressBridgeTransport } from "./progress-bridge.js";
import { processKavitaReadActionQueue } from "./progress.js";
import type { KavitaTocItem, NovelPhysicalBook, NovelReadingUnit } from "./models.js";
import { planNovelReadingUnits, type NovelReadingPlan } from "./novel-segments.js";
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
  SettingsFormProviding &
  MangaProgressProviding;

export class MutsukiKavitaExtension implements KavitaImplementation {
  async initialise(): Promise<void> {}

  async getSettingsForm(): Promise<Form> {
    return new KavitaSettingsForm();
  }

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    return new KavitaProgressForm(sourceManga);
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) return undefined;
    try {
      kavitaSeriesIdFromMangaId(sourceManga.mangaId);
    } catch {
      return undefined;
    }
    return {
      sourceManga,
      lastReadChapter: {
        chapterId: `${sourceManga.mangaId}:progress-start`,
        sourceManga,
        langCode: "en",
        chapNum: 0,
      },
    };
  }

  async processChapterReadActionQueue(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<ChapterReadActionQueueProcessingResult> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) {
      return { successfulItems: [], failedItems: actions.map((action) => action.id) };
    }
    const client = this.client();
    try {
      return await processKavitaReadActionQueue({
        actions,
        markChapterRead: (mark) =>
          client.markChapterRead({ seriesId: mark.seriesId, chapterId: mark.chapterId }),
        sendBridgeEvent: settings.progressBridgeUrl
          ? (event) =>
              sendProgressBridgeEvent({
                bridgeUrl: settings.progressBridgeUrl,
                token: settings.progressBridgeToken || undefined,
                event,
                transport: progressBridgeTransport,
              })
          : undefined,
      });
    } catch {
      return { successfulItems: [], failedItems: actions.map((action) => action.id) };
    }
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
          const bookInfo = await cachedBookInfo(client, chapter.id);
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
          const toc = await cachedBookToc(client, book.kavitaChapterId);
          const plan = planNovelReadingUnits({
            physicalChapterId: book.kavitaChapterId,
            physicalVolumeId: book.kavitaVolumeId,
            physicalVolumeNumber: book.resolvedVolume.value,
            title: book.title,
            totalPages: book.pageCount,
            toc,
            largeBookHandling: settings.largeEpubHandling,
            targetPagesPerPart: settings.targetSourcePagesPerPart,
          });
          logNovelPlan({
            plan,
            listingMode: settings.novelListingMode,
            debugLogging: settings.debugLogging,
          });
          const tocSummary = summarizeNovelToc({
            toc,
            totalPages: book.pageCount,
            includePublisherExtras: settings.includePublisherExtras,
          });

          if (!plan.autoSplitTriggered && plan.units.length === 1) {
            const chapter = physicalBookToPaperback({
              sourceManga: novelSourceManga,
              kavitaSeriesId: seriesId,
              book,
              seriesTitle: serverSourceManga.mangaInfo.primaryTitle,
              sortingIndex: physicalChapters.length,
            });
            physicalChapters.push(chapter);
          } else {
            for (const unit of plan.units) {
              physicalChapters.push(
                readingUnitToPaperback({
                  sourceManga: novelSourceManga,
                  kavitaSeriesId: seriesId,
                  book,
                  unit,
                  sortingIndex: physicalChapters.length,
                }),
              );
            }
          }

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
        const toc = await cachedBookToc(client, book.kavitaChapterId);
        const tocSummary = summarizeNovelToc({
          toc,
          totalPages: book.pageCount,
          includePublisherExtras: settings.includePublisherExtras,
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
          toc,
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

    return mapKavitaMangaChapters(serverSourceManga, chapters, client);
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

const progressBridgeTransport: ProgressBridgeTransport = async (request) => {
  const [response] = await Application.scheduleRequest(request);
  return { status: response.status };
};

class KavitaProgressForm extends Form {
  constructor(private readonly sourceManga: SourceManga) {
    super();
  }

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section({ id: "kavita-progress", header: "Kavita Progress" }, [
        LabelRow("summary", {
          title: "Automatic Kavita updates",
          subtitle:
            "Completed reads from this source are queued by Paperback and marked read in Kavita. Configure the mock bridge URL in source settings to display received events.",
        }),
        LabelRow("series", {
          title: "Paperback series id",
          subtitle: this.sourceManga.mangaId,
        }),
      ]),
    ];
  }
}

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

function readingUnitToPaperback(input: {
  sourceManga: SourceManga;
  kavitaSeriesId: number;
  book: NovelPhysicalBook;
  unit: NovelReadingUnit;
  sortingIndex: number;
}): Chapter {
  return {
    chapterId: input.unit.id,
    sourceManga: input.sourceManga,
    langCode: "en",
    chapNum: input.sortingIndex + 1,
    title: input.unit.title,
    volume: input.book.resolvedVolume.value,
    sortingIndex: input.sortingIndex,
    additionalInfo: {
      kavitaSeriesId: String(input.kavitaSeriesId),
      kavitaVolumeId:
        input.book.kavitaVolumeId === undefined ? "" : String(input.book.kavitaVolumeId),
      kavitaChapterId: String(input.book.kavitaChapterId),
      physicalVolumeNumber:
        input.book.resolvedVolume.value === undefined
          ? ""
          : String(input.book.resolvedVolume.value),
      startPage: String(input.unit.startPage),
      endPage: String(input.unit.endPage),
      segmentIndex: String(input.unit.segmentIndex),
      segmentCount: String(input.unit.segmentCount),
      isSpecial: String(input.unit.role !== "narrative"),
      isLastInVolume: String(input.unit.isLastInPhysicalBook),
      listingMode: "physical-books",
      role: input.unit.role,
      localChapterNumber: "1",
      physicalBookNumber: String(input.sortingIndex + 1),
      volumeResolutionSource: input.book.volumeResolutionSource,
    },
  } as Chapter;
}

const bookInfoCache = new Map<string, Promise<unknown>>();
const bookTocCache = new Map<string, Promise<KavitaTocItem[]>>();
const MAX_METADATA_CACHE_ENTRIES = 100;

function cacheKey(client: KavitaClient, chapterId: number): string {
  return `${client.baseUrl}|${chapterId}`;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): V {
  if (!map.has(key) && map.size >= MAX_METADATA_CACHE_ENTRIES) {
    const firstKey = map.keys().next().value as K | undefined;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
  return value;
}

function cachedBookInfo(client: KavitaClient, chapterId: number): Promise<unknown> {
  const key = cacheKey(client, chapterId);
  return (
    bookInfoCache.get(key) ??
    boundedSet(
      bookInfoCache,
      key,
      client.getBookInfo(chapterId).catch((error) => {
        bookInfoCache.delete(key);
        throw error;
      }),
    )
  );
}

function cachedBookToc(client: KavitaClient, chapterId: number): Promise<KavitaTocItem[]> {
  const key = cacheKey(client, chapterId);
  return (
    bookTocCache.get(key) ??
    boundedSet(
      bookTocCache,
      key,
      client.getBookChapters(chapterId).catch((error) => {
        bookTocCache.delete(key);
        throw error;
      }),
    )
  );
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

function logNovelPlan(input: {
  plan: NovelReadingPlan;
  listingMode: "physical-books" | "internal-chapters";
  debugLogging: boolean;
}): void {
  if (!input.debugLogging) return;
  console.log(
    [
      "[MutsukiNovelPlan]",
      `build=${MUTSUKI_KAVITA_BUILD}`,
      `physicalChapterId=${input.plan.physicalChapterId}`,
      `totalPages=${input.plan.totalPages}`,
      `listingMode=${novelListingModeDiagnosticName(input.listingMode)}`,
      `largeBookHandling=${largeEpubHandlingDiagnosticName(input.plan.largeBookHandling)}`,
      `autoSplitTriggered=${input.plan.autoSplitTriggered}`,
      `topLevelBoundaryCount=${input.plan.topLevelBoundaryCount}`,
      `segmentCount=${input.plan.segmentCount}`,
      `largestSegmentPageCount=${input.plan.largestSegmentPageCount}`,
      `smallestSegmentPageCount=${input.plan.smallestSegmentPageCount}`,
      `frontMatterSegmentCount=${input.plan.frontMatterSegmentCount}`,
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
