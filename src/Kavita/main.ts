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
import { searchKavita } from "./search.js";

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
    _metadata?: Metadata,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const settings = getKavitaSettings();
    if (!settings.baseUrl || !settings.apiKey) return { items: [] };
    try {
      return { items: await getKavitaDiscoverItems(this.client(), section.id, settings.pageSize) };
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
    return sourceMangaFromKavitaSeries(
      await this.client().getSeriesDetails(kavitaSeriesIdFromMangaId(mangaId)),
    );
  }

  async getChapters(_sourceManga: SourceManga, _sinceDate?: Date): Promise<Chapter[]> {
    return [];
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      pages: [],
    };
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

export const MutsukiKavita = new MutsukiKavitaExtension();
