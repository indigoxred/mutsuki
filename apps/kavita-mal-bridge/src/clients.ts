import type { BridgeConfig } from "./config.js";
import type { KavitaSeriesCandidate, MalSearchCandidate } from "./matching.js";
import type { MalListProgress } from "./policy.js";
import type {
  BridgeExternalIdResolver,
  BridgeKavitaClient,
  BridgeMalClient,
  BridgeObservedSeries,
} from "./sync.js";

export interface KavitaReadinessResult {
  configured: boolean;
  ok: boolean;
  seriesSeen?: number;
  message?: string;
}

export interface MalReadinessResult {
  oauthConfigured: boolean;
  authorized: boolean;
  ok: boolean;
  message?: string;
}

export function createKavitaClient(config: BridgeConfig): BridgeKavitaClient {
  const baseUrl = normalizeBaseUrl(config.kavitaBaseUrl);
  return {
    async listSeries(options?: { limit?: number }): Promise<BridgeObservedSeries[]> {
      const json = await kavitaJson(baseUrl, config.kavitaApiKey, seriesListPath(options?.limit), {
        method: "POST",
        body: JSON.stringify({ statements: [], combination: 0 }),
      });
      const records = Array.isArray(json)
        ? json
        : arrayFromObject(json, ["items", "series", "value"]);
      const series = records.flatMap((record) => observedSeriesFromKavita(record));
      return mapWithConcurrency(series, 4, async (item) => {
        const progress = await observedProgressFromKavitaVolumes(
          baseUrl,
          config.kavitaApiKey,
          item.kavitaSeriesId,
          item.title,
        ).catch(
          (): Pick<
            BridgeObservedSeries,
            "completedChapter" | "completedVolume" | "contentType" | "mediaType"
          > => ({
            completedChapter: undefined,
            completedVolume: undefined,
            contentType: undefined,
            mediaType: undefined,
          }),
        );
        return {
          ...item,
          completedChapter: progress.completedChapter ?? item.completedChapter,
          completedVolume: progress.completedVolume ?? item.completedVolume,
          contentType: progress.contentType ?? item.contentType,
          mediaType: progress.mediaType ?? item.mediaType,
        };
      });
    },
  };
}

function seriesListPath(limit: number | undefined): string {
  if (limit === undefined) return "/api/Series/all-v2";
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
  return `/api/Series/all-v2?pageNumber=0&pageSize=${pageSize}`;
}

export function createMalClient(config: BridgeConfig): BridgeMalClient {
  return {
    async searchManga(series): Promise<MalSearchCandidate[]> {
      if (!config.malAccessToken) return [];
      const url = new URL("https://api.myanimelist.net/v2/manga");
      url.searchParams.set("q", series.title);
      url.searchParams.set("limit", "10");
      url.searchParams.set(
        "fields",
        "alternative_titles,media_type,start_date,num_volumes,num_chapters,authors",
      );
      const json = await malJson(config.malAccessToken, url.toString(), "GET");
      const data = (json as { data?: { node: unknown }[] }).data ?? [];
      return data.flatMap((entry) => malCandidateFromNode(entry.node));
    },

    async getCurrentProgress(malId): Promise<MalListProgress> {
      if (!config.malAccessToken) {
        return { chaptersRead: 0, volumesRead: 0, status: "plan_to_read" };
      }
      const url = `https://api.myanimelist.net/v2/manga/${malId}?fields=my_list_status,num_chapters,num_volumes`;
      const json = (await malJson(config.malAccessToken, url, "GET")) as {
        my_list_status?: {
          num_chapters_read?: number;
          num_volumes_read?: number;
          status?: MalListProgress["status"];
        };
        num_chapters?: number;
        num_volumes?: number;
      };
      return {
        chaptersRead: json.my_list_status?.num_chapters_read ?? 0,
        volumesRead: json.my_list_status?.num_volumes_read ?? 0,
        status: json.my_list_status?.status ?? "plan_to_read",
        totalChapters: json.num_chapters ?? 0,
        totalVolumes: json.num_volumes ?? 0,
      };
    },

    async updateProgress(
      malId,
      update,
    ): Promise<{ ok: true } | { ok: false; retryable: boolean; message?: string }> {
      if (!config.malAccessToken) {
        return { ok: false, retryable: false, message: "MAL_ACCESS_TOKEN is not configured." };
      }
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(update)) {
        body.set(key, String(value));
      }
      const response = await fetch(`https://api.myanimelist.net/v2/manga/${malId}/my_list_status`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${config.malAccessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (response.status === 200) return { ok: true };
      return {
        ok: false,
        retryable: response.status === 429 || response.status >= 500,
        message: `MAL update failed with status ${response.status}.`,
      };
    },
  };
}

export function createExternalIdResolver(): BridgeExternalIdResolver {
  return {
    async resolveMalId(series) {
      const aniListId = aniListIdFromSeries(series);
      if (aniListId === undefined) return undefined;
      const malId = await resolveAniListMalId(aniListId).catch(() => undefined);
      return malId === undefined ? undefined : { malId, matchMethod: "external-id", confidence: 1 };
    },
  };
}

export async function checkKavitaReadiness(config: BridgeConfig): Promise<KavitaReadinessResult> {
  if (!config.kavitaBaseUrl || !config.kavitaApiKey) {
    return { configured: false, ok: false, message: "Kavita URL or API key is not configured." };
  }
  try {
    const series = await probeKavitaSeries(config);
    return { configured: true, ok: true, seriesSeen: series.length };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message:
        error instanceof Error ? sanitizeReadinessMessage(error.message) : "Kavita check failed.",
    };
  }
}

