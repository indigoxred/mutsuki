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
    const chapters = parseKavitaChapterDtos(await client.getVolumes(seriesId));

    if (sourceManga.mangaInfo.contentType === "novel") {
      const nested: Chapter[][] = [];
      for (const chapter of chapters) {
        const bookInfo = await client.getBookInfo(chapter.id);
        const info =
          typeof bookInfo === "object" && bookInfo !== null
            ? (bookInfo as Record<string, unknown>)
            : {};
        nested.push(
          await getNovelChaptersFromBook({
            sourceManga,
            client,
            kavitaSeriesId: seriesId,
            kavitaVolumeId: numberValue(info.volumeId),
            kavitaChapterId: chapter.id,
            volumeNumber: Number(chapter.volumeNumber ?? info.volumeNumber ?? 1),
            totalPages: numberValue(info.pages) ?? chapter.pages,
          }),
        );
      }
      return nested.flat();
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
        maxResourceBytes: settings.htmlResourceSizeLimit,
        maxChapterBytes: settings.htmlChapterSizeLimit,
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
