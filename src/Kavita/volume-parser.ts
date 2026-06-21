import type { KavitaChapterDto } from "./chapter-mapper.js";

export function parseKavitaChapterDtos(payload: unknown): KavitaChapterDto[] {
  return containers(payload).flatMap((container) => {
    const volumeNumber = stringValue(container.volumeNumber ?? container.number ?? container.name);
    const children = Array.isArray(container.chapters) ? container.chapters : undefined;
    if (children) {
      return children.flatMap((chapter) => toChapterDto(chapter, volumeNumber));
    }
    return toChapterDto(container, volumeNumber);
  });
}

function containers(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (isRecord(payload) && Array.isArray(payload.items)) return payload.items.filter(isRecord);
  if (isRecord(payload) && Array.isArray(payload.volumes)) return payload.volumes.filter(isRecord);
  return [];
}

function toChapterDto(value: unknown, volumeNumber: string | undefined): KavitaChapterDto[] {
  if (!isRecord(value)) return [];
  const id = numberValue(value.id ?? value.chapterId);
  if (id === undefined) return [];
  const publishDate = stringValue(value.releaseDate ?? value.created ?? value.lastModified);
  const isSpecial = booleanValue(value.isSpecial) ?? false;
  const chapter: KavitaChapterDto = {
    id,
    title: stringValue(value.titleName ?? value.title ?? value.name ?? value.chapterTitle),
    chapterNumber: isSpecial
      ? undefined
      : stringValue(value.minNumber ?? value.chapterNumber ?? value.number ?? value.range),
    volumeNumber: stringValue(value.volumeNumber) ?? volumeNumber,
    pages: numberValue(value.pages ?? value.pageCount) ?? 0,
    isSpecial,
  };
  if (publishDate !== undefined) chapter.publishDate = publishDate;
  return [chapter];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
