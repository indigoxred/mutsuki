import { classifyHttpStatus } from "../shared/errors.js";
import { assertSameOrigin, normalizeKavitaBaseUrl, toKavitaApiUrl } from "../shared/url.js";
import type { KavitaTocItem, ResourceFetchResult } from "./models.js";

export interface KavitaRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface KavitaResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string | ArrayBuffer;
}

export type KavitaTransport = (request: KavitaRequest) => Promise<KavitaResponse>;

export interface KavitaClientOptions {
  baseUrl: string;
  apiKey: string;
  transport: KavitaTransport;
}

export class KavitaClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly transport: KavitaTransport;

  constructor(options: KavitaClientOptions) {
    this.baseUrl = normalizeKavitaBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.transport = options.transport;
  }

  async testConnection(): Promise<unknown> {
    return this.getJson("/Account/validate");
  }

  async getLibraries(): Promise<unknown> {
    return this.getJson("/Library/libraries");
  }

  async getSeriesForLibrary(libraryId: number, pageNumber = 0, pageSize = 50): Promise<unknown> {
    return this.getJson("/Series/all-v2", { libraryId, pageNumber, pageSize });
  }

  async searchSeries(query: string, pageNumber = 0, pageSize = 50): Promise<unknown> {
    return this.getJson("/Search/series", { query, pageNumber, pageSize });
  }

  async getSeriesDetails(seriesId: number): Promise<unknown> {
    return this.getJson(`/Series/${seriesId}`);
  }

  async getVolumes(seriesId: number): Promise<unknown> {
    return this.getJson("/Series/volumes", { seriesId });
  }

  async getChapterInfo(chapterId: number, extractPdf = false): Promise<unknown> {
    return this.getJson("/Reader/chapter-info", {
      chapterId,
      extractPdf,
      includeDimensions: false,
    });
  }

  async getOnDeck(pageNumber = 0, pageSize = 50): Promise<unknown> {
    return this.getJson("/Series/on-deck", { pageNumber, pageSize });
  }

  async getRecentlyUpdated(pageNumber = 0, pageSize = 50): Promise<unknown> {
    return this.getJson("/Series/recently-updated", { pageNumber, pageSize });
  }

  async getNewlyAdded(pageNumber = 0, pageSize = 50): Promise<unknown> {
    return this.getJson("/Series/newly-added", { pageNumber, pageSize });
  }

  async getBookInfo(chapterId: number): Promise<unknown> {
    return this.getJson(`/Book/${chapterId}/book-info`);
  }

  async getBookChapters(chapterId: number): Promise<KavitaTocItem[]> {
    return (await this.getJson(`/Book/${chapterId}/chapters`)) as KavitaTocItem[];
  }

  async getBookPage(chapterId: number, page: number): Promise<string> {
    return String(await this.getJson(`/Book/${chapterId}/book-page`, { page }));
  }

  async getBookResource(chapterId: number, file: string): Promise<ResourceFetchResult> {
    const response = await this.request("GET", `/Book/${chapterId}/book-resources`, { file });
    const body =
      typeof response.body === "string"
        ? new TextEncoder().encode(response.body).buffer
        : response.body;
    return {
      bytes: body,
      mimeType: response.headers["content-type"] ?? guessMimeType(file),
    };
  }

  getImagePageUrl(input: { chapterId: number; page: number; extractPdf?: boolean }): string {
    const url = toKavitaApiUrl(this.baseUrl, "/Reader/image", {
      chapterId: input.chapterId,
      page: input.page,
      extractPdf: input.extractPdf ?? false,
      apiKey: this.apiKey,
    });
    assertSameOrigin(this.baseUrl, url);
    return url;
  }

  async markChapterRead(input: {
    seriesId: number;
    chapterId: number;
    generateReadingSession?: boolean;
  }): Promise<void> {
    await this.request("POST", "/Reader/mark-chapter-read", undefined, {
      seriesId: input.seriesId,
      chapterId: input.chapterId,
      generateReadingSession: input.generateReadingSession ?? false,
    });
  }

  private async getJson(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown> {
    const response = await this.request("GET", path, query);
    if (typeof response.body !== "string") {
      return JSON.parse(new TextDecoder().decode(response.body));
    }
    try {
      return JSON.parse(response.body);
    } catch {
      return response.body;
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<KavitaResponse> {
    const url = toKavitaApiUrl(this.baseUrl, path, query);
    assertSameOrigin(this.baseUrl, url);
    const response = await this.transport({
      url,
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const statusClass = classifyHttpStatus(response.status);
    if (statusClass !== "ok") {
      throw new Error(`Kavita request failed with ${statusClass} status ${response.status}.`);
    }

    return response;
  }
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
