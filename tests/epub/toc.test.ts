import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEpubChapterId,
  flattenKavitaToc,
  logicalChaptersFromToc,
} from "../../src/Kavita/toc.js";

test("flattens nested TOC entries and calculates logical page ranges", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 2,
    totalPages: 9,
    toc: [
      { title: "Prologue", page: 1 },
      {
        title: "Chapter 1",
        page: 2,
        children: [
          { title: "Scene A", page: 2 },
          { title: "Chapter 2", page: 5 },
        ],
      },
      { title: "Afterword", page: 8 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      startPage: chapter.startPage,
      endPage: chapter.endPage,
      isSpecial: chapter.isSpecial,
      role: chapter.role,
      isLastInVolume: chapter.isLastInVolume,
    })),
    [
      {
        title: "Prologue",
        startPage: 1,
        endPage: 1,
        isSpecial: true,
        role: "readable-special",
        isLastInVolume: false,
      },
      {
        title: undefined,
        startPage: 2,
        endPage: 4,
        isSpecial: false,
        role: "narrative",
        isLastInVolume: false,
      },
      {
        title: undefined,
        startPage: 5,
        endPage: 7,
        isSpecial: false,
        role: "narrative",
        isLastInVolume: false,
      },
      {
        title: "Afterword",
        startPage: 8,
        endPage: 8,
        isSpecial: true,
        role: "readable-special",
        isLastInVolume: true,
      },
    ],
  );
});

test("uses Kavita zero-based EPUB page numbers", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 2,
    totalPages: 3,
    toc: [
      { title: "Cover", page: 0 },
      { title: "Chapter 1", page: 1 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      startPage: chapter.startPage,
      endPage: chapter.endPage,
    })),
    [{ title: undefined, startPage: 1, endPage: 2 }],
  );
});

test("filters structural BAKEMONOGATARI Part 1 TOC entries without shifting chapter numbers", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 14324,
    kavitaVolumeId: 48557,
    kavitaChapterId: 65572,
    volumeNumber: 1,
    totalPages: 31,
    toc: [
      { title: "Navigation", page: 0 },
      { title: "Cover", page: 0 },
      { title: "Contents", page: 5 },
      { title: "CHAPTER ONE HITAGI CRAB", page: 6 },
      { title: "CHAPTER TWO MAYOI SNAIL", page: 17 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      chapNum: chapter.chapterNumber,
      title: chapter.title,
      startPage: chapter.startPage,
      endPage: chapter.endPage,
      isSpecial: chapter.isSpecial,
    })),
    [
      {
        chapNum: 1,
        title: "HITAGI CRAB",
        startPage: 6,
        endPage: 16,
        isSpecial: false,
      },
      {
        chapNum: 2,
        title: "MAYOI SNAIL",
        startPage: 17,
        endPage: 30,
        isSpecial: false,
      },
    ],
  );
});

test("parses BAKEMONOGATARI Part 3 word chapter numbers without using fallback order", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 14324,
    kavitaVolumeId: 48559,
    kavitaChapterId: 65574,
    volumeNumber: 3,
    totalPages: 19,
    toc: [
      { title: "Navigation", page: 0 },
      { title: "Contents", page: 5 },
      { title: "CHAPTER FIVE TSUBASA CAT", page: 6 },
    ],
  });

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.chapterNumber, 5);
  assert.equal(chapters[0]?.title, "TSUBASA CAT");
  assert.equal(chapters[0]?.startPage, 6);
  assert.equal(chapters[0]?.endPage, 18);
  assert.equal(chapters[0]?.volumeNumber, 3);
});

test("keeps a single Kavita zero page when every TOC entry points at page zero", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 2,
    totalPages: 1,
    toc: [
      {
        title: "A Simple Survey:Volume2",
        page: 0,
        children: [
          { title: "Greeting", page: 0 },
          { title: "Attraction 01", page: 0 },
        ],
      },
    ],
  });

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.startPage, 0);
  assert.equal(chapters[0]?.endPage, 0);
});

test("does not expose Kavita sentinel TOC numbers as novel chapter numbers", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 2,
    totalPages: 2,
    toc: [
      { title: "-100000", page: 0 },
      { title: "Chapter 10000", page: 1 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
    })),
    [
      { title: undefined, chapterNumber: 1 },
      { title: undefined, chapterNumber: 2 },
    ],
  );
});

test("falls back to one physical-volume chapter when no usable TOC exists", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 1,
    kavitaChapterId: 99,
    volumeNumber: 4,
    totalPages: 12,
    toc: [{ title: "Broken", page: 200 }],
  });

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.startPage, 0);
  assert.equal(chapters[0]?.endPage, 11);
  assert.equal(chapters[0]?.isLastInVolume, true);
});

test("stable EPUB IDs depend on physical chapter and page range, not title", () => {
  assert.equal(
    buildEpubChapterId({ physicalChapterId: 30, startPage: 2, endPage: 4, isLastInVolume: false }),
    "kavita-book:30:toc:v1:page:2:end:4:last:0",
  );
});

