export interface MockProgressEvent {
  version: 1;
  source: "paperback-mutsuki";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  kavitaSeriesId: number;
  kavitaChapterId: number;
  chapterKind: "manga" | "book";
  chapterNum: number;
  chapterVolume?: number;
  isLastInVolume: boolean;
  shouldMarkKavitaRead: boolean;
  kavitaMarkedRead: boolean;
  title: string;
  listingMode: string;
  role: string;
  segmentIndex?: number;
  segmentCount?: number;
}

export function parseMockProgressEvent(input: unknown): MockProgressEvent {
  if (!isRecord(input)) throw new Error("Event must be an object.");
  const event: MockProgressEvent = {
    version: 1,
    source: "paperback-mutsuki",
    actionId: requiredString(input.actionId, "actionId"),
    occurredAt: requiredString(input.occurredAt, "occurredAt"),
    receivedAt: requiredString(input.receivedAt, "receivedAt"),
    mangaId: requiredString(input.mangaId, "mangaId"),
    paperbackChapterId: requiredString(input.paperbackChapterId, "paperbackChapterId"),
    kavitaSeriesId: requiredPositiveInteger(input.kavitaSeriesId, "kavitaSeriesId"),
    kavitaChapterId: requiredPositiveInteger(input.kavitaChapterId, "kavitaChapterId"),
    chapterKind: input.chapterKind === "book" ? "book" : "manga",
    chapterNum: requiredFiniteNumber(input.chapterNum, "chapterNum"),
    chapterVolume: optionalFiniteNumber(input.chapterVolume),
    isLastInVolume: Boolean(input.isLastInVolume),
    shouldMarkKavitaRead: Boolean(input.shouldMarkKavitaRead),
    kavitaMarkedRead: Boolean(input.kavitaMarkedRead),
    title: optionalString(input.title),
    listingMode: optionalString(input.listingMode),
    role: optionalString(input.role),
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

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${field}.`);
  return parsed;
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
