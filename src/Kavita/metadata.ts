import { ContentRating, type SourceManga } from "@paperback/types";

export function sourceMangaFromKavitaSeries(
  series: unknown,
  coverUrlForSeries?: (seriesId: number) => string,
): SourceManga {
  const item =
    typeof series === "object" && series !== null ? (series as Record<string, unknown>) : {};
  const id = numberField(item, "id", "seriesId") ?? 0;
  const format = kavitaFormatName(item.format ?? item.seriesFormat);
  const libraryType = stringField(item, "libraryType", "libraryName")?.toLowerCase() ?? "";
  const isNovel =
    format.includes("epub") || libraryType.includes("book") || libraryType.includes("novel");

  return {
    mangaId: `kavita-series:${id}`,
    mangaInfo: {
      thumbnailUrl: id > 0 && coverUrlForSeries ? coverUrlForSeries(id) : absoluteImageUrl(item),
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

function kavitaFormatName(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase();
  if (value === 0) return "image";
  if (value === 1) return "archive";
  if (value === 3) return "epub";
  if (value === 4) return "pdf";
  return "";
}

function absoluteImageUrl(item: Record<string, unknown>): string {
  const raw = stringField(item, "imageUrl", "thumbnailUrl", "coverImage");
  return raw?.startsWith("http://") || raw?.startsWith("https://") ? raw : "";
}
