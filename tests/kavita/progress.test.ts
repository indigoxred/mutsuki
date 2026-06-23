import assert from "node:assert/strict";
import test from "node:test";

import {
  ContentRating,
  type Chapter,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import type { KavitaRequest } from "../../src/Kavita/client.js";
import { MutsukiKavitaExtension } from "../../src/Kavita/main.js";
import {
  processKavitaReadActionQueue,
  type KavitaProgressBridgeEvent,
} from "../../src/Kavita/progress.js";
import { DEFAULT_KAVITA_SETTINGS } from "../../src/Kavita/settings.js";

test("completed manga read actions mark Kavita once and acknowledge duplicate queue items", async () => {
  const marks: { seriesId: number; chapterId: number }[] = [];
  const events: KavitaProgressBridgeEvent[] = [];

  const result = await processKavitaReadActionQueue({
    actions: [
      action({ id: "a1", chapterId: "kavita-chapter:55", chapterNum: 12 }),
      action({ id: "a2", chapterId: "kavita-chapter:55", chapterNum: 12 }),
    ],
    markChapterRead: async (mark) => {
      marks.push(mark);
    },
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-23T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: ["a1", "a2"], failedItems: [] });
  assert.deepEqual(marks, [{ seriesId: 7, chapterId: 55 }]);
  assert.deepEqual(
    events.map((event) => event.actionId),
    ["a1", "a2"],
  );
  assert.equal(events[0]?.shouldMarkKavitaRead, true);
  assert.equal(events[0]?.kavitaMarkedRead, true);
});

test("split EPUB parts only mark Kavita read on the final part", async () => {
  const marks: { seriesId: number; chapterId: number }[] = [];
  const events: KavitaProgressBridgeEvent[] = [];

  const result = await processKavitaReadActionQueue({
    actions: [
      action({
        id: "part-1",
        chapterId: "kavita-book:99:segment:v1:page:0:end:95:index:0:last:0",
        chapterNum: 1,
        chapterVolume: 4,
        additionalInfo: {
          kavitaSeriesId: "7",
          kavitaChapterId: "99",
          segmentIndex: "0",
          segmentCount: "2",
          isLastInVolume: "false",
          listingMode: "physical-books",
        },
      }),
      action({
        id: "part-2",
        chapterId: "kavita-book:99:segment:v1:page:96:end:140:index:1:last:1",
        chapterNum: 2,
        chapterVolume: 4,
        additionalInfo: {
          kavitaSeriesId: "7",
          kavitaChapterId: "99",
          segmentIndex: "1",
          segmentCount: "2",
          isLastInVolume: "true",
          listingMode: "physical-books",
        },
      }),
    ],
    markChapterRead: async (mark) => {
      marks.push(mark);
    },
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-23T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: ["part-1", "part-2"], failedItems: [] });
  assert.deepEqual(marks, [{ seriesId: 7, chapterId: 99 }]);
  assert.deepEqual(
    events.map((event) => ({
      actionId: event.actionId,
      shouldMarkKavitaRead: event.shouldMarkKavitaRead,
      kavitaMarkedRead: event.kavitaMarkedRead,
      isLastInVolume: event.isLastInVolume,
    })),
    [
      {
        actionId: "part-1",
        shouldMarkKavitaRead: false,
        kavitaMarkedRead: false,
        isLastInVolume: false,
      },
      {
        actionId: "part-2",
        shouldMarkKavitaRead: true,
        kavitaMarkedRead: true,
        isLastInVolume: true,
      },
    ],
  );
});

test("failed Kavita acknowledgement keeps queued read actions retryable", async () => {
  const events: KavitaProgressBridgeEvent[] = [];

  const result = await processKavitaReadActionQueue({
    actions: [action({ id: "a1", chapterId: "kavita-chapter:55", chapterNum: 12 })],
    markChapterRead: async () => {
      throw new Error("Kavita unavailable");
    },
    sendBridgeEvent: async (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-23T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: [], failedItems: ["a1"] });
  assert.deepEqual(events, []);
});

test("unmappable read actions are failed rather than guessed", async () => {
  const result = await processKavitaReadActionQueue({
    actions: [
      action({
        id: "bad",
        mangaId: "other-source:7",
        chapterId: "other-chapter:55",
        chapterNum: 1,
        additionalInfo: {},
      }),
    ],
    markChapterRead: async () => undefined,
    now: () => new Date("2026-06-23T00:00:00.000Z"),
  });

  assert.deepEqual(result, { successfulItems: [], failedItems: ["bad"] });
});

test("Kavita extension progress provider marks Kavita and posts bridge events", async () => {
  const requests: KavitaRequest[] = [];
  installApplicationStub({
    scheduleRequest: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/Reader/mark-chapter-read") {
        return [
          { status: 200, headers: { "content-type": "application/json" } },
          new TextEncoder().encode("{}").buffer,
        ];
      }
      if (url.pathname === "/api/progress-events") {
        return [
          { status: 202, headers: { "content-type": "application/json" } },
          new TextEncoder().encode("{}").buffer,
        ];
      }
      throw new Error(`Unexpected request ${request.method} ${request.url}`);
    },
  });

  const result = await new MutsukiKavitaExtension().processChapterReadActionQueue([
    action({ id: "a1", chapterId: "kavita-chapter:55", chapterNum: 12 }),
  ]);

  assert.deepEqual(result, { successfulItems: ["a1"], failedItems: [] });
  assert.deepEqual(
    requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ["POST /api/Reader/mark-chapter-read", "POST /api/progress-events"],
  );
  assert.equal(requests[0]?.headers?.["x-api-key"], "secret-key");
  assert.equal(requests[1]?.headers?.Authorization, "Bearer bridge-token");
  const bridgeBody = JSON.parse(requests[1]?.body ?? "{}") as KavitaProgressBridgeEvent;
  assert.equal(bridgeBody.kavitaSeriesId, 7);
  assert.equal(bridgeBody.kavitaChapterId, 55);
  assert.equal(bridgeBody.kavitaMarkedRead, true);
  assert.equal(JSON.stringify(bridgeBody).includes("secret-key"), false);
});

