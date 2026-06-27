export interface MockProgressEvent {
  version: 1;
  schemaVersion: 1 | 2;
  source: "paperback-mutsuki" | "paperback-progress-provider";
  eventSource: "mutsuki-kavita-source" | "paperback-progress-bridge";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  kavitaSeriesId?: number;
  kavitaChapterId?: number;
  chapterSourceId?: string;
  chapterMangaId?: string;
  readingSourceId: string;
  readingSourceName: string;
  readingSourceKind: "kavita" | "external" | "unknown";
  sourceMangaId: string;
  sourceChapterId: string;
  sourceChapterNumber: number;
  sourceChapterVolume?: number;
  chapterKind: "manga" | "book";
  chapterNum: number;
  chapterVolume?: number;
  isLastInVolume: boolean;
  shouldMarkKavitaRead: boolean;
  kavitaMarkedRead: boolean;
  title: string;
  listingMode: string;
  role: string;
  trackedTitle?: string;
  sourceTitle?: string;
  segmentIndex?: number;
  segmentCount?: number;
}

export function parseMockProgressEvent(input: unknown): MockProgressEvent {
  if (!isRecord(input)) throw new Error("Event must be an object.");
  const source =
    input.source === "paperback-progress-provider"
      ? "paperback-progress-provider"
      : "paperback-mutsuki";
  const chapterSourceId = optionalStringOrUndefined(input.chapterSourceId);
  const chapterMangaId = optionalStringOrUndefined(input.chapterMangaId);
  const kavitaSeriesId = optionalPositiveInteger(input.kavitaSeriesId);
  const readingSourceId =
    optionalStringOrUndefined(input.readingSourceId) ??
    chapterSourceId ??
    (kavitaSeriesId !== undefined || source === "paperback-mutsuki" ? "Kavita" : "unknown");
  const chapterNum = requiredFiniteNumber(input.chapterNum, "chapterNum");
  const event: MockProgressEvent = {
    version: 1,
    schemaVersion: input.schemaVersion === 2 ? 2 : 1,
    source,
    eventSource:
      input.eventSource === "paperback-progress-bridge"
        ? "paperback-progress-bridge"
        : source === "paperback-progress-provider"
          ? "paperback-progress-bridge"
          : "mutsuki-kavita-source",
    actionId: requiredString(input.actionId, "actionId"),
    occurredAt: requiredString(input.occurredAt, "occurredAt"),
    receivedAt: requiredString(input.receivedAt, "receivedAt"),
    mangaId: requiredString(input.mangaId, "mangaId"),
    paperbackChapterId: requiredString(input.paperbackChapterId, "paperbackChapterId"),
    kavitaSeriesId,
    kavitaChapterId: optionalPositiveInteger(input.kavitaChapterId),
    chapterSourceId,
    chapterMangaId,
    readingSourceId,
    readingSourceName: optionalStringOrUndefined(input.readingSourceName) ?? readingSourceId,
    readingSourceKind: readingSourceKind(input.readingSourceKind, readingSourceId),
    sourceMangaId:
      optionalStringOrUndefined(input.sourceMangaId) ??
      chapterMangaId ??
      requiredString(input.mangaId, "mangaId"),
    sourceChapterId:
      optionalStringOrUndefined(input.sourceChapterId) ??
      requiredString(input.paperbackChapterId, "paperbackChapterId"),
    sourceChapterNumber: optionalFiniteNumber(input.sourceChapterNumber) ?? chapterNum,
    sourceChapterVolume: optionalFiniteNumber(input.sourceChapterVolume),
    chapterKind: input.chapterKind === "book" ? "book" : "manga",
    chapterNum,
    chapterVolume: optionalFiniteNumber(input.chapterVolume),
    isLastInVolume: Boolean(input.isLastInVolume),
    shouldMarkKavitaRead: Boolean(input.shouldMarkKavitaRead),
    kavitaMarkedRead: Boolean(input.kavitaMarkedRead),
    title: optionalString(input.title),
    listingMode: optionalString(input.listingMode),
    role: optionalString(input.role),
    trackedTitle: optionalStringOrUndefined(input.trackedTitle),
    sourceTitle: optionalStringOrUndefined(input.sourceTitle),
    segmentIndex: optionalPositiveInteger(input.segmentIndex),
    segmentCount: optionalPositiveInteger(input.segmentCount),
  };
  return event;
}

function readingSourceKind(value: unknown, sourceId: string): "kavita" | "external" | "unknown" {
  if (value === "kavita" || value === "external" || value === "unknown") return value;
  if (/^(?:kavita|mutsuki(?:\s|-)?kavita)$/iu.test(sourceId)) return "kavita";
  return sourceId === "unknown" ? "unknown" : "external";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}.`);
  return value.slice(0, 500);
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 500) : "";
}

function optionalStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.slice(0, 500);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function requiredFiniteNumber(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}.`);
  return parsed;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
