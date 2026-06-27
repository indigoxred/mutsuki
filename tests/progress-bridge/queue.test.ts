import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentRating,
  type Chapter,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import {
  MutsukiProgressBridgeExtension,
  type ProgressBridgeEvent,
  processProgressBridgeReadActionQueue,
} from "../../src/ProgressBridge/main.js";

test("progress bridge tracker forwards queued read actions from any source", async () => {
  const events: ProgressBridgeEvent[] = [];

  const result = await processProgressBridgeReadActionQueue({
    actions: [
      action({
        id: "read-1",
        trackerMangaId: "bridge-track:a-story",
        chapterSourceId: "MangaDex",
        chapterMangaId: "mangadex-title-1",
        chapterId: "05bab466-2efc-488f-bea9-90ca849c4f11",
        chapterNum: 1,
      }),
    ],
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-25T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: ["read-1"], failedItems: [] });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "paperback-progress-provider");
  assert.equal(events[0]?.schemaVersion, 2);
  assert.equal(events[0]?.eventSource, "paperback-progress-bridge");
  assert.equal(events[0]?.readingSourceId, "MangaDex");
  assert.equal(events[0]?.readingSourceName, "MangaDex");
  assert.equal(events[0]?.readingSourceKind, "external");
  assert.equal(events[0]?.sourceMangaId, "mangadex-title-1");
  assert.equal(events[0]?.sourceChapterId, "05bab466-2efc-488f-bea9-90ca849c4f11");
  assert.equal(events[0]?.sourceChapterNumber, 1);
  assert.equal(events[0]?.mangaId, "bridge-track:a-story");
  assert.equal(events[0]?.chapterSourceId, "MangaDex");
  assert.equal(events[0]?.chapterMangaId, "mangadex-title-1");
  assert.equal(events[0]?.paperbackChapterId, "05bab466-2efc-488f-bea9-90ca849c4f11");
  assert.equal(events[0]?.shouldMarkKavitaRead, false);
  assert.equal(events[0]?.kavitaMarkedRead, false);
});

test("progress bridge tracker resolves source titles and fallback chapter labels", async () => {
  const events: ProgressBridgeEvent[] = [];

  await processProgressBridgeReadActionQueue({
    actions: [
      action({
        id: "read-1",
        trackerMangaId: "bridge-track:a-story",
        chapterSourceId: "MangaDex",
        chapterMangaId: "mangadex-title-1",
        chapterId: "chapter-12",
        chapterNum: 12,
        chapterVolume: 0,
        sourceTitle: "A Story About Wanting to Commit Suicide",
        chapterTitle: "",
      }),
    ],
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-25T00:00:00.000Z"),
  });

  assert.equal(events[0]?.sourceTitle, "A Story About Wanting to Commit Suicide");
  assert.equal(events[0]?.sourceTitle, events[0]?.sourceTitleForMatching);
  assert.equal(events[0]?.title, "Chapter 12");
  assert.equal(events[0]?.chapterNum, 12);
  assert.equal(events[0]?.chapterVolume, 0);
});

test("progress bridge tracker preserves exact Kavita identifiers when the read source is Kavita", async () => {
  const events: ProgressBridgeEvent[] = [];

  await processProgressBridgeReadActionQueue({
    actions: [
      action({
        id: "read-kavita",
        trackerMangaId: "bridge-track:kavita-story",
        chapterSourceId: "Kavita",
        chapterMangaId: "kavita-series:7",
        chapterId: "kavita-book:99:whole:v1",
        chapterNum: 1,
        chapterVolume: 4,
        sourceTitle: "Kavita Story",
        chapterTitle: "Volume 4",
        additionalInfo: {
          kavitaSeriesId: "7",
          kavitaChapterId: "99",
          isLastInVolume: "true",
          listingMode: "physical-books",
        },
      }),
    ],
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-25T00:00:00.000Z"),
  });

  assert.equal(events[0]?.readingSourceKind, "kavita");
  assert.equal(events[0]?.readingSourceId, "Kavita");
  assert.equal(events[0]?.kavitaSeriesId, 7);
  assert.equal(events[0]?.kavitaChapterId, 99);
  assert.equal(events[0]?.chapterKind, "book");
  assert.equal(events[0]?.isLastInVolume, true);
  assert.equal(events[0]?.shouldMarkKavitaRead, false);
});

