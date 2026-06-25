export interface MockProgressEvent {
  version: 1;
  source: "paperback-mutsuki" | "paperback-progress-provider";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  kavitaSeriesId?: number;
  kavitaChapterId?: number;
  chapterSourceId?: string;
  chapterMangaId?: string;
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
  const event: MockProgressEvent = {
    version: 1,
    source:
      input.source === "paperback-progress-provider"
        ? "paperback-progress-provider"
        : "paperback-mutsuki",
    actionId: requiredString(input.actionId, "actionId"),
    occurredAt: requiredString(input.occurredAt, "occurredAt"),
    receivedAt: requiredString(input.receivedAt, "receivedAt"),
    mangaId: requiredString(input.mangaId, "mangaId"),
    paperbackChapterId: requiredString(input.paperbackChapterId, "paperbackChapterId"),
    kavitaSeriesId: optionalPositiveInteger(input.kavitaSeriesId),
    kavitaChapterId: optionalPositiveInteger(input.kavitaChapterId),
    chapterSourceId: optionalStringOrUndefined(input.chapterSourceId),
    chapterMangaId: optionalStringOrUndefined(input.chapterMangaId),
    chapterKind: input.chapterKind === "book" ? "book" : "manga",
    chapterNum: requiredFiniteNumber(input.chapterNum, "chapterNum"),
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