test("flattenKavitaToc preserves same-page starts for later classification", () => {
  const flat = flattenKavitaToc(
    [
      { title: "Chapter 1", page: 1 },
      { title: "Scene A", page: 1 },
      { title: "Chapter 2", page: 4 },
    ],
    10,
  );

  assert.deepEqual(
    flat.map((item) => item.title),
    ["Chapter 1", "Scene A", "Chapter 2"],
  );
});

test("keeps insert front matter readable without incrementing narrative numbering", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 5,
    totalPages: 12,
    toc: [
      { title: "Insert", page: 0 },
      { title: "Chapter 1: The Day After the Confession", page: 4 },
      { title: "Afterword", page: 10 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
      isSpecial: chapter.isSpecial,
      role: chapter.role,
      startPage: chapter.startPage,
      endPage: chapter.endPage,
    })),
    [
      {
        title: "Insert",
        chapterNumber: 0,
        isSpecial: true,
        role: "frontmatter",
        startPage: 0,
        endPage: 3,
      },
      {
        title: "The Day After the Confession",
        chapterNumber: 1,
        isSpecial: false,
        role: "narrative",
        startPage: 4,
        endPage: 9,
      },
      {
        title: "Afterword",
        chapterNumber: 0,
        isSpecial: true,
        role: "readable-special",
        startPage: 10,
        endPage: 11,
      },
    ],
  );
});

test("filters publisher backmatter by default without counting it as narrative", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 5,
    totalPages: 12,
    toc: [
      { title: "Chapter 1", page: 0 },
      { title: "About J-Novel Club", page: 4 },
      { title: "Yen Newsletter", page: 8 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
      role: chapter.role,
      publisherFiltered: chapter.publisherTocEntriesFiltered,
    })),
    [{ title: undefined, chapterNumber: 1, role: "narrative", publisherFiltered: 2 }],
  );
});

test("can expose publisher extras as special entries when explicitly enabled", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 5,
    totalPages: 12,
    includePublisherExtras: true,
    toc: [
      { title: "Chapter 1", page: 0 },
      { title: "About J-Novel Club", page: 4 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
      role: chapter.role,
      isSpecial: chapter.isSpecial,
    })),
    [
      { title: undefined, chapterNumber: 1, role: "narrative", isSpecial: false },
      {
        title: "About J-Novel Club",
        chapterNumber: 0,
        role: "publisher-backmatter",
        isSpecial: true,
      },
    ],
  );
});

test("same-page structural entries do not hide readable entries", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 1,
    totalPages: 5,
    toc: [
      { title: "Contents", page: 0 },
      { title: "Chapter 1: Awake", page: 0 },
      { title: "Cover", page: 2 },
      { title: "Insert", page: 2 },
      { title: "Chapter 2", page: 3, part: "chapter-2-a" },
      { title: "Chapter 3", page: 3, part: "chapter-3-b" },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
      role: chapter.role,
      startPage: chapter.startPage,
      endPage: chapter.endPage,
      part: chapter.part,
    })),
    [
      {
        title: "Awake",
        chapterNumber: 1,
        role: "narrative",
        startPage: 0,
        endPage: 1,
        part: undefined,
      },
      {
        title: "Insert",
        chapterNumber: 0,
        role: "frontmatter",
        startPage: 2,
        endPage: 2,
        part: undefined,
      },
      {
        title: undefined,
        chapterNumber: 2,
        role: "narrative",
        startPage: 3,
        endPage: 4,
        part: "chapter-2-a",
      },
      {
        title: undefined,
        chapterNumber: 3,
        role: "narrative",
        startPage: 3,
        endPage: 4,
        part: "chapter-3-b",
      },
    ],
  );
});

test("normalizes roman and word chapter display titles", () => {
  const chapters = logicalChaptersFromToc({
    kavitaSeriesId: 10,
    kavitaVolumeId: 20,
    kavitaChapterId: 30,
    volumeNumber: 12,
    totalPages: 20,
    toc: [
      { title: "Chapter VIII: Unexpected Aid", page: 1 },
      { title: "CHAPTER FIVE TSUBASA CAT", page: 5 },
      { title: "Final Chapter: The End of a Journey", page: 10 },
      { title: "Dramatis Personae", page: 15 },
    ],
  });

  assert.deepEqual(
    chapters.map((chapter) => ({
      title: chapter.title,
      chapterNumber: chapter.chapterNumber,
      role: chapter.role,
      isSpecial: chapter.isSpecial,
    })),
    [
      { title: "Unexpected Aid", chapterNumber: 8, role: "narrative", isSpecial: false },
      { title: "TSUBASA CAT", chapterNumber: 5, role: "narrative", isSpecial: false },
      {
        title: "Final Chapter: The End of a Journey",
        chapterNumber: 9,
        role: "narrative",
        isSpecial: false,
      },
      { title: "Dramatis Personae", chapterNumber: 0, role: "frontmatter", isSpecial: true },
    ],
  );
});
