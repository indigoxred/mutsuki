import assert from "node:assert/strict";
import test from "node:test";

import {
  mangaChapterToPaperback,
  novelChapterToPaperback,
} from "../../src/Kavita/chapter-mapper.js";

test("maps image chapters to stable Kavita chapter IDs and authenticated page URLs", () => {
  const chapter = mangaChapterToPaperback({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Series",
        secondaryTitles: [],
        contentRating: "SAFE",
      },
    },
    kavitaChapter: {
      id: 55,
      title: "Chapter 12",
      chapterNumber: "12",
      volumeNumber: "2",
      pages: 3,
      isSpecial: false,
    },
    pageUrl: (page) => `https://kavita.test/page/${page}`,
    sortingIndex: 1,
  });

  assert.equal(chapter.chapter.chapterId, "kavita-chapter:55");
  assert.equal(chapter.chapter.chapNum, 12);
  assert.equal(chapter.chapter.volume, 2);
  assert.deepEqual(chapter.details.pages, [
    "https://kavita.test/page/0",
    "https://kavita.test/page/1",
    "https://kavita.test/page/2",
  ]);
});

test("does not expose Kavita special chapter sentinel numbers", () => {
  const chapter = mangaChapterToPaperback({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Series",
        secondaryTitles: [],
        contentRating: "SAFE",
      },
    },
    kavitaChapter: {
      id: 56,
      title: "Bonus Story",
      chapterNumber: "10000",
      volumeNumber: "100000",
      pages: 2,
      isSpecial: true,
    },
    pageUrl: (page) => `https://kavita.test/page/${page}`,
    sortingIndex: 4,
  });

  assert.equal(chapter.chapter.chapNum, 5);
  assert.equal(chapter.chapter.volume, undefined);
  assert.equal(chapter.chapter.title, "Bonus Story");
});

test("falls back to list order for implausibly large Kavita chapter numbers", () => {
  const chapter = mangaChapterToPaperback({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Series",
        secondaryTitles: [],
        contentRating: "SAFE",
      },
    },
    kavitaChapter: {
      id: 57,
      title: "Chapter",
      chapterNumber: "10000",
      pages: 2,
      isSpecial: false,
    },
    pageUrl: (page) => `https://kavita.test/page/${page}`,
    sortingIndex: 6,
  });

  assert.equal(chapter.chapter.chapNum, 7);
});

test("maps EPUB logical chapters to Paperback HTML chapters with final-volume marker", () => {
  const chapter = novelChapterToPaperback({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Novel",
        secondaryTitles: [],
        contentRating: "SAFE",
        contentType: "novel",
      },
    },
    logicalChapter: {
      kavitaSeriesId: 7,
      kavitaVolumeId: 8,
      kavitaChapterId: 55,
      title: "Chapter 2",
      tocPath: ["Chapter 2"],
      startPage: 5,
      endPage: 7,
      chapterNumber: 2,
      volumeNumber: 1,
      isSpecial: false,
      role: "narrative",
      isLastInVolume: true,
    },
    html: "<html></html>",
    sortingIndex: 2,
  });

  assert.equal(chapter.chapter.chapterId, "kavita-book:55:toc:v1:page:5:end:7:last:1");
  assert.equal(chapter.chapter.additionalInfo?.isLastInVolume, "true");
  assert.equal(chapter.details.type, "html");
});
