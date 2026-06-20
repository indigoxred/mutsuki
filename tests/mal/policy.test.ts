import assert from "node:assert/strict";
import test from "node:test";

import { defaultPolicyForContentType, planMalUpdate } from "../../src/MyAnimeList/policy.js";

test("defaults light novels to volume-only and manga to chapter-and-volume", () => {
  assert.equal(defaultPolicyForContentType("novel").mode, "volume-only");
  assert.equal(defaultPolicyForContentType("manga").mode, "chapter-and-volume");
});

test("does not advance volume progress until the final logical chapter in a volume", () => {
  const update = planMalUpdate({
    action: {
      malMangaId: "123",
      chapterNumber: 4,
      volumeNumber: 2,
      isLastInVolume: false,
      isSpecial: false,
    },
    current: {
      chaptersRead: 3,
      volumesRead: 1,
      status: "reading",
      totalChapters: 0,
      totalVolumes: 0,
    },
    policy: {
      mode: "chapter-and-volume",
      chapterOffset: 0,
      volumeOffset: 0,
      ignoreSpecials: true,
      decimalChapterPolicy: "ignore",
      markCompletedAutomatically: false,
      preserveExistingStatus: true,
    },
  });

  assert.deepEqual(update, { num_chapters_read: 4 });
});

test("advances volume progress on final logical chapter and never regresses", () => {
  const update = planMalUpdate({
    action: {
      malMangaId: "123",
      chapterNumber: 4,
      volumeNumber: 2,
      isLastInVolume: true,
      isSpecial: false,
    },
    current: {
      chaptersRead: 10,
      volumesRead: 1,
      status: "reading",
      totalChapters: 0,
      totalVolumes: 0,
    },
    policy: {
      mode: "chapter-and-volume",
      chapterOffset: 0,
      volumeOffset: 0,
      ignoreSpecials: true,
      decimalChapterPolicy: "ignore",
      markCompletedAutomatically: false,
      preserveExistingStatus: true,
    },
  });

  assert.deepEqual(update, { num_volumes_read: 2 });
});

test("ignores specials and decimal chapters by default", () => {
  const current = {
    chaptersRead: 0,
    volumesRead: 0,
    status: "reading" as const,
    totalChapters: 0,
    totalVolumes: 0,
  };
  const policy = defaultPolicyForContentType("manga");

  assert.equal(
    planMalUpdate({
      action: {
        malMangaId: "1",
        chapterNumber: 1,
        volumeNumber: 1,
        isLastInVolume: true,
        isSpecial: true,
      },
      current,
      policy,
    }),
    undefined,
  );
  assert.equal(
    planMalUpdate({
      action: {
        malMangaId: "1",
        chapterNumber: 1.5,
        volumeNumber: 1,
        isLastInVolume: true,
        isSpecial: false,
      },
      current,
      policy,
    }),
    undefined,
  );
});
