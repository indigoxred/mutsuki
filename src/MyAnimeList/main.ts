import {
  ContentRating,
  type ChapterReadActionQueueProcessingResult,
  type Extension,
  type Form,
  type MangaProgress,
  type MangaProgressProviding,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import { actionFromPaperback } from "./action.js";
import { getMalAccessToken } from "./auth.js";
import { MyAnimeListClient, type MalTransport } from "./client.js";
import { MALSettingsForm } from "./forms/settings.js";
import { TrackingForm } from "./forms/tracking.js";
import { defaultPolicyForContentType } from "./policy.js";
import { processMalQueue } from "./queue.js";
import type { TrackingPolicy } from "./models.js";

type MALImplementation = Extension &
  SearchResultsProviding &
  SettingsFormProviding &
  MangaProgressProviding;

export class MutsukiMyAnimeListExtension implements MALImplementation {
  async initialise(): Promise<void> {}

  async getSettingsForm(): Promise<Form> {
    return new MALSettingsForm();
  }

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    return new TrackingForm(sourceManga.mangaId);
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    const token = getMalAccessToken();
    if (!token) return undefined;
    const progress = await this.client(token).getCurrentProgress(sourceManga.mangaId);
    return {
      sourceManga,
      lastReadChapter: {
        chapterId: String(progress.chaptersRead),
        sourceManga,
        langCode: "unknown",
        chapNum: progress.chaptersRead,
        volume: progress.volumesRead,
      },
    };
  }

  async processChapterReadActionQueue(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<ChapterReadActionQueueProcessingResult> {
    const token = getMalAccessToken();
    if (!token) return { successfulItems: [], failedItems: actions.map((action) => action.id) };
    const client = this.client(token);
    return processMalQueue({
      actions: actions.map(actionFromPaperback),
      getPolicy: (malMangaId) =>
        (Application.getState(`malPolicy:${malMangaId}`) as TrackingPolicy | undefined) ??
        defaultPolicyForContentType("manga"),
      getCurrentProgress: (malMangaId) => client.getCurrentProgress(malMangaId),
      updateProgress: (malMangaId, update) => client.updateProgress(malMangaId, update),
    });
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const token = getMalAccessToken();
    if (!token) return { items: [] };
    return {
      items: (await this.client(token).search(query.title)).map((item) => ({
        ...item,
        contentRating: ContentRating.EVERYONE,
      })),
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return {
      mangaId,
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: `MyAnimeList ${mangaId}`,
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
      },
    };
  }

  private client(accessToken: string): MyAnimeListClient {
    return new MyAnimeListClient(accessToken, paperbackMalTransport);
  }
}

const paperbackMalTransport: MalTransport = async (request) => {
  const [response, buffer] = await Application.scheduleRequest(request);
  return {
    status: response.status,
    body: Application.arrayBufferToUTF8String(buffer),
  };
};

export const MutsukiMyAnimeList = new MutsukiMyAnimeListExtension();
