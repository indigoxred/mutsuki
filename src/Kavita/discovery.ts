import {
  ContentRating,
  DiscoverSectionType,
  type DiscoverSection,
  type DiscoverSectionItem,
} from "@paperback/types";

import type { KavitaClient } from "./client.js";
import type { KavitaSettings } from "./settings.js";

export function getKavitaDiscoverSections(settings: KavitaSettings): DiscoverSection[] {
  const sections: DiscoverSection[] = [];
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
): Promise<DiscoverSectionItem[]> {
  const payload =
    sectionId === "on-deck"
      ? await client.getOnDeck(0, pageSize)
      : sectionId === "recently-updated"
        ? await client.getRecentlyUpdated(0, pageSize)
        : await client.getNewlyAdded(0, pageSize);

  return asArray(payload).map((item) => ({
    type: sectionId === "recently-updated" ? "chapterUpdatesCarouselItem" : "simpleCarouselItem",
    mangaId: `kavita-series:${numberField(item, "id", "seriesId") ?? 0}`,
    chapterId: `kavita-chapter:${numberField(item, "chapterId") ?? 0}`,
    imageUrl: stringField(item, "coverImage", "imageUrl", "thumbnailUrl") ?? "",
    title: stringField(item, "name", "title", "seriesName") ?? "Untitled",
    subtitle: stringField(item, "localizedName", "libraryName"),
    contentRating: ContentRating.EVERYONE,
  })) as DiscoverSectionItem[];
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
