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
  assert.equal(chapters[0]?.chapterId, "kavita-book:55:whole:v1");
  assert.equal(chapters[0]?.chapNum, 1);
  assert.equal(chapters[0]?.additionalInfo?.listingMode, "physical-books");
  assert.equal(chapters[0]?.additionalInfo?.isLastInVolume, "true");
  assert.equal(chapters[0]?.sourceManga.mangaInfo.contentType, "novel");
});

test("chapter-number-first sorting interleaves local EPUB chapters across volumes", () => {
  const splitChapters = [1, 2, 3].flatMap((volume) =>
    [1, 2, 3, 4, 5].map((chapNum, index) => ({
      volume,
      chapNum,
      sortingIndex: (volume - 1) * 5 + index,
    })),
  );

  const chapterNumberFirst = [...splitChapters].sort(
    (a, b) => b.chapNum - a.chapNum || a.sortingIndex - b.sortingIndex,
  );

  assert.deepEqual(
    chapterNumberFirst.slice(0, 6).map((chapter) => ({
      volume: chapter.volume,
      chapNum: chapter.chapNum,
    })),
    [
      { volume: 1, chapNum: 5 },
      { volume: 2, chapNum: 5 },
      { volume: 3, chapNum: 5 },
      { volume: 1, chapNum: 4 },
      { volume: 2, chapNum: 4 },
      { volume: 3, chapNum: 4 },
    ],
  );
});

test("read progress can reorder tied physical-book chapters before volume tie-breakers", () => {
  const tiedPhysicalBooks = [1, 2, 3, 4, 5].map((volume) => ({
    volume,
    chapNum: 1,
    readProgressSortKey: volume === 4 ? 2 : volume === 3 ? 1 : 0,
  }));

  const progressBiasedSort = <
    T extends { chapNum: number; readProgressSortKey: number; volume: number },
  >(
    chapters: T[],
  ): T[] =>
    [...chapters].sort(
      (a, b) =>
        a.chapNum - b.chapNum ||
        b.readProgressSortKey - a.readProgressSortKey ||
        a.volume - b.volume,
    );

  assert.deepEqual(
    progressBiasedSort(tiedPhysicalBooks).map((chapter) => chapter.volume),
    [4, 3, 1, 2, 5],
  );

  const uniquePhysicalBooks = tiedPhysicalBooks.map((chapter, index) => ({
    ...chapter,
    chapNum: index + 1,
  }));
  assert.deepEqual(
    progressBiasedSort(uniquePhysicalBooks).map((chapter) => chapter.volume),
    [1, 2, 3, 4, 5],
  );
});

