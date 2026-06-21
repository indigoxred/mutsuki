import assert from "node:assert/strict";
import test from "node:test";

import { ContentRating, type Chapter, type SourceManga } from "@paperback/types";

import type { KavitaClient } from "../../src/Kavita/client.js";
import {
  getNovelChapterDetails,
  getNovelChaptersFromBook,
  STATIC_PROBE_HTML,
} from "../../src/Kavita/novel-reader.js";

test("does not expose zero-page Kavita book placeholders as readable chapters", async () => {
  let requestedToc = false;
  const chapters = await getNovelChaptersFromBook({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Novel",
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
        contentType: "novel",
      },
    },
    client: {
      async getBookChapters() {
        requestedToc = true;
        return [];
      },
    } as unknown as KavitaClient,
    kavitaSeriesId: 7,
    kavitaVolumeId: 8,
    kavitaChapterId: 55,
    volumeNumber: 1,
    totalPages: 0,
  });

  assert.equal(requestedToc, false);
  assert.deepEqual(chapters, []);
});

test("maps a one-page Kavita EPUB to page zero instead of page one", async () => {
  const chapters = await getNovelChaptersFromBook({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Novel",
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
        contentType: "novel",
      },
    },
    client: {
      async getBookChapters() {
        return [
          {
            title: "A Simple Survey:Volume2",
            page: 0,
            children: [{ title: "Greeting", page: 0 }],
          },
        ];
      },
    } as unknown as KavitaClient,
    kavitaSeriesId: 7,
    kavitaVolumeId: 8,
    kavitaChapterId: 55,
    volumeNumber: 1,
    totalPages: 1,
  });

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.additionalInfo?.startPage, "0");
  assert.equal(chapters[0]?.additionalInfo?.endPage, "0");
});

test("static probe returns non-empty HTML details without pages", async () => {
  const details = await getNovelChapterDetails({
    sourceManga: novelSourceManga(),
    chapter: novelChapter({ startPage: 0, endPage: 0 }),
    client: {
      async getBookInfo() {
        throw new Error("static probe must not fetch Kavita book info");
      },
      async getBookPage() {
        throw new Error("static probe must not fetch Kavita pages");
      },
    } as unknown as KavitaClient,
    renderingMode: "static-probe",
    maxResourceBytes: 1_000,
    maxChapterBytes: 1_000,
    debugLogging: false,
    build: "0.1.2+test",
    incomingContentType: "comic",
    resolvedContentType: "novel",
    kavitaFormat: "epub",
  });

  assert.equal(details.type, "html");
  assert.equal(details.html, STATIC_PROBE_HTML);
  assert.ok(visibleText(details.html).length >= 2_000);
  assert.equal(details.html.includes("<!doctype"), false);
  assert.equal("pages" in details, false);
});

test("plain text mode wraps visible escaped text in minimal XHTML", async () => {
  const requestedPages: number[] = [];
  const details = await getNovelChapterDetails({
    sourceManga: novelSourceManga(),
    chapter: novelChapter({ startPage: 0, endPage: 2 }),
    client: {
      async getBookInfo() {
        return { pages: 3 };
      },
      async getBookPage(_chapterId: number, page: number) {
        requestedPages.push(page);
        return "<html><head><style>.hidden{display:none}</style></head><body><p>Hello <strong>&amp;</strong> &lt;world&gt;</p><script>ignored()</script></body></html>";
      },
    } as unknown as KavitaClient,
    renderingMode: "plain-text",
    maxResourceBytes: 1_000,
    maxChapterBytes: 1_000,
    debugLogging: false,
    build: "0.1.2+test",
    incomingContentType: undefined,
    resolvedContentType: "novel",
    kavitaFormat: "epub",
  });

  assert.deepEqual(requestedPages, [0]);
  assert.equal(details.type, "html");
  assert.match(
    details.html,
    /^<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"><head><\/head><body><p>/u,
  );
  assert.ok(details.html.includes("Hello &amp; &lt;world&gt;"));
  assert.equal(details.html.includes("<strong>"), false);
  assert.equal(details.html.includes("<script>"), false);
  assert.equal("pages" in details, false);
});

