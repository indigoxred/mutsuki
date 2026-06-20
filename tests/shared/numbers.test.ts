import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySpecialTitle,
  parsePositiveInteger,
  parseReadingNumber,
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
  assert.equal(parseReadingNumber("Afterword"), undefined);
});

test("classifies common novel specials conservatively", () => {
  assert.equal(classifySpecialTitle("Prologue"), true);
  assert.equal(classifySpecialTitle("Afterword"), true);
  assert.equal(classifySpecialTitle("Side Story: Rain"), true);
  assert.equal(classifySpecialTitle("Chapter 7"), false);
});