test("EPUB chapters derive sane volumes and global sorting across physical books", async () => {
  installApplicationStub({
    settings: { novelListingMode: "internal-chapters" },
    scheduleRequest: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/Series/7") {
        return jsonResponse({
          id: 7,
          name: "BAKEMONOGATARI",
          format: 3,
          libraryName: "Light Novels",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/Series/volumes") {
        return jsonResponse([
          {
            number: "-100000",
            chapters: [
              { id: 65572, title: "BAKEMONOGATARI Part 1", pages: 31 },
              { id: 65574, title: "BAKEMONOGATARI Part 3", pages: 19 },
            ],
          },
        ]);
      }
      if (request.method === "GET" && url.pathname === "/api/Book/65572/book-info") {
        return jsonResponse({
          volumeId: 48557,
          volumeNumber: "-100000",
          bookTitle: "BAKEMONOGATARI Part 1",
          seriesName: "BAKEMONOGATARI",
          pages: 31,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/Book/65572/chapters") {
        return jsonResponse([
          { title: "Navigation", page: 0 },
          { title: "Cover", page: 0 },
          { title: "Contents", page: 5 },
          { title: "CHAPTER ONE HITAGI CRAB", page: 6 },
          { title: "CHAPTER TWO MAYOI SNAIL", page: 17 },
        ]);
      }
      if (request.method === "GET" && url.pathname === "/api/Book/65574/book-info") {
        return jsonResponse({
          volumeId: 48559,
          volumeNumber: "-100000",
          bookTitle: "BAKEMONOGATARI Part 3",
          seriesName: "BAKEMONOGATARI",
          pages: 19,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/Book/65574/chapters") {
        return jsonResponse([
          { title: "Navigation", page: 0 },
          { title: "Contents", page: 5 },
          { title: "CHAPTER FIVE TSUBASA CAT", page: 6 },
        ]);
      }
      throw new Error(`Unexpected request ${request.method} ${url.pathname}`);
    },
  });

  const chapters = await new MutsukiKavitaExtension().getChapters(series({ contentType: "comic" }));

  assert.deepEqual(
    chapters.map((chapter) => ({
      chapNum: chapter.chapNum,
      title: chapter.title,
      volume: chapter.volume,
      sortingIndex: chapter.sortingIndex,
      startPage: chapter.additionalInfo?.startPage,
      endPage: chapter.additionalInfo?.endPage,
    })),
    [
      {
        chapNum: 1,
        title: "HITAGI CRAB",
        volume: 1,
        sortingIndex: 0,
        startPage: "6",
        endPage: "16",
      },
      {
        chapNum: 2,
        title: "MAYOI SNAIL",
        volume: 1,
        sortingIndex: 1,
        startPage: "17",
        endPage: "30",
      },
      {
        chapNum: 5,
        title: "TSUBASA CAT",
        volume: 3,
        sortingIndex: 2,
        startPage: "6",
        endPage: "18",
      },
    ],
  );
});

test("default Physical Books mode preserves decimal volumes and one Paperback entry per Kavita book", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    installApplicationStub({
      settings: { debugLogging: true },
      scheduleRequest: angelAndBakaScheduleRequest,
    });

    const chapters = await new MutsukiKavitaExtension().getChapters(
      series({ contentType: "comic" }),
    );

    assert.equal(chapters.length, 14);
    assert.deepEqual(
      chapters.map((chapter) => chapter.volume),
      [1, 2, 3, 4, 5, 5.5, 6, 7, 8, 8.5, 9, 10.5, 12, undefined],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapNum),
      Array.from({ length: chapters.length }, (_unused, index) => index + 1),
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      Array.from({ length: chapters.length }, (_unused, index) => index),
    );
    assert.equal(new Set(chapters.map((chapter) => chapter.chapterId)).size, chapters.length);
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapterId),
      [
        "kavita-book:800:whole:v1",
        "kavita-book:801:whole:v1",
        "kavita-book:802:whole:v1",
        "kavita-book:803:whole:v1",
        "kavita-book:804:whole:v1",
        "kavita-book:805:whole:v1",
        "kavita-book:806:whole:v1",
        "kavita-book:809:whole:v1",
        "kavita-book:807:whole:v1",
        "kavita-book:808:whole:v1",
        "kavita-book:810:whole:v1",
        "kavita-book:900:whole:v1",
        "kavita-book:901:whole:v1",
        "kavita-book:902:whole:v1",
      ],
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.additionalInfo?.listingMode),
      Array.from({ length: chapters.length }, () => "physical-books"),
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.additionalInfo?.isLastInVolume),
      Array.from({ length: chapters.length }, () => "true"),
    );

    const baka105 = chapters.find((chapter) => chapter.chapterId === "kavita-book:900:whole:v1");
    assert.equal(baka105?.volume, 10.5);
    assert.equal(baka105?.chapNum, 12);
    assert.equal(baka105?.title, "Baka to Tesuto to Syokanju:Volume10.5");

    const baka12 = chapters.find((chapter) => chapter.chapterId === "kavita-book:901:whole:v1");
    assert.equal(baka12?.volume, 12);
    assert.equal(baka12?.chapNum, 13);
    assert.equal(baka12?.title, "Baka to Tesuto to Syokanju:Volume12");

    const miso = chapters.find((chapter) => chapter.chapterId === "kavita-book:902:whole:v1");
    assert.equal(miso?.volume, undefined);
    assert.equal(miso?.chapNum, 14);
    assert.equal(miso?.title, "(2005) In the Miso Soup");

    const bookLines = logs.filter((line) => line.startsWith("[MutsukiNovelBook]"));
    assert.equal(bookLines.length, 14);
    assert.ok(bookLines.some((line) => /resolvedVolume=5\.5/u.test(line)));
    assert.ok(bookLines.some((line) => /resolvedVolume=8\.5/u.test(line)));
    assert.ok(bookLines.every((line) => /listingMode=physical-books/u.test(line)));
    assert.ok(bookLines.every((line) => !line.includes("secret-key")));
  } finally {
    console.log = originalLog;
  }
});