test("one-page EPUB details only request page zero", async () => {
  const requestedPages: number[] = [];

  await getNovelChapterDetails({
    sourceManga: novelSourceManga(),
    chapter: novelChapter({ startPage: 0, endPage: 9 }),
    client: {
      async getBookInfo() {
        return { pages: 1 };
      },
      async getBookPage(_chapterId: number, page: number) {
        requestedPages.push(page);
        return "<p>Only page</p>";
      },
      async getBookResource() {
        throw new Error("no resources should be requested for this fixture");
      },
    } as unknown as KavitaClient,
    renderingMode: "full-epub",
    maxResourceBytes: 1_000,
    maxChapterBytes: 1_000,
    debugLogging: false,
    build: "0.1.2+test",
    incomingContentType: "novel",
    resolvedContentType: "novel",
    kavitaFormat: "epub",
  });

  assert.deepEqual(requestedPages, [0]);
});

test("ten-page EPUB details never request page ten", async () => {
  const requestedPages: number[] = [];

  await getNovelChapterDetails({
    sourceManga: novelSourceManga(),
    chapter: novelChapter({ startPage: 8, endPage: 12 }),
    client: {
      async getBookInfo() {
        return { pages: 10 };
      },
      async getBookPage(_chapterId: number, page: number) {
        requestedPages.push(page);
        return `<p>Page ${page}</p>`;
      },
      async getBookResource() {
        throw new Error("no resources should be requested for this fixture");
      },
    } as unknown as KavitaClient,
    renderingMode: "full-epub",
    maxResourceBytes: 1_000,
    maxChapterBytes: 1_000,
    debugLogging: false,
    build: "0.1.2+test",
    incomingContentType: "comic",
    resolvedContentType: "novel",
    kavitaFormat: "epub",
  });

  assert.deepEqual(requestedPages, [8, 9]);
});

test("full EPUB details inline authenticated Kavita resources without leaking API keys", async () => {
  const requestedResources: string[] = [];
  const details = await getNovelChapterDetails({
    sourceManga: novelSourceManga(),
    chapter: novelChapter({ startPage: 0, endPage: 0 }),
    client: {
      async getBookInfo() {
        return { pages: 1 };
      },
      async getBookPage() {
        return '<p>Illustrated text</p><img alt="Cover" src="https://read.negev.red/api/Book/55/book-resources?file=images%2Fcover.png&apiKey=secret-key">';
      },
      async getBookResource(_chapterId: number, path: string) {
        requestedResources.push(path);
        return {
          bytes: new Uint8Array([1, 2, 3]).buffer,
          mimeType: "image/png",
        };
      },
    } as unknown as KavitaClient,
    renderingMode: "full-epub",
    maxResourceBytes: 1_000,
    maxChapterBytes: 20_000,
    debugLogging: false,
    build: "0.1.3+test",
    incomingContentType: "novel",
    resolvedContentType: "novel",
    kavitaFormat: "epub",
  });

  assert.equal(details.type, "html");
  assert.equal("pages" in details, false);
  assert.deepEqual(requestedResources, ["images/cover.png"]);
  assert.equal(details.html.includes("secret-key"), false);
  assert.equal(details.html.includes("read.negev.red"), false);
  assert.equal(details.html.includes("/api/Book/55/book-resources"), false);
  assert.match(details.html, /src="data:image\/png;base64,AQID"/u);
});

function novelSourceManga(): SourceManga {
  return {
    mangaId: "kavita-series:7",
    mangaInfo: {
      thumbnailUrl: "",
      synopsis: "",
      primaryTitle: "Novel",
      secondaryTitles: [],
      contentRating: ContentRating.EVERYONE,
      contentType: "novel",
    },
  };
}

function novelChapter(input: { startPage: number; endPage: number }): Chapter {
  return {
    chapterId: `kavita-book:55:page:${input.startPage}:end:${input.endPage}:last:0`,
    sourceManga: novelSourceManga(),
    langCode: "en",
    chapNum: 1,
    title: "Chapter 1",
    additionalInfo: {
      kavitaSeriesId: "7",
      kavitaChapterId: "55",
      startPage: String(input.startPage),
      endPage: String(input.endPage),
    },
  };
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
