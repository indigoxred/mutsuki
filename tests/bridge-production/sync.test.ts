import assert from "node:assert/strict";
import test from "node:test";

import {
  runBridgeSyncOnce,
  type BridgeKavitaClient,
  type BridgeMalClient,
} from "../../apps/kavita-mal-bridge/src/sync.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("sync polls Kavita, auto-links deterministic MAL metadata, and queues monotonic dry-run update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 9,
        kavitaLibraryId: 2,
        title: "A Story",
        contentType: "manga",
        webLinks: ["https://myanimelist.net/manga/555/A_Story"],
        completedChapter: 12,
        completedVolume: 3,
        isSpecial: false,
      },
    ],
  };
  const malUpdates: unknown[] = [];
  const mal: BridgeMalClient = {
    searchManga: async () => [],
    getCurrentProgress: async () => ({
      chaptersRead: 10,
      volumesRead: 2,
      status: "plan_to_read",
    }),
    updateProgress: async (_malId, update) => {
      malUpdates.push(update);
      return { ok: true };
    },
  };

  try {
    const result = await runBridgeSyncOnce({ store, kavita, mal, dryRun: true });

    assert.equal(result.seriesSeen, 1);
    assert.equal(result.autoMatched, 1);
    assert.equal(result.updatesQueued, 1);
    assert.equal(result.outboxPreviewed, 1);
    assert.equal(result.outboxSucceeded, 0);
    assert.equal(malUpdates.length, 0);
    assert.equal((await store.getSeriesMapping(9))?.malId, 555);
    assert.equal((await store.getSeriesMapping(9))?.title, "A Story");
    assert.equal((await store.listOutbox(10))[0]?.status, "pending");
    const audit = await store.listAuditLogs();
    assert.ok(
      audit.some(
        (entry) =>
          entry.type === "progress" &&
          entry.kavitaSeriesId === 9 &&
          entry.message.includes("Queued MAL progress update"),
      ),
    );
    assert.ok(
      audit.some(
        (entry) =>
          entry.type === "outbox" &&
          entry.kavitaSeriesId === 9 &&
          entry.message.includes("Dry-run MAL update previewed"),
      ),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync places ambiguous title matches into review without writing MAL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 10,
        title: "Blue Spring",
        contentType: "manga",
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  const mal: BridgeMalClient = {
    searchManga: async () => [
      { malId: 1, title: "Blue Spring", altTitles: [], mediaType: "manga" },
      { malId: 2, title: "Blue Spring Ride", altTitles: [], mediaType: "manga" },
    ],
    getCurrentProgress: async () => {
      throw new Error("should not fetch current MAL progress for unresolved mappings");
    },
    updateProgress: async () => {
      throw new Error("should not update unresolved mappings");
    },
  };

  try {
    const result = await runBridgeSyncOnce({ store, kavita, mal, dryRun: true });

    assert.equal(result.reviewQueued, 1);
    assert.equal((await store.listReviews()).length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync skips manually ignored unresolved series", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.ignoreSeries({
    kavitaSeriesId: 11,
    title: "Ignored Story",
    reason: "manual-ignore",
  });
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 11,
        title: "Ignored Story",
        contentType: "manga",
        completedChapter: 4,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  const mal: BridgeMalClient = {
    searchManga: async () => {
      throw new Error("ignored series should not be searched");
    },
    getCurrentProgress: async () => {
      throw new Error("ignored series should not fetch MAL progress");
    },
    updateProgress: async () => {
      throw new Error("ignored series should not update MAL");
    },
  };

  try {
    const result = await runBridgeSyncOnce({ store, kavita, mal, dryRun: true });

    assert.equal(result.seriesSeen, 1);
    assert.equal(result.reviewQueued, 0);
    assert.equal((await store.listReviews()).length, 0);
    assert.equal((await store.listOutbox()).length, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync auto-links deterministic external metadata before fuzzy title search", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 18,
        title: "External Metadata Story",
        contentType: "manga",
        externalIds: { anilist: 123456 },
        completedChapter: 4,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  const mal: BridgeMalClient = {
    searchManga: async () => {
      throw new Error("should not run fuzzy search after deterministic external match");
    },
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => ({ ok: true }),
  };

  try {
    const result = await runBridgeSyncOnce({
      store,
      kavita,
      mal,
      dryRun: true,
      externalIdResolver: {
        resolveMalId: async () => ({ malId: 654321, matchMethod: "external-id", confidence: 1 }),
      },
    });

    const mapping = await store.getSeriesMapping(18);
    assert.equal(result.autoMatched, 1);
    assert.equal(mapping?.malId, 654321);
    assert.equal(mapping?.matchMethod, "external-id");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync defers one series when MAL search has a retryable server failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 31,
        title: "Transient Search Failure",
        contentType: "manga",
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
      {
        kavitaSeriesId: 32,
        title: "Still Processes Later Series",
        contentType: "manga",
        webLinks: ["https://myanimelist.net/manga/777/Still_Processes_Later_Series"],
        completedChapter: 2,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  const mal: BridgeMalClient = {
    searchManga: async () => {
      const error = new Error("MAL request failed with status 504.");
      (error as Error & { status?: number }).status = 504;
      throw error;
    },
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => ({ ok: true }),
  };

  try {
    const result = await runBridgeSyncOnce({ store, kavita, mal, dryRun: true });

    assert.equal(result.seriesSeen, 2);
    assert.equal(result.searchDeferred, 1);
    assert.equal(result.reviewQueued, 0);
    assert.equal(result.autoMatched, 1);
    assert.equal((await store.listReviews()).length, 0);
    assert.equal(await store.getSeriesMapping(31), undefined);
    assert.equal((await store.getSeriesMapping(32))?.malId, 777);
    const audit = await store.listAuditLogs();
    assert.ok(
      audit.some(
        (entry) =>
          entry.type === "system" &&
          entry.kavitaSeriesId === 31 &&
          entry.message.includes("Deferred MAL search"),
      ),
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync does not re-search series already waiting in the review queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  await store.enqueueReview({
    kavitaSeriesId: 41,
    title: "Already Needs Review",
    reason: "ambiguous-or-low-confidence",
    candidatesJson: "[]",
  });
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 41,
        title: "Already Needs Review",
        contentType: "manga",
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
      {
        kavitaSeriesId: 42,
        title: "Deterministic Later Series",
        contentType: "manga",
        webLinks: ["https://myanimelist.net/manga/888/Deterministic_Later_Series"],
        completedChapter: 3,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  const mal: BridgeMalClient = {
    searchManga: async () => {
      throw new Error("review-queued series should not be searched again");
    },
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => ({ ok: true }),
  };

  try {
    const result = await runBridgeSyncOnce({ store, kavita, mal, dryRun: true });

    assert.equal(result.seriesSeen, 2);
    assert.equal(result.reviewSkipped, 1);
    assert.equal(result.autoMatched, 1);
    assert.equal((await store.listReviews()).length, 1);
    assert.equal((await store.getSeriesMapping(42))?.malId, 888);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync caps new MAL search requests per run without blocking deterministic links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-sync-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  const kavita: BridgeKavitaClient = {
    listSeries: async () => [
      {
        kavitaSeriesId: 51,
        title: "Needs One Search",
        contentType: "manga",
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
      {
        kavitaSeriesId: 52,
        title: "Deferred By Budget",
        contentType: "manga",
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
      {
        kavitaSeriesId: 53,
        title: "Deterministic Despite Budget",
        contentType: "manga",
        webLinks: ["https://myanimelist.net/manga/999/Deterministic_Despite_Budget"],
        completedChapter: 1,
        completedVolume: 1,
        isSpecial: false,
      },
    ],
  };
  let searches = 0;
  const mal: BridgeMalClient = {
    searchManga: async () => {
      searches += 1;
      return [];
    },
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => ({ ok: true }),
  };

  try {
    const result = await runBridgeSyncOnce({
      store,
      kavita,
      mal,
      dryRun: true,
      maxMalSearchesPerRun: 1,
    });

    assert.equal(searches, 1);
    assert.equal(result.reviewQueued, 1);
    assert.equal(result.searchBudgetSkipped, 1);
    assert.equal(result.autoMatched, 1);
    assert.equal((await store.listReviews()).length, 1);
    assert.equal(await store.getSeriesMapping(52), undefined);
    assert.equal((await store.getSeriesMapping(53))?.malId, 999);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
