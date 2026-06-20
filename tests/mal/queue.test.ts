import assert from "node:assert/strict";
import test from "node:test";

import { processMalQueue } from "../../src/MyAnimeList/queue.js";
import { defaultPolicyForContentType } from "../../src/MyAnimeList/policy.js";

test("groups queue items, collapses lower progress, and reports success IDs", async () => {
  const updates: unknown[] = [];
  const result = await processMalQueue({
    actions: [
      {
        id: "a1",
        malMangaId: "100",
        chapterNumber: 1,
        volumeNumber: 1,
        isLastInVolume: false,
        isSpecial: false,
      },
      {
        id: "a2",
        malMangaId: "100",
        chapterNumber: 2,
        volumeNumber: 1,
        isLastInVolume: true,
        isSpecial: false,
      },
    ],
    getPolicy: () => defaultPolicyForContentType("manga"),
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "reading",
      totalChapters: 0,
      totalVolumes: 0,
    }),
    updateProgress: async (_malMangaId, update) => {
      updates.push(update);
      return { ok: true };
    },
  });

  assert.deepEqual(result, { successfulItems: ["a1", "a2"], failedItems: [] });
  assert.deepEqual(updates, [{ num_chapters_read: 2, num_volumes_read: 1 }]);
});

test("leaves transient failures failed for Paperback retry", async () => {
  const result = await processMalQueue({
    actions: [
      {
        id: "a1",
        malMangaId: "100",
        chapterNumber: 2,
        volumeNumber: 1,
        isLastInVolume: true,
        isSpecial: false,
      },
    ],
    getPolicy: () => defaultPolicyForContentType("manga"),
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "reading",
      totalChapters: 0,
      totalVolumes: 0,
    }),
    updateProgress: async () => ({ ok: false, retryable: true }),
  });

  assert.deepEqual(result, { successfulItems: [], failedItems: ["a1"] });
});