async function probeKavitaSeries(config: BridgeConfig): Promise<unknown[]> {
  const baseUrl = normalizeBaseUrl(config.kavitaBaseUrl);
  const json = await kavitaJson(
    baseUrl,
    config.kavitaApiKey,
    "/api/Series/all-v2?pageNumber=0&pageSize=1",
    {
      method: "POST",
      body: JSON.stringify({ statements: [], combination: 0 }),
    },
  );
  return Array.isArray(json) ? json : arrayFromObject(json, ["items", "series", "value"]);
}

export async function checkMalReadiness(config: BridgeConfig): Promise<MalReadinessResult> {
  const oauthConfigured = Boolean(config.malClientId && config.malRedirectUri);
  if (!config.malAccessToken) {
    return {
      oauthConfigured,
      authorized: false,
      ok: false,
      message: "MAL OAuth token is not configured.",
    };
  }
  try {
    await malJson(config.malAccessToken, "https://api.myanimelist.net/v2/users/@me", "GET");
    return { oauthConfigured, authorized: true, ok: true };
  } catch (error) {
    return {
      oauthConfigured,
      authorized: true,
      ok: false,
      message:
        error instanceof Error ? sanitizeReadinessMessage(error.message) : "MAL check failed.",
    };
  }
}

async function kavitaJson(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`Kavita request failed with status ${response.status}.`);
  return response.json();
}

async function malJson(accessToken: string, url: string, method: "GET"): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`MAL request failed with status ${response.status}.`);
  return response.json();
}

async function resolveAniListMalId(aniListId: number): Promise<number | undefined> {
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: "query ($id: Int) { Media(id: $id, type: MANGA) { idMal } }",
      variables: { id: aniListId },
    }),
  });
  if (!response.ok) return undefined;
  const json = await response.json();
  const media = isRecord(json) && isRecord(json.data) ? json.data.Media : undefined;
  return isRecord(media) ? positiveNumberField(media, "idMal") : undefined;
}

function observedSeriesFromKavita(record: unknown): BridgeObservedSeries[] {
  if (!isRecord(record)) return [];
  const id = numberField(record, "id", "seriesId", "kavitaSeriesId");
  const title = stringField(record, "name", "localizedName", "title");
  if (id === undefined || !title) return [];
  return [
    {
      kavitaSeriesId: id,
      kavitaLibraryId: numberField(record, "libraryId"),
      libraryId: numberField(record, "libraryId"),
      title,
      altTitles: arrayStrings(record, "localizedName", "sortName", "originalName").filter(
        (value) => value && value !== title,
      ),
      authors: people(record),
      publicationYear: numberField(record, "releaseYear", "year"),
      volumeCount: numberField(record, "volumesCount", "volumeCount"),
      mediaType: mediaType(record),
      webLinks: webLinks(record),
      externalIds: externalIds(record),
      contentType:
        mediaType(record) === "light_novel" || mediaType(record) === "novel" ? "novel" : "manga",
      completedChapter: numberField(
        record,
        "latestReadChapter",
        "lastChapterNumber",
        "chaptersRead",
      ),
      completedVolume: numberField(record, "latestReadVolume", "volumesRead"),
      isSpecial: false,
    },
  ];
}

