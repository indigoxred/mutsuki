import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySpecialTitle,
  parseChapterNumber,
  parsePositiveInteger,
  parseReadingNumber,
  parseVolumeNumber,
} from "../../src/shared/numbers.js";

test("parses only finite positive integer progress values", () => {
  assert.equal(parsePositiveInteger("12"), 12);
  assert.equal(parsePositiveInteger("12.5"), undefined);
  assert.equal(parsePositiveInteger("0"), undefined);
  assert.equal(parsePositiveInteger("-1"), undefined);
  assert.equal(parsePositiveInteger("NaN"), undefined);
});

test("parses chapter numbers while preserving decimal awareness", () => {
  assert.deepEqual(parseReadingNumber("Chapter 12.5: Side"), {
    value: 12.5,
    isDecimal: true,
  });
  assert.deepEqual(parseReadingNumber("Volume 3"), { value: 3, isDecimal: false });
  assert.deepEqual(parseReadingNumber("Part 3"), { value: 3, isDecimal: false });
  assert.deepEqual(parseReadingNumber("CHAPTER ONE HITAGI CRAB"), {
    value: 1,
    isDecimal: false,
  });
  assert.deepEqual(parseReadingNumber("CHAPTER FIVE TSUBASA CAT"), {
    value: 5,
    isDecimal: false,
  });
  assert.deepEqual(parseReadingNumber("Chapter Twenty-One"), {
    value: 21,
    isDecimal: false,
  });
  assert.deepEqual(parseReadingNumber("Chapter V"), { value: 5, isDecimal: false });
  assert.equal(parseReadingNumber("Afterword"), undefined);
  assert.equal(parseReadingNumber("One fine day"), undefined);
});

test("separates chapter parsing from volume parsing", () => {
  assert.deepEqual(parseChapterNumber("Chapter 5"), { value: 5, isDecimal: false });
  assert.deepEqual(parseChapterNumber("CHAPTER FIVE TSUBASA CAT"), {
    value: 5,
    isDecimal: false,
  });
  assert.deepEqual(parseChapterNumber("Chapter V"), { value: 5, isDecimal: false });
  assert.equal(parseChapterNumber("Baka to Tesuto to Syokanju:Volume10.5"), undefined);
  assert.equal(parseChapterNumber("Volume 12"), undefined);

  assert.deepEqual(parseVolumeNumber("Baka to Tesuto to Syokanju:Volume10.5"), {
    value: 10.5,
    isDecimal: true,
  });
  assert.deepEqual(parseVolumeNumber("Vol. 3.5"), { value: 3.5, isDecimal: true });
  assert.deepEqual(parseVolumeNumber("Vol. 8.5"), { value: 8.5, isDecimal: true });
  assert.deepEqual(parseVolumeNumber("v5.5"), { value: 5.5, isDecimal: true });
  assert.deepEqual(parseVolumeNumber("Book 6"), { value: 6, isDecimal: false });
  assert.deepEqual(parseVolumeNumber("BAKEMONOGATARI Part 3"), {
    value: 3,
    isDecimal: false,
  });
  assert.equal(parseVolumeNumber("(2005) In the Miso Soup"), undefined);
  assert.equal(parseVolumeNumber("-100000"), undefined);
  assert.equal(parseVolumeNumber("10000"), undefined);
  assert.equal(parseVolumeNumber("100000"), undefined);
  assert.equal(parseVolumeNumber("Volume 10000"), undefined);
});

test("classifies common novel specials conservatively", () => {
  assert.equal(classifySpecialTitle("Prologue"), true);
  assert.equal(classifySpecialTitle("Afterword"), true);
  assert.equal(classifySpecialTitle("Side Story: Rain"), true);
  assert.equal(classifySpecialTitle("Chapter 7"), false);
});
