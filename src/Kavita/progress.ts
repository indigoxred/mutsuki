import type {
  ChapterReadActionQueueProcessingResult,
  TrackedMangaChapterReadAction,
} from "@paperback/types";

import { kavitaSeriesIdFromMangaId } from "./metadata.js";
import { parseFinalInVolumeFromChapterId } from "./toc.js";
import type { KavitaClient } from "./client.js";

export type KavitaChapterKind = "manga" | "book";

export interface KavitaProgressBridgeEvent {
  version: 1;
  schemaVersion: 2;
  source: "paperback-mutsuki";
  eventSource: "mutsuki-kavita-source";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  readingSourceId: "Kavita";
  readingSourceName: "Mutsuki Kavita";
  readingSourceKind: "kavita";
  sourceMangaId: string;
  sourceChapterId: string;
  sourceChapterNumber: number;
  sourceChapterVolume?: number;
  kavitaSeriesId: number;
  kavitaChapterId: number;
  chapterKind: KavitaChapterKind;
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

export interface KavitaReadQueueProcessorInput {
  actions: TrackedMangaChapterReadAction[];
  markChapterRead: (input: { seriesId: number; chapterId: number }) => Promise<void>;
  sendBridgeEvent?: (event: KavitaProgressBridgeEvent) => Promise<void>;
  now?: () => Date;
}

export async function markKavitaCompletedIfSafe(input: {
  client: KavitaClient;
  seriesId: number;
  chapterId: number;
  paperbackChapterId: string;
}): Promise<boolean> {
  if (
    input.paperbackChapterId.startsWith("kavita-book:") &&
    !parseFinalInVolumeFromChapterId(input.paperbackChapterId)
  ) {
    return false;
  }
  await input.client.markChapterRead({ seriesId: input.seriesId, chapterId: input.chapterId });
  return true;
}

export async function processKavitaReadActionQueue(
  input: KavitaReadQueueProcessorInput,
): Promise<ChapterReadActionQueueProcessingResult> {
  const successfulItems: string[] = [];
  const failedItems: string[] = [];
  const markedKeys = new Set<string>();
  const markedResults = new Map<string, boolean>();

  for (const action of input.actions) {
    const mapped = kavitaReadActionFromPaperback(action, input.now?.() ?? new Date());
    if (mapped === undefined) {
      failedItems.push(action.id);
      continue;
    }

    try {
      let kavitaMarkedRead = false;
      if (mapped.shouldMarkKavitaRead) {
        const key = `${mapped.kavitaSeriesId}:${mapped.kavitaChapterId}`;
        if (!markedKeys.has(key)) {
          await input.markChapterRead({
            seriesId: mapped.kavitaSeriesId,
            chapterId: mapped.kavitaChapterId,
          });
          markedKeys.add(key);
          markedResults.set(key, true);
        }
        kavitaMarkedRead = markedResults.get(key) === true;
      }

      if (input.sendBridgeEvent) {
        await input.sendBridgeEvent({ ...mapped, kavitaMarkedRead });
      }

      successfulItems.push(action.id);
    } catch {
      failedItems.push(action.id);
    }
  }

  return { successfulItems, failedItems };
}

function kavitaReadActionFromPaperback(
  action: TrackedMangaChapterReadAction,
  receivedAt: Date,
): Omit<KavitaProgressBridgeEvent, "kavitaMarkedRead"> | undefined {
  const additionalInfo = action.readChapter?.additionalInfo ?? {};
  const kavitaSeriesId = integerValue(additionalInfo.kavitaSeriesId) ?? seriesIdFromAction(action);
  const kavitaChapterId =
    integerValue(additionalInfo.kavitaChapterId) ?? chapterIdFromPaperbackId(action.chapterId);
  if (kavitaSeriesId === undefined || kavitaChapterId === undefined) return undefined;

  const chapterKind: KavitaChapterKind = action.chapterId.startsWith("kavita-book:")
    ? "book"
    : "manga";
  const isLastInVolume =
    additionalInfo.isLastInVolume === "true" || parseFinalInVolumeFromChapterId(action.chapterId);
  const isSplitBookPart =
    chapterKind === "book" &&
    (action.chapterId.includes(":segment:") || integerValue(additionalInfo.segmentCount) !== 1);
  const shouldMarkKavitaRead = chapterKind === "manga" || !isSplitBookPart || isLastInVolume;

  return {
    version: 1,
    schemaVersion: 2,
    source: "paperback-mutsuki",
    eventSource: "mutsuki-kavita-source",
    actionId: action.id,
    occurredAt: dateToIso(action.creationDate),
    receivedAt: receivedAt.toISOString(),
    mangaId: action.sourceManga.mangaId,
    paperbackChapterId: action.chapterId,
    readingSourceId: "Kavita",
    readingSourceName: "Mutsuki Kavita",
    readingSourceKind: "kavita",
    sourceMangaId: action.chapterMangaId || action.sourceManga.mangaId,
    sourceChapterId: action.chapterId,
    sourceChapterNumber: action.chapterNum,
    sourceChapterVolume: action.chapterVolume,
    kavitaSeriesId,
    kavitaChapterId,
    chapterKind,
    chapterNum: action.chapterNum,
    chapterVolume: action.chapterVolume,
    isLastInVolume,
    shouldMarkKavitaRead,
    title: action.readChapter?.title ?? "",
    listingMode: additionalInfo.listingMode ?? "",
    role: additionalInfo.role ?? "",
    segmentIndex: integerValue(additionalInfo.segmentIndex),
    segmentCount: integerValue(additionalInfo.segmentCount),
  };
}

function seriesIdFromAction(action: TrackedMangaChapterReadAction): number | undefined {
  try {
    return kavitaSeriesIdFromMangaId(action.chapterMangaId || action.sourceManga.mangaId);
  } catch {
    return undefined;
  }
}

function chapterIdFromPaperbackId(chapterId: string): number | undefined {
  const match = /^kavita-(?:chapter|book):(\d+)/u.exec(chapterId);
  return match ? integerValue(match[1]) : undefined;
}

function integerValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function dateToIso(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
}