async function observedProgressFromKavitaVolumes(
  baseUrl: string,
  apiKey: string,
  seriesId: number,
  seriesTitle: string,
): Promise<
  Pick<BridgeObservedSeries, "completedChapter" | "completedVolume" | "contentType" | "mediaType">
> {
  const json = await kavitaJson(
    baseUrl,
    apiKey,
    `/api/Series/volumes?seriesId=${encodeURIComponent(String(seriesId))}`,
    { method: "GET" },
  );
  const volumes = Array.isArray(json) ? json : arrayFromObject(json, ["items", "volumes", "value"]);
  let completedChapter: number | undefined;
  let completedVolume: number | undefined;
  let detectedStandaloneBook = false;

  for (const volume of volumes) {
    if (!isRecord(volume)) continue;
    const chapters = arrayFromObject(volume, ["chapters", "Chapters"]);
    const volumeNumber = positiveNumberField(
      volume,
      "maxNumber",
      "MaxNumber",
      "minNumber",
      "MinNumber",
      "number",
      "Number",
      "name",
      "Name",
    );
    const fallbackVolumeNumber = parsedVolumeFromCandidates(
      seriesTitle,
      stringField(volume, "name", "Name", "range", "Range"),
      ...chapters
        .filter(isRecord)
        .flatMap((chapter) => [
          stringField(chapter, "range", "Range", "title", "Title", "name", "Name"),
        ]),
    );
    const resolvedVolumeNumber = volumeNumber ?? fallbackVolumeNumber;

    if (isCompletedReadItem(volume) || areAllReadableChaptersComplete(chapters)) {
      completedVolume = maxDefined(completedVolume, resolvedVolumeNumber);
    }

    if (isCompletedStandaloneBookVolume(volume, chapters)) {
      detectedStandaloneBook = true;
      completedVolume = maxDefined(completedVolume, resolvedVolumeNumber);
    }

    for (const chapter of chapters) {
      if (!isRecord(chapter) || booleanField(chapter, "isSpecial", "IsSpecial")) continue;
      if (!isCompletedReadItem(chapter)) continue;
      const chapterNumber = positiveNumberField(
        chapter,
        "maxNumber",
        "MaxNumber",
        "minNumber",
        "MinNumber",
        "number",
        "Number",
        "range",
        "Range",
        "sortOrder",
        "SortOrder",
      );
      completedChapter = maxDefined(completedChapter, chapterNumber);
    }
  }

  return {
    completedChapter,
    completedVolume,
    contentType: detectedStandaloneBook ? "novel" : undefined,
    mediaType: detectedStandaloneBook ? "light_novel" : undefined,
  };
}

function areAllReadableChaptersComplete(chapters: unknown[]): boolean {
  const readable = chapters.filter(
    (chapter) => isRecord(chapter) && !booleanField(chapter, "isSpecial", "IsSpecial"),
  );
  return (
    readable.length > 0 &&
    readable.every((chapter) => isRecord(chapter) && isCompletedReadItem(chapter))
  );
}

function isCompletedStandaloneBookVolume(
  volume: Record<string, unknown>,
  chapters: unknown[],
): boolean {
  const volumeNumber = numberField(volume, "minNumber", "MinNumber", "maxNumber", "MaxNumber");
  const hasSentinelVolume = volumeNumber === -100000;
  const chapterRecords = chapters.filter(isRecord);
  return (
    hasSentinelVolume &&
    chapterRecords.length > 0 &&
    chapterRecords.every((chapter) => booleanField(chapter, "isSpecial", "IsSpecial")) &&
    (isCompletedReadItem(volume) || chapterRecords.some((chapter) => isCompletedReadItem(chapter)))
  );
}

function isCompletedReadItem(record: Record<string, unknown>): boolean {
  const pages = positiveNumberField(record, "pages", "Pages");
  const pagesRead = numberField(record, "pagesRead", "PagesRead");
  const totalReads = numberField(record, "totalReads", "TotalReads");
  return (
    (pages !== undefined && pagesRead !== undefined && pagesRead >= pages) ||
    (totalReads !== undefined && totalReads > 0)
  );
}

