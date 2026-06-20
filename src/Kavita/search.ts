import { ContentRating, type SearchResultItem } from "@paperback/types";

import type { KavitaClient } from "./client.js";

export async function searchKavita(
  client: KavitaClient,
  title: string,
  pageSize: number,
): Promise<SearchResultItem[]> {
  const payload = await client.searchSeries(title, 0, pageSize);
  const items = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items
      : [];

  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      mangaId: `kavita-series:${numberValue(item.id) ?? numberValue(item.seriesId) ?? 0}`,
      title: stringValue(item.name ?? item.title ?? item.localizedName) ?? "Untitled",
      imageUrl: stringValue(item.coverImage ?? item.thumbnailUrl ?? item.imageUrl) ?? "",
      contentRating: ContentRating.EVERYONE,
    }));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
