import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSegmentChapterId,
  planNovelReadingUnits,
  shouldAutoSplitLargeEpub,
} from "../../src/Kavita/novel-segments.js";
import type { KavitaTocItem } from "../../src/Kavita/models.js";

test("oversized omnibus planning prefers top-level book boundaries and bounded subparts", () => {
  const totalPages = 1_169;
  const toc = omnibusToc();

  const plan = planNovelReadingUnits({
    physicalChapterId: 777,
    physicalVolumeId: 888,
    physicalVolumeNumber: 1,
    title: "Synthetic Omnibus",
    totalPages,
    toc,
    largeBookHandling: "auto-split",
    targetPagesPerPart: 96,
    hardMaxPagesPerPart: 128,
  });

  assert.equal(plan.autoSplitTriggered, true);
  assert.equal(plan.totalPages, totalPages);
  assert.equal(
    plan.units.some((unit) => unit.startPage === 0 && unit.endPage === 1_168),
    false,
  );
  assert.equal(plan.units.length > 7, true);
  assert.deepEqual(
    plan.units.map((unit) => unit.segmentIndex),
    Array.from({ length: plan.units.length }, (_unused, index) => index),
  );
  assert.equal(plan.units.filter((unit) => unit.isLastInPhysicalBook).length, 1);
  assert.equal(plan.units.at(-1)?.isLastInPhysicalBook, true);
  assert.equal(
    plan.units.every((unit) => unit.startPage <= unit.endPage),
    true,
  );
  assert.equal(
    plan.units.every((unit) => unit.endPage - unit.startPage + 1 <= 128),
    true,
  );

  const coveredPages = new Set<number>();
  for (const unit of plan.units) {
    for (let page = unit.startPage; page <= unit.endPage; page += 1) {
      assert.equal(coveredPages.has(page), false, `page ${page} appeared twice`);
      coveredPages.add(page);
    }
  }
  assert.equal(coveredPages.size, totalPages);

  const topLevelTitles = new Set(
    plan.units
      .map((unit) => unit.sourceTocPath[0])
      .filter((title): title is string => Boolean(title)),
  );
  assert.ok(topLevelTitles.has("Book 1: Never Giving Up"));
  assert.ok(topLevelTitles.has("Book 7: The Final Battle"));

  assert.equal(
    buildSegmentChapterId({
      physicalChapterId: 777,
      startPage: plan.units[1]?.startPage ?? -1,
      endPage: plan.units[1]?.endPage ?? -1,
      segmentIndex: 1,
      isLastInPhysicalBook: false,
    }),
    plan.units[1]?.id,
  );
});

test("normal EPUB planning keeps one physical-book entry", () => {
  const plan = planNovelReadingUnits({
    physicalChapterId: 55,
    physicalVolumeNumber: 4,
    title: "Normal Light Novel Vol. 4",
    totalPages: 40,
    toc: [{ title: "Chapter 1", page: 0 }],
    largeBookHandling: "auto-split",
    targetPagesPerPart: 96,
  });

  assert.equal(shouldAutoSplitLargeEpub(40, "auto-split"), false);
  assert.equal(plan.autoSplitTriggered, false);
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0]?.id, "kavita-book:55:whole:v1");
  assert.equal(plan.units[0]?.startPage, 0);
  assert.equal(plan.units[0]?.endPage, 39);
  assert.equal(plan.units[0]?.isLastInPhysicalBook, true);
});

function omnibusToc(): KavitaTocItem[] {
  const ranges = [
    { title: "Book 1: Never Giving Up", start: 4, length: 154 },
    {
      title: "Book 2: Studying for the Rise to Prominence of the Human Race",
      start: 158,
      length: 189,
    },
    { title: "Book 3: Clear River in Turmoil", start: 347, length: 166 },
    { title: "Book 4: Near Blood", start: 513, length: 230 },
    { title: "Book 5: Sect", start: 743, length: 186 },
    { title: "Book 6: A Year of Great Undertakings", start: 929, length: 126 },
    { title: "Book 7: The Final Battle", start: 1055, length: 114 },
  ];

  return [
    { title: "Overview", page: 0 },
    ...ranges.map(({ title, start, length }) => ({
      title,
      page: start,
      children: chapterBoundaries(start, length),
    })),
  ];
}

function chapterBoundaries(start: number, length: number): KavitaTocItem[] {
  const children: KavitaTocItem[] = [];
  let chapter = 1;
  for (let page = start; page < start + length; page += 48) {
    children.push({ title: `Chapter ${chapter}: Synthetic ${chapter}`, page });
    chapter += 1;
  }
  return children;
}
