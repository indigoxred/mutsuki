import { ContentRating, type SourceManga } from "@paperback/types";

export function sourceMangaFromKavitaSeries(series: unknown): SourceManga {
  const item =
    typeof series === "object" && series !== null ? (series as Record<string, unknown>) : {};
  const id = numberField(item, "id", "seriesId") ?? 0;
  const format = stringField(item, "format", "seriesFormat")?.toLowerCase() ?? "";
  const libraryType = stringField(item, "libraryType")?.toLowerCase() ?? "";
  const isNovel =
    format.includes("epub") || libraryType.includes("book") || libraryType.includes("novel");

  return {
    mangaId: `kavita-series:${id}`,
    mangaInfo: {
      thumbnailUrl: stringField(item, "coverImage", "thumbnailUrl", "imageUrl") ?? "",
      synopsis: stringField(item, "summary", "synopsis") ?? "",
      primaryTitle: stringField(item, "name", "title", "localizedName") ?? "Untitled",
      secondaryTitles: arrayOfStrings(item.alternateTitles),
      contentRating: ContentRating.EVERYONE,
      contentType: isNovel ? "novel" : "comic",
      status: stringField(item, "status"),
      author: arrayOfStrings(item.writers ?? item.authors).join(", ") || undefined,
      artist: arrayOfStrings(item.artists).join(", ") || undefined,
      additionalInfo: {
        kavitaSeriesId: String(id),
        libraryId: String(numberField(item, "libraryId") ?? ""),
        format,
      },
    },
  };
}

export function kavitaSeriesIdFromMangaId(mangaId: string): number {
  const id = Number(mangaId.replace(/^kavita-series:/u, ""));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid Kavita manga id: ${mangaId}`);
  return id;
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

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
