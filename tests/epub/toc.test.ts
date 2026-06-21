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
      isLastInVolume: chapter.isLastInVolume,
    })),
    [
      { title: "Prologue", startPage: 1, endPage: 1, isSpecial: true, isLastInVolume: false },
      { title: "Chapter 1", startPage: 2, endPage: 4, isSpecial: false, isLastInVolume: false },
      { title: "Chapter 2", startPage: 5, endPage: 7, isSpecial: false, isLastInVolume: false },
      { title: "Afterword", startPage: 8, endPage: 8, isSpecial: true, isLastInVolume: true },
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
    [
      { title: "Cover", startPage: 0, endPage: 0 },
      { title: "Chapter 1", startPage: 1, endPage: 2 },
    ],
  );
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
      { title: "Chapter 1", chapterNumber: 1 },
      { title: "Chapter 2", chapterNumber: 2 },
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
    "kavita-book:30:page:2:end:4:last:0",
  );
});

test("flattenKavitaToc removes duplicate page starts while preserving first useful label", () => {
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
    ["Chapter 1", "Chapter 2"],
  );
});