function malCandidateFromNode(node: unknown): MalSearchCandidate[] {
  if (!isRecord(node)) return [];
  const id = numberField(node, "id");
  const title = stringField(node, "title");
  if (id === undefined || !title) return [];
  const alternatives = isRecord(node.alternative_titles) ? node.alternative_titles : {};
  return [
    {
      malId: id,
      title,
      altTitles: [
        ...arrayFromObject(alternatives, ["synonyms"]).filter(
          (value): value is string => typeof value === "string",
        ),
        stringField(alternatives, "en"),
        stringField(alternatives, "ja"),
      ].filter((value): value is string => Boolean(value)),
      authors: arrayFromObject(node, ["authors"]).flatMap((author) =>
        isRecord(author) && isRecord(author.node) && typeof author.node.first_name === "string"
          ? [
              `${author.node.first_name} ${typeof author.node.last_name === "string" ? author.node.last_name : ""}`.trim(),
            ]
          : [],
      ),
      mediaType: stringField(node, "media_type"),
      startYear: yearFromDate(stringField(node, "start_date")),
      volumes: numberField(node, "num_volumes"),
      chapters: numberField(node, "num_chapters"),
    },
  ];
}

function normalizeBaseUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\/api$/iu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function positiveNumberField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = numberField(record, ...keys);
  return value !== undefined && value > 0 ? value : undefined;
}

function parsedVolumeFromCandidates(...candidates: (string | undefined)[]): number | undefined {
  for (const candidate of candidates) {
    const parsed = parseExplicitVolumeNumber(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseExplicitVolumeNumber(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const match = /\b(?:volume|vol\.?|v|book|part)\s*([0-9]+(?:\.[0-9]+)?)/iu.exec(input);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 10000 ? value : undefined;
}

function booleanField(record: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return false;
}

function maxDefined(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return current === undefined ? next : Math.max(current, next);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayStrings(record: Record<string, unknown>, ...keys: string[]): string[] {
  return keys.flatMap((key) => {
    const value = record[key];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === "string");
    return typeof value === "string" ? [value] : [];
  });
}

function arrayFromObject(record: unknown, keys: string[]): unknown[] {
  if (!isRecord(record)) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function people(record: Record<string, unknown>): string[] {
  return arrayFromObject(record, ["authors", "writers", "people"]).flatMap((person) => {
    if (typeof person === "string") return [person];
    if (isRecord(person))
      return [stringField(person, "name", "fullName")].filter(Boolean) as string[];
    return [];
  });
}

function mediaType(record: Record<string, unknown>): KavitaSeriesCandidate["mediaType"] {
  const format = (stringField(record, "format", "type", "libraryType") ?? "").toLowerCase();
  if (/novel|epub|book/u.test(format)) return "light_novel";
  if (/manga|comic/u.test(format)) return "manga";
  return "unknown";
}

function webLinks(record: Record<string, unknown>): string[] {
  return arrayFromObject(record, ["webLinks", "externalLinks", "links"]).flatMap((link) => {
    if (typeof link === "string") return [link];
    if (isRecord(link)) return [stringField(link, "url", "link")].filter(Boolean) as string[];
    return [];
  });
}

function externalIds(record: Record<string, unknown>): Record<string, string | number | undefined> {
  const source = isRecord(record.externalIds) ? record.externalIds : record;
  return {
    mal: source.malId as string | number | undefined,
    myanimelist: source.myAnimeListId as string | number | undefined,
    anilist: source.aniListId as string | number | undefined,
    isbn: source.isbn as string | number | undefined,
    isbn10: source.isbn10 as string | number | undefined,
    isbn13: source.isbn13 as string | number | undefined,
  };
}

function aniListIdFromSeries(series: KavitaSeriesCandidate): number | undefined {
  const direct = positiveIntegerFromUnknown(
    series.externalIds?.anilist ?? series.externalIds?.aniListId,
  );
  if (direct !== undefined) return direct;
  for (const link of series.webLinks ?? []) {
    const match = /anilist\.co\/manga\/(\d+)/iu.exec(link);
    const id = positiveIntegerFromUnknown(match?.[1]);
    if (id !== undefined) return id;
  }
  return undefined;
}

function positiveIntegerFromUnknown(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function yearFromDate(value: string | undefined): number | undefined {
  const match = /^(\d{4})/u.exec(value ?? "");
  return match?.[1] ? Number(match[1]) : undefined;
}

function sanitizeReadinessMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer redacted")
    .replace(/x-api-key[:=]\s*[^&\s"')<>]+/giu, "x-api-key=redacted")
    .slice(0, 200);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