test("progress bridge tracker leaves failed posts retryable", async () => {
  const result = await processProgressBridgeReadActionQueue({
    actions: [
      action({
        id: "read-1",
        trackerMangaId: "bridge-track:a-story",
        chapterSourceId: "MangaDex",
        chapterMangaId: "mangadex-title-1",
        chapterId: "chapter-1",
        chapterNum: 1,
      }),
    ],
    sendBridgeEvent: async () => {
      throw new Error("bridge unavailable");
    },
    now: () => new Date("2026-06-25T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: [], failedItems: ["read-1"] });
});

test("progress bridge tracker exposes a queue surface and neutral progress marker", async () => {
  installApplicationStub();
  const tracker = new MutsukiProgressBridgeExtension();
  const source = sourceManga("bridge-track:a-story");

  const form = await tracker.getMangaProgressManagementForm(source);
  const progress = await tracker.getMangaProgress(source);

  assert.ok(form);
  assert.equal(progress?.sourceManga, source);
  assert.equal(progress?.lastReadChapter.chapNum, 0);
  assert.equal(typeof tracker.processChapterReadActionQueue, "function");
});

test("progress bridge tracker search returns a stable synthetic tracking target", async () => {
  installApplicationStub();
  const result = await new MutsukiProgressBridgeExtension().getSearchResults(
    { title: "A Story" },
    undefined,
    undefined,
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.mangaId, "bridge-track:a-story");
  assert.equal(result.items[0]?.title, "A Story");
  assert.match(result.items[0]?.imageUrl ?? "", /^https:\/\//u);
  assert.doesNotThrow(() => new URL(result.items[0]?.imageUrl ?? ""));
});

test("progress bridge tracking target uses a Paperback-valid thumbnail URL", async () => {
  installApplicationStub();
  const sourceManga = await new MutsukiProgressBridgeExtension().getMangaDetails(
    "bridge-track:a-story",
  );

  assert.match(sourceManga.mangaInfo.thumbnailUrl, /^https:\/\//u);
  assert.doesNotThrow(() => new URL(sourceManga.mangaInfo.thumbnailUrl));
});

function action(input: {
  id: string;
  trackerMangaId: string;
  chapterSourceId: string;
  chapterMangaId: string;
  chapterId: string;
  chapterNum: number;
  chapterVolume?: number;
  sourceTitle?: string;
  chapterTitle?: string;
  additionalInfo?: Record<string, string>;
}): TrackedMangaChapterReadAction {
  const trackerManga = sourceManga(input.trackerMangaId);
  const sourceMangaForChapter = sourceManga(input.chapterMangaId, input.sourceTitle);
  const readChapter: Chapter = {
    chapterId: input.chapterId,
    sourceManga: sourceMangaForChapter,
    langCode: "en",
    chapNum: input.chapterNum,
    volume: input.chapterVolume,
    title: input.chapterTitle ?? `Chapter ${input.chapterNum}`,
    additionalInfo: input.additionalInfo,
  };
  return {
    id: input.id,
    sourceManga: trackerManga,
    readChapter,
    chapterId: input.chapterId,
    chapterSourceId: input.chapterSourceId,
    chapterMangaId: input.chapterMangaId,
    chapterNum: input.chapterNum,
    chapterVolume: input.chapterVolume,
    creationDate: new Date("2026-06-25T00:00:00.000Z"),
    errorCount: 0,
  };
}

function sourceManga(mangaId: string, title = mangaId): SourceManga {
  return {
    mangaId,
    mangaInfo: {
      primaryTitle: title,
      secondaryTitles: [],
      thumbnailUrl: "",
      synopsis: "",
      contentRating: ContentRating.EVERYONE,
    },
  };
}

function installApplicationStub(): void {
  Object.defineProperty(globalThis, "Application", {
    configurable: true,
    value: {
      getState: () => ({}),
      getSecureState: () => "",
      setState: () => undefined,
      setSecureState: () => undefined,
      Selector: () => undefined,
      scheduleRequest: async () => [
        { status: 202, headers: { "content-type": "application/json" } },
        new TextEncoder().encode("{}").buffer,
      ],
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
}
