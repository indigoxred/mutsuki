import assert from "node:assert/strict";
import test from "node:test";

import { parseKavitaChapterDtos } from "../../src/Kavita/volume-parser.js";

test("flattens common Kavita volume/chapter payloads into chapter DTOs", () => {
  const chapters = parseKavitaChapterDtos([
    {
      id: 10,
      number: "2",
      chapters: [
        { id: 55, title: "Chapter 12", chapterNumber: "12", pages: 8 },
        { id: 56, title: "Special", isSpecial: true, pages: 3 },
      ],
    },
  ]);

  assert.deepEqual(chapters, [
    {
      id: 55,
      title: "Chapter 12",
      chapterNumber: "12",
      volumeNumber: "2",
      sourceVolumeIndex: 0,
      sourceChapterIndex: 0,
      pages: 8,
      isSpecial: false,
    },
    {
      id: 56,
      title: "Special",
      chapterNumber: undefined,
      volumeNumber: "2",
      sourceVolumeIndex: 0,
      sourceChapterIndex: 1,
      pages: 3,
      isSpecial: true,
    },
  ]);
});

test("accepts direct chapter arrays and ignores malformed entries", () => {
  const chapters = parseKavitaChapterDtos([{ id: 1, pages: 2 }, { id: "bad" }, null]);

  assert.deepEqual(chapters, [
    {
      id: 1,
      title: undefined,
      chapterNumber: undefined,
      volumeNumber: undefined,
      sourceVolumeIndex: 0,
      sourceChapterIndex: 0,
      pages: 2,
      isSpecial: false,
    },
  ]);
});

test("uses current Kavita chapter numbering fields and suppresses special sentinels", () => {
  const chapters = parseKavitaChapterDtos([
    {
      number: "1",
      chapters: [
        {
          id: 70,
          titleName: "Bonus Story",
          number: "10000",
          range: "10000",
          minNumber: 10000,
          maxNumber: 10000,
          pages: 4,
          isSpecial: true,
        },
        {
          id: 71,
          titleName: "Chapter Six",
          number: "10000",
          range: "6",
          minNumber: 6,
          maxNumber: 6,
          pages: 12,
          isSpecial: false,
        },
      ],
    },
  ]);

  assert.deepEqual(chapters, [
    {
      id: 70,
      title: "Bonus Story",
      chapterNumber: undefined,
      volumeNumber: "1",
      sourceVolumeIndex: 0,
      sourceChapterIndex: 0,
      pages: 4,
      isSpecial: true,
    },
    {
      id: 71,
      title: "Chapter Six",
      chapterNumber: "6",
      volumeNumber: "1",
      sourceVolumeIndex: 0,
      sourceChapterIndex: 1,
      pages: 12,
      isSpecial: false,
    },
  ]);
});
