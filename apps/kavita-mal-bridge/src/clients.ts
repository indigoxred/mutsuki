import type { BridgeConfig } from "./config.js";
import type { KavitaSeriesCandidate, MalSearchCandidate } from "./matching.js";
import type { MalListProgress } from "./policy.js";
import type { BridgeKavitaClient, BridgeMalClient, BridgeObservedSeries } from "./sync.js";

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
    async listSeries(): Promise<BridgeObservedSeries[]> {
      const json = await kavitaJson(baseUrl, config.kavitaApiKey, "/api/Series/all-v2", {
        method: "POST",
        body: JSON.stringify({ statements: [], combination: 0 }),
      });
      const records = Array.isArray(json)
        ? json
        : arrayFromObject(json, ["items", "series", "value"]);
      return records.flatMap((record) => observedSeriesFromKavita(record));
    },
  };
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

export async function checkKavitaReadiness(config: BridgeConfig): Promise<KavitaReadinessResult> {
  if (!config.kavitaBaseUrl || !config.kavitaApiKey) {
    return { configured: false, ok: false, message: "Kavita URL or API key is not configured." };
  }
  try {
    const series = await createKavitaClient(config).listSeries();
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
  };
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
