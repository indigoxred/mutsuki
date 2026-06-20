import { classifyHttpStatus } from "../shared/errors.js";
import type { MalCurrentProgress, MalProgressUpdate } from "./models.js";

export interface MalRequest {
  url: string;
  method: "GET" | "PUT";
  headers?: Record<string, string>;
  body?: string;
}

export interface MalResponse {
  status: number;
  body: string;
}

export type MalTransport = (request: MalRequest) => Promise<MalResponse>;

export class MyAnimeListClient {
  constructor(
    private readonly accessToken: string,
    private readonly transport: MalTransport,
  ) {}

  async getCurrentProgress(malMangaId: string): Promise<MalCurrentProgress> {
    const json = await this.getJson(
      `https://api.myanimelist.net/v2/manga/${malMangaId}?fields=my_list_status,num_chapters,num_volumes`,
    );
    const item = json as {
      my_list_status?: { num_chapters_read?: number; num_volumes_read?: number; status?: string };
      num_chapters?: number;
      num_volumes?: number;
    };
    return {
      chaptersRead: item.my_list_status?.num_chapters_read ?? 0,
      volumesRead: item.my_list_status?.num_volumes_read ?? 0,
      status: normalizeMalStatus(item.my_list_status?.status),
      totalChapters: item.num_chapters ?? 0,
      totalVolumes: item.num_volumes ?? 0,
    };
  }

  async updateProgress(
    malMangaId: string,
    update: MalProgressUpdate,
  ): Promise<{ ok: true } | { ok: false; retryable: boolean }> {
    const body = Object.entries(update)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    const response = await this.transport({
      url: `https://api.myanimelist.net/v2/manga/${malMangaId}/my_list_status`,
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body,
    });
    if (response.status === 200) return { ok: true };
    return { ok: false, retryable: classifyHttpStatus(response.status) === "transient" };
  }

  async search(title: string): Promise<{ mangaId: string; title: string; imageUrl: string }[]> {
    const url =
      title.trim().length > 0
        ? `https://api.myanimelist.net/v2/manga?q=${encodeURIComponent(title)}&limit=30&fields=main_picture`
        : "https://api.myanimelist.net/v2/manga/ranking?limit=30&fields=main_picture";
    const json = (await this.getJson(url)) as {
      data?: { node: { id: number; title: string; main_picture?: { medium?: string } } }[];
    };
    return (json.data ?? []).map((item) => ({
      mangaId: String(item.node.id),
      title: item.node.title,
      imageUrl: item.node.main_picture?.medium ?? "",
    }));
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await this.transport({ url, method: "GET", headers: this.headers() });
    if (classifyHttpStatus(response.status) !== "ok") {
      throw new Error(`MyAnimeList request failed with status ${response.status}.`);
    }
    return JSON.parse(response.body);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, ...extra };
  }
}

function normalizeMalStatus(status: string | undefined): MalCurrentProgress["status"] {
  switch (status) {
    case "reading":
    case "completed":
    case "on_hold":
    case "dropped":
    case "plan_to_read":
      return status;
    default:
      return "plan_to_read";
  }
}