function action(input: {
  id: string;
  mangaId?: string;
  chapterId: string;
  chapterNum: number;
  chapterVolume?: number;
  additionalInfo?: Record<string, string>;
}): TrackedMangaChapterReadAction {
  const sourceManga: SourceManga = {
    mangaId: input.mangaId ?? "kavita-series:7",
    mangaInfo: {
      primaryTitle: "Kavita Series",
      secondaryTitles: [],
      thumbnailUrl: "",
      synopsis: "",
      contentRating: ContentRating.EVERYONE,
    },
  };
  const readChapter: Chapter = {
    chapterId: input.chapterId,
    sourceManga,
    langCode: "en",
    chapNum: input.chapterNum,
    volume: input.chapterVolume,
    additionalInfo:
      input.additionalInfo ??
      ({
        kavitaSeriesId: "7",
        kavitaChapterId: input.chapterId.replace(/^kavita-chapter:/u, ""),
        isLastInVolume: "false",
      } satisfies Record<string, string>),
  } as Chapter;
  return {
    id: input.id,
    sourceManga,
    readChapter,
    chapterId: input.chapterId,
    chapterSourceId: "Kavita",
    chapterMangaId: sourceManga.mangaId,
    chapterNum: input.chapterNum,
    chapterVolume: input.chapterVolume,
    creationDate: new Date("2026-06-23T00:00:00.000Z"),
    errorCount: 0,
  };
}

function installApplicationStub(input: {
  scheduleRequest: (request: KavitaRequest) => Promise<unknown>;
}): void {
  Object.defineProperty(globalThis, "Application", {
    configurable: true,
    value: {
      getState: () => ({
        ...DEFAULT_KAVITA_SETTINGS,
        baseUrl: "https://kavita.example.test",
        progressBridgeUrl: "http://bridge.example.test",
      }),
      getSecureState: (key: string) =>
        key === "kavitaProgressBridgeToken" ? "bridge-token" : "secret-key",
      setState: () => undefined,
      setSecureState: () => undefined,
      Selector: () => undefined,
      scheduleRequest: input.scheduleRequest,
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
}
