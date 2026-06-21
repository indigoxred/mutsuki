import assert from "node:assert/strict";
import test from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import type { KavitaRequest } from "../../src/Kavita/client.js";
import { MutsukiKavitaExtension } from "../../src/Kavita/main.js";
import { DEFAULT_KAVITA_SETTINGS, type KavitaSettings } from "../../src/Kavita/settings.js";

test("a kavita-book chapter always routes to HTML details", async () => {
  installApplicationStub({
    settings: { novelRenderingMode: "static-probe" },
    scheduleRequest: async () => {
      throw new Error("static probe should not request Kavita data");
    },
  });

  const details = await new MutsukiKavitaExtension().getChapterDetails(
    novelChapter({ contentType: "comic" }),
  );

  assert.equal(details.type, "html");
  assert.ok(details.html.length > 0);
  assert.equal("pages" in details, false);
});

test("server EPUB metadata routes chapters as novels when incoming content type is stale", async () => {
  installApplicationStub({
    scheduleRequest: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/Series/7") {
        return jsonResponse({
          id: 7,
          name: "A Simple Survey",
          format: 3,
          libraryName: "Light Novels",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/Series/volumes") {
        return jsonResponse([
          {
            number: "1",
            chapters: [{ id: 55, title: "Volume 1", pages: 1 }],
          },
        ]);
      }
      if (request.method === "GET" && url.pathname === "/api/Book/55/book-info") {
        return jsonResponse({ volumeId: 8, volumeNumber: "1", pages: 1 });
      }
      if (request.method === "GET" && url.pathname === "/api/Book/55/chapters") {
        return jsonResponse([{ title: "Chapter 1", page: 0 }]);
      }
      throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
    },
  });

  const chapters = await new MutsukiKavitaExtension().getChapters(series({ contentType: "comic" }));

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.chapterId.startsWith("kavita-book:"), true);
  assert.equal(chapters[0]?.sourceManga.mangaInfo.contentType, "novel");
});

test("manga chapters still route to image-page details", async () => {
  installApplicationStub({
    scheduleRequest: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/Reader/chapter-info") {
        return jsonResponse({ pages: 2 });
      }
      throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
    },
  });

  const details = await new MutsukiKavitaExtension().getChapterDetails({
    chapterId: "kavita-chapter:55",
    sourceManga: series({ contentType: "comic" }),
    langCode: "en",
    chapNum: 12,
    title: "Chapter 12",
    additionalInfo: { kavitaChapterId: "55" },
  } as Chapter);

  assert.equal("pages" in details, true);
  assert.deepEqual(
    (details as { pages: string[] }).pages.map((url) => new URL(url).searchParams.get("page")),
    ["0", "1"],
  );
});

function installApplicationStub(input: {
  settings?: Partial<KavitaSettings>;
  scheduleRequest: (request: KavitaRequest) => Promise<unknown>;
}): void {
  Object.defineProperty(globalThis, "Application", {
    configurable: true,
    value: {
      getState: () => ({
        ...DEFAULT_KAVITA_SETTINGS,
        baseUrl: "https://kavita.example.test",
        ...input.settings,
      }),
      getSecureState: () => "secret-key",
      setState: () => undefined,
      setSecureState: () => undefined,
      Selector: () => undefined,
      scheduleRequest: input.scheduleRequest,
      arrayBufferToUTF8String: (buffer: ArrayBuffer) => new TextDecoder().decode(buffer),
    },
  });
}

function jsonResponse(body: unknown) {
  return [
    { status: 200, headers: { "content-type": "application/json" } },
    new TextEncoder().encode(JSON.stringify(body)).buffer,
  ];
}

function series(input: { contentType?: "comic" | "novel" }): SourceManga {
  return {
    mangaId: "kavita-series:7",
    mangaInfo: {
      thumbnailUrl: "",
      synopsis: "",
      primaryTitle: "Series",
      secondaryTitles: [],
      contentRating: ContentRating.EVERYONE,
      contentType: input.contentType,
    },
  };
}

function novelChapter(input: { contentType?: "comic" | "novel" }): Chapter {
  return {
    chapterId: "kavita-book:55:page:0:end:0:last:0",
    sourceManga: series(input),
    langCode: "en",
    chapNum: 1,
    title: "Chapter 1",
    additionalInfo: {
      kavitaSeriesId: "7",
      kavitaChapterId: "55",
      startPage: "0",
      endPage: "0",
    },
  } as Chapter;
}
