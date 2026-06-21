import {
  ContentRating,
  DiscoverSectionType,
  type DiscoverSection,
  type DiscoverSectionItem,
  type Metadata,
  type PagedResults,
} from "@paperback/types";

import type { KavitaClient } from "./client.js";
import type { KavitaSettings } from "./settings.js";

export function getKavitaDiscoverSections(settings: KavitaSettings): DiscoverSection[] {
  const sections: DiscoverSection[] = [
    { id: "all-series", title: "All Series", type: DiscoverSectionType.simpleCarousel },
  ];
  if (settings.showOnDeck)
    sections.push({ id: "on-deck", title: "On Deck", type: DiscoverSectionType.prominentCarousel });
  if (settings.showRecentlyUpdated) {
    sections.push({
      id: "recently-updated",
      title: "Recently Updated",
      type: DiscoverSectionType.chapterUpdates,
    });
  }
  if (settings.showNewlyAdded)
    sections.push({
      id: "newly-added",
      title: "Newly Added",
      type: DiscoverSectionType.simpleCarousel,
    });
  return sections;
}

export async function getKavitaDiscoverItems(
  client: KavitaClient,
  sectionId: string,
  pageSize: number,
  metadata?: Metadata,
): Promise<PagedResults<DiscoverSectionItem>> {
  const pageNumber = pageNumberFromMetadata(metadata);
  const payload =
    sectionId === "all-series"
      ? await client.getAllSeries(pageNumber, pageSize)
      : sectionId === "on-deck"
        ? await client.getOnDeck(pageNumber, pageSize)
        : sectionId === "recently-updated"
          ? await client.getRecentlyUpdated(pageNumber, pageSize)
          : sectionId === "newly-added"
            ? await client.getNewlyAdded(pageNumber, pageSize)
            : undefined;

  if (payload === undefined) throw new Error(`Unknown Kavita discover section: ${sectionId}`);

  const records = asArray(payload);
  const items = records.map((item) => {
    const seriesId = numberField(item, "seriesId", "id") ?? 0;
    const baseItem = {
      mangaId: `kavita-series:${seriesId}`,
      imageUrl: imageUrlForSeries(client, seriesId, item),
      title: stringField(item, "name", "title", "seriesName") ?? "Untitled",
      subtitle: stringField(item, "localizedName", "libraryName"),
      contentRating: ContentRating.EVERYONE,
    };
    if (sectionId === "recently-updated") {
      if (isEpubItem(item)) {
        return {
          type: "simpleCarouselItem",
          ...baseItem,
        };
      }
      return {
        type: "chapterUpdatesCarouselItem",
        ...baseItem,
        chapterId: `kavita-chapter:${numberField(item, "chapterId") ?? 0}`,
      };
    }
    return {
      type: "simpleCarouselItem",
      ...baseItem,
      chapterId: `kavita-chapter:${numberField(item, "chapterId") ?? 0}`,
    };
  }) as DiscoverSectionItem[];

  return {
    items,
    metadata: records.length >= pageSize ? { page: pageNumber + 1 } : undefined,
  };
}

function asArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload))
    return payload.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { items?: unknown }).items)
  ) {
    return (payload as { items: unknown[] }).items.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  }
  return [];
}

function stringField(item: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberField(item: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function isEpubItem(item: Record<string, unknown>): boolean {
  const format = formatName(item.format ?? item.seriesFormat);
  const library = stringField(item, "libraryType", "libraryName")?.toLowerCase() ?? "";
  return format.includes("epub") || library.includes("book") || library.includes("novel");
}

function formatName(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value === 3) return "epub";
  return "";
}

function imageUrlForSeries(
  client: KavitaClient,
  seriesId: number,
  item: Record<string, unknown>,
): string {
  if (seriesId > 0) return client.getSeriesCoverUrl(seriesId);
  const raw = stringField(item, "imageUrl", "thumbnailUrl", "coverImage");
  return raw?.startsWith("http://") || raw?.startsWith("https://") ? raw : "";
}

function pageNumberFromMetadata(metadata: Metadata | undefined): number {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return 0;
  const page = metadata.page;
  return typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : 0;
}