test("Internal EPUB Chapters mode filters publisher extras and keeps source-order projection", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    installApplicationStub({
      settings: { debugLogging: true, novelListingMode: "internal-chapters" },
      scheduleRequest: angelAndBakaScheduleRequest,
    });

    const chapters = await new MutsukiKavitaExtension().getChapters(
      series({ contentType: "comic" }),
    );

    assert.equal(
      chapters.some((chapter) => chapter.title === "Yen Newsletter"),
      false,
    );
    assert.deepEqual(
      chapters.map((chapter) => chapter.sortingIndex),
      Array.from({ length: chapters.length }, (_unused, index) => index),
    );

    const aroundFive = chapters.filter((chapter) => [5, 5.5, 6].includes(chapter.volume ?? -1));
    assert.deepEqual(
      aroundFive.map((chapter) => ({
        volume: chapter.volume,
        chapNum: chapter.chapNum,
        title: chapter.title,
        role: chapter.additionalInfo?.role,
        localChapterNumber: chapter.additionalInfo?.localChapterNumber,
        isSpecial: chapter.additionalInfo?.isSpecial,
      })),
      [
        {
          volume: 5,
          chapNum: 0,
          title: "Insert",
          role: "frontmatter",
          localChapterNumber: "0",
          isSpecial: "true",
        },
        {
          volume: 5,
          chapNum: 1,
          title: "The Day After the Confession",
          role: "narrative",
          localChapterNumber: "1",
          isSpecial: "false",
        },
        {
          volume: 5.5,
          chapNum: 0,
          title: "Insert",
          role: "frontmatter",
          localChapterNumber: "0",
          isSpecial: "true",
        },
        {
          volume: 6,
          chapNum: 0,
          title: "Insert",
          role: "frontmatter",
          localChapterNumber: "0",
          isSpecial: "true",
        },
        {
          volume: 6,
          chapNum: 1,
          title: "Volume 6",
          role: "narrative",
          localChapterNumber: "1",
          isSpecial: "false",
        },
      ],
    );

    const projectionLines = logs.filter((line) => line.startsWith("[MutsukiNovelProjection]"));
    assert.ok(projectionLines.length > 0);
    assert.ok(projectionLines.every((line) => !line.includes("secret-key")));
  } finally {
    console.log = originalLog;
  }
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

