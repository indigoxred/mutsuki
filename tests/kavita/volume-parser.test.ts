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
      pages: 8,
      isSpecial: false,
    },
    {
      id: 56,
      title: "Special",
      chapterNumber: undefined,
      volumeNumber: "2",
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
      pages: 2,
      isSpecial: false,
    },
  ]);
});
