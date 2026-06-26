import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTrackingPolicyForSeries,
  planBridgeMalUpdate,
  type BridgeObservedProgress,
  type BridgeTrackingPolicy,
  type MalListProgress,
} from "../../apps/kavita-mal-bridge/src/policy.js";

test("manga defaults to chapter and volume tracking", () => {
  assert.equal(defaultTrackingPolicyForSeries("manga").trackingMode, "chapter-and-volume");
});

test("light novels default to volume-only tracking", () => {
  assert.equal(defaultTrackingPolicyForSeries("novel").trackingMode, "volume-only");
});

test("planned MAL updates are monotonic high-water marks with offsets", () => {
  const observed: BridgeObservedProgress = {
    kavitaCompletedChapter: 12,
    kavitaCompletedVolume: 3,
    isSpecial: false,
  };
  const current: MalListProgress = {
    chaptersRead: 10,
    volumesRead: 2,
    status: "plan_to_read",
  };
  const policy: BridgeTrackingPolicy = {
    trackingMode: "chapter-and-volume",
    chapterOffset: 1,
    volumeOffset: 0,
    ignoreSpecials: true,
    decimalChapterPolicy: "ignore",
  };

  const update = planBridgeMalUpdate({ observed, current, policy });

  assert.deepEqual(update, {
    num_chapters_read: 13,
    num_volumes_read: 3,
    status: "reading",
  });
});

test("planned MAL updates never reduce progress", () => {
  const update = planBridgeMalUpdate({
    observed: { kavitaCompletedChapter: 5, kavitaCompletedVolume: 1, isSpecial: false },
    current: { chaptersRead: 8, volumesRead: 2, status: "reading" },
    policy: {
      trackingMode: "chapter-and-volume",
      chapterOffset: 0,
      volumeOffset: 0,
      ignoreSpecials: true,
      decimalChapterPolicy: "ignore",
    },
  });

  assert.equal(update, undefined);
});

test("specials are ignored by default", () => {
  const update = planBridgeMalUpdate({
    observed: { kavitaCompletedChapter: 6, kavitaCompletedVolume: 2, isSpecial: true },
    current: { chaptersRead: 0, volumesRead: 0, status: "plan_to_read" },
    policy: defaultTrackingPolicyForSeries("manga"),
  });

  assert.equal(update, undefined);
});