function angelAndBakaScheduleRequest(request: KavitaRequest): Promise<unknown> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/Series/7") {
    return Promise.resolve(
      jsonResponse({
        id: 7,
        name: "The Angel Next Door Spoils Me Rotten",
        format: 3,
        libraryName: "Light Novels",
      }),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/Series/volumes") {
    return Promise.resolve(
      jsonResponse([
        volumeContainer("8", [
          physicalChapter(808, "The Angel Next Door Spoils Me Rotten Volume 8.5", 1),
          physicalChapter(807, "The Angel Next Door Spoils Me Rotten Volume 8", 2),
        ]),
        volumeContainer("5", [
          physicalChapter(805, "The Angel Next Door Spoils Me Rotten Volume 5.5", 3),
          physicalChapter(804, "The Angel Next Door Spoils Me Rotten Volume 5", 4),
        ]),
        volumeContainer("1", [
          physicalChapter(800, "The Angel Next Door Spoils Me Rotten Volume 1", 5),
        ]),
        volumeContainer("2", [
          physicalChapter(801, "The Angel Next Door Spoils Me Rotten Volume 2", 6),
        ]),
        volumeContainer("3", [
          physicalChapter(802, "The Angel Next Door Spoils Me Rotten Volume 3", 7),
        ]),
        volumeContainer("4", [
          physicalChapter(803, "The Angel Next Door Spoils Me Rotten Volume 4", 8),
        ]),
        volumeContainer("6", [
          physicalChapter(806, "The Angel Next Door Spoils Me Rotten Volume 6", 9),
        ]),
        volumeContainer("7", [
          physicalChapter(809, "The Angel Next Door Spoils Me Rotten Volume 7", 10),
        ]),
        volumeContainer("9", [
          physicalChapter(810, "The Angel Next Door Spoils Me Rotten Volume 9", 11),
        ]),
        volumeContainer("10", [physicalChapter(900, "Baka to Tesuto to Syokanju:Volume10.5", 12)]),
        volumeContainer("12", [physicalChapter(901, "Baka to Tesuto to Syokanju:Volume12", 13)]),
        volumeContainer("-100000", [physicalChapter(902, "(2005) In the Miso Soup", 14)]),
      ]),
    );
  }

  const id = Number(url.pathname.match(/\/api\/Book\/(\d+)\/(?:book-info|chapters)$/u)?.[1]);
  if (!Number.isSafeInteger(id)) {
    return Promise.reject(new Error(`Unexpected request ${request.method} ${url.pathname}`));
  }

  if (request.method === "GET" && url.pathname.endsWith("/book-info")) {
    return Promise.resolve(jsonResponse(bookInfoFor(id)));
  }
  if (request.method === "GET" && url.pathname.endsWith("/chapters")) {
    return Promise.resolve(jsonResponse(tocFor(id)));
  }
  return Promise.reject(new Error(`Unexpected request ${request.method} ${url.pathname}`));
}

function volumeContainer(number: string, chapters: unknown[]): Record<string, unknown> {
  return { number, chapters };
}

function physicalChapter(id: number, title: string, pages: number): Record<string, unknown> {
  return { id, title, pages };
}

function bookInfoFor(id: number): Record<string, unknown> {
  const titles: Record<number, string> = {
    800: "The Angel Next Door Spoils Me Rotten Volume 1",
    801: "The Angel Next Door Spoils Me Rotten Volume 2",
    802: "The Angel Next Door Spoils Me Rotten Volume 3",
    803: "The Angel Next Door Spoils Me Rotten Volume 4",
    804: "The Angel Next Door Spoils Me Rotten Volume 5",
    805: "The Angel Next Door Spoils Me Rotten Volume 5.5",
    806: "The Angel Next Door Spoils Me Rotten Volume 6",
    807: "The Angel Next Door Spoils Me Rotten Volume 8",
    808: "The Angel Next Door Spoils Me Rotten Volume 8.5",
    809: "The Angel Next Door Spoils Me Rotten Volume 7",
    810: "The Angel Next Door Spoils Me Rotten Volume 9",
    900: "Baka to Tesuto to Syokanju:Volume10.5",
    901: "Baka to Tesuto to Syokanju:Volume12",
    902: "(2005) In the Miso Soup",
  };
  const rawVolumes: Record<number, string> = {
    805: "5",
    808: "8",
    900: "10",
    902: "-100000",
  };
  return {
    volumeId: id + 10_000,
    volumeNumber: rawVolumes[id] ?? parseTitleVolume(titles[id]),
    bookTitle: titles[id],
    seriesName: "The Angel Next Door Spoils Me Rotten",
    pages: id === 900 || id === 901 || id === 902 ? 1 : 12,
  };
}

function tocFor(id: number): unknown[] {
  if (id === 900 || id === 901 || id === 902) return [{ title: "Broken", page: 200 }];
  const specialOnly = id === 805 || id === 808;
  if (specialOnly) return [{ title: "Insert", page: 0 }];
  const titles: Record<number, string> = {
    804: "Chapter 1: The Day After the Confession",
    807: "Chapter 1: An Important Promise with the Angel",
  };
  return [
    { title: "Insert", page: 0 },
    {
      title: titles[id] ?? `Chapter 1: Volume ${parseTitleVolume(bookInfoFor(id).bookTitle)}`,
      page: 4,
    },
    { title: "Yen Newsletter", page: 10 },
  ];
}

function parseTitleVolume(title: unknown): string {
  const match = /Volume\s*(\d+(?:\.\d+)?)/u.exec(String(title));
  return match?.[1] ?? "-100000";
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
