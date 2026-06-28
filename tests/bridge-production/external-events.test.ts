import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  processExternalReadEvent,
  type ExternalReadEventMalClient,
  type ExternalTitleResolver,
} from "../../apps/kavita-mal-bridge/src/external-events.js";
import {
  DEFAULT_SOURCE_POLICY,
  SqliteBridgeStore,
} from "../../apps/kavita-mal-bridge/src/storage.js";
import type { BridgeReadEventRecord } from "../../apps/kavita-mal-bridge/src/progress-events.js";

test("external Paperback read event auto-links high-confidence MAL match and queues monotonic update", async () => {
  const fixture = await createFixture();
  const searches: string[] = [];
  const mal: ExternalReadEventMalClient = {
    searchManga: async (series) => {
      searches.push(series.title);
      return [
        {
          malId: 4242,
          title: "External Story",
          altTitles: ["External Story"],
          mediaType: "manga",
        },
      ];
    },
    getCurrentProgress: async () => ({
      chaptersRead: 2,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => {
      throw new Error("dry-run processing must not call MAL writes directly");
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      event: externalEvent({ sourceChapterNumber: 5 }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "MangaDex",
        readingSourceName: "MangaDex",
        malEnabled: true,
      },
    });

    assert.equal(result.status, "queued");
    assert.deepEqual(searches, ["External Story"]);
    const mappings = await fixture.store.listExternalSeriesMappings();
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.readingSourceId, "MangaDex");
    assert.equal(mappings[0]?.sourceMangaId, "mangadex-title-1");
    assert.equal(mappings[0]?.malId, 4242);
    assert.equal(mappings[0]?.matchMethod, "title-search");
    assert.equal(mappings[0]?.trackingMode, "chapter-and-volume");
    assert.equal(mappings[0]?.lastObservedChapter, 5);
    const outbox = await fixture.store.listOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.targetType, "external");
    assert.equal(outbox[0]?.targetKey, "external:MangaDex:mangadex-title-1");
    assert.deepEqual(outbox[0]?.update, {
      num_chapters_read: 5,
      status: "reading",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("external Chained Soldier event auto-links through resolver discovery when official MAL search misses it", async () => {
  const fixture = await createFixture();
  const searchedTitles: string[] = [];
  const hydratedIds: number[] = [];
  const resolverQueries: string[] = [];
  const mal: ExternalReadEventMalClient = {
    searchManga: async (series) => {
      searchedTitles.push(series.title);
      return [
        {
          malId: 27757,
          title: "Sugar*Soldier",
          altTitles: ["Hapi★Supi", "シュガー＊ソルジャー"],
          mediaType: "manga",
        },
      ];
    },
    getMangaById: async (malId) => {
      hydratedIds.push(malId);
      if (malId === 116880) {
        return {
          malId: 116880,
          title: "Mato Seihei no Slave",
          altTitles: ["Chained Soldier", "魔都精兵のスレイブ", "Mabotai"],
          mediaType: "manga",
        };
      }
      if (malId === 27757) {
        return {
          malId: 27757,
          title: "Sugar*Soldier",
          altTitles: ["Hapi★Supi", "シュガー＊ソルジャー"],
          mediaType: "manga",
        };
      }
      return undefined;
    },
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => {
      throw new Error("dry-run processing must not call MAL writes directly");
    },
  };
  const resolver: ExternalTitleResolver = {
    discoverCandidates: async (input) => {
      resolverQueries.push(...input.titleVariants);
      return [
        {
          malId: 116880,
          provenance: ["jikan-search"],
        },
      ];
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      resolver,
      event: externalEvent({
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
        sourceMangaId: "01J76XYCVRSNNY2C2QH721967B",
        sourceTitle: "Chained Soldier",
        sourcePrimaryTitle: "Chained Soldier",
        sourceChapterNumber: 5,
      }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
      },
    });

    assert.equal(result.status, "queued");
    assert.deepEqual(searchedTitles, ["Chained Soldier"]);
    assert.ok(resolverQueries.includes("Chained Soldier"));
    assert.ok(hydratedIds.includes(116880));
    const mappings = await fixture.store.listExternalSeriesMappings();
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]?.malId, 116880);
    assert.equal(mappings[0]?.matchMethod, "title-search");
    assert.equal((await fixture.store.listExternalReviews()).length, 0);
    const outbox = await fixture.store.listOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.malId, 116880);
  } finally {
    await fixture.cleanup();
  }
});

test("external weak token-only candidates remain unresolved without a prefilled approval id", async () => {
  const fixture = await createFixture();
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => [
      {
        malId: 27757,
        title: "Sugar*Soldier",
        altTitles: ["Hapi★Supi", "シュガー＊ソルジャー"],
        mediaType: "manga",
      },
    ],
    getMangaById: async (malId) =>
      malId === 27757
        ? {
            malId: 27757,
            title: "Sugar*Soldier",
            altTitles: ["Hapi★Supi", "シュガー＊ソルジャー"],
            mediaType: "manga",
          }
        : undefined,
    getCurrentProgress: async () => {
      throw new Error("unresolved events must not fetch MAL progress");
    },
    updateProgress: async () => {
      throw new Error("unresolved events must not write MAL");
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      resolver: {
        discoverCandidates: async () => [],
      },
      event: externalEvent({
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
        sourceTitle: "Chained Soldier",
        sourcePrimaryTitle: "Chained Soldier",
      }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
      },
    });

    assert.equal(result.status, "review");
    const reviews = await fixture.store.listExternalReviews();
    assert.equal(reviews.length, 1);
    const candidates = JSON.parse(reviews[0]?.candidatesJson ?? "[]") as {
      malId: number;
      confidence: number;
      reasons: string[];
      reviewPrefill: boolean;
      strength: string;
    }[];
    assert.equal(candidates[0]?.malId, 27757);
    assert.equal(candidates[0]?.reviewPrefill, false);
    assert.equal(candidates[0]?.strength, "weak");
    assert.ok(candidates[0]!.confidence < 0.7);
  } finally {
    await fixture.cleanup();
  }
});

test("external pending review is refreshed by richer schema v3 events and can auto-link", async () => {
  const fixture = await createFixture();
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => [
      {
        malId: 27757,
        title: "Sugar*Soldier",
        mediaType: "manga",
      },
    ],
    getMangaById: async (malId) =>
      malId === 116880
        ? {
            malId: 116880,
            title: "Mato Seihei no Slave",
            altTitles: ["Chained Soldier"],
            mediaType: "manga",
          }
        : undefined,
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => {
      throw new Error("dry-run processing must not call MAL writes directly");
    },
  };

  try {
    const initial = await processExternalReadEvent({
      store: fixture.store,
      mal,
      resolver: {
        discoverCandidates: async () => [],
      },
      event: externalEvent({
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
        sourceMangaId: "01J76XYCVRSNNY2C2QH721967B",
        sourceTitle: "Chained Soldier",
        sourcePrimaryTitle: "Chained Soldier",
      }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
      },
    });
    assert.equal(initial.status, "review");
    assert.equal((await fixture.store.listExternalReviews()).length, 1);

    const refreshed = await processExternalReadEvent({
      store: fixture.store,
      mal,
      resolver: {
        discoverCandidates: async () => [
          {
            malId: 116880,
            provenance: ["jikan-search"],
          },
        ],
      },
      event: externalEvent({
        schemaVersion: 3,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
        sourceMangaId: "01J76XYCVRSNNY2C2QH721967B",
        sourceTitle: "Chained Soldier",
        sourcePrimaryTitle: "Chained Soldier",
        sourceAltTitles: ["Mato Seihei no Slave"],
      }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
      },
    });

    assert.equal(refreshed.status, "queued");
    assert.equal((await fixture.store.listExternalReviews()).length, 0);
    assert.equal((await fixture.store.listExternalSeriesMappings())[0]?.malId, 116880);
  } finally {
    await fixture.cleanup();
  }
});

test("external alt-title candidate exact match auto-links", async () => {
  const fixture = await createFixture();
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => [
      {
        malId: 116880,
        title: "Mato Seihei no Slave",
        altTitles: ["Chained Soldier", "魔都精兵のスレイブ"],
        mediaType: "manga",
      },
    ],
    getMangaById: async () => undefined,
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "plan_to_read",
    }),
    updateProgress: async () => {
      throw new Error("dry-run processing must not call MAL writes directly");
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      event: externalEvent({
        sourceTitle: "Chained Soldier",
        sourcePrimaryTitle: "Chained Soldier",
      }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "MangaDex",
        readingSourceName: "MangaDex",
      },
    });

    assert.equal(result.status, "queued");
    assert.equal((await fixture.store.listExternalSeriesMappings())[0]?.malId, 116880);
  } finally {
    await fixture.cleanup();
  }
});

test("external Paperback read event queues review for low-confidence match and does not clutter Kavita review queue", async () => {
  const fixture = await createFixture();
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => [
      { malId: 1, title: "Different Story", mediaType: "manga" },
      { malId: 2, title: "Another Candidate", mediaType: "manga" },
    ],
    getCurrentProgress: async () => {
      throw new Error("unresolved events must not fetch MAL progress");
    },
    updateProgress: async () => {
      throw new Error("unresolved events must not write MAL");
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      event: externalEvent(),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "MangaDex",
        readingSourceName: "MangaDex",
      },
    });

    assert.equal(result.status, "review");
    assert.equal((await fixture.store.listReviews()).length, 0);
    const reviews = await fixture.store.listExternalReviews();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.readingSourceId, "MangaDex");
    assert.equal(reviews[0]?.sourceMangaId, "mangadex-title-1");
    assert.equal(reviews[0]?.title, "External Story");
    assert.equal((await fixture.store.listOutbox()).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("external Paperback read event respects disabled source policy", async () => {
  const fixture = await createFixture();
  let searched = false;
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => {
      searched = true;
      return [];
    },
    getCurrentProgress: async () => {
      throw new Error("disabled sources must not fetch MAL progress");
    },
    updateProgress: async () => {
      throw new Error("disabled sources must not write MAL");
    },
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      event: externalEvent(),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "MangaDex",
        readingSourceName: "MangaDex",
        malEnabled: false,
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "source-policy-disabled");
    assert.equal(searched, false);
    assert.equal((await fixture.store.listExternalSeriesMappings()).length, 0);
    assert.equal((await fixture.store.listExternalReviews()).length, 0);
    assert.equal((await fixture.store.listOutbox()).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("external Paperback read event ignores decimal chapters by default", async () => {
  const fixture = await createFixture();
  const mal: ExternalReadEventMalClient = {
    searchManga: async () => [{ malId: 4242, title: "External Story", mediaType: "manga" }],
    getCurrentProgress: async () => ({
      chaptersRead: 0,
      volumesRead: 0,
      status: "reading",
    }),
    updateProgress: async () => ({ ok: true }),
  };

  try {
    const result = await processExternalReadEvent({
      store: fixture.store,
      mal,
      event: externalEvent({ sourceChapterNumber: 10.5 }),
      policy: {
        ...DEFAULT_SOURCE_POLICY,
        readingSourceId: "MangaDex",
        readingSourceName: "MangaDex",
      },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-progress-update");
    assert.equal((await fixture.store.listExternalSeriesMappings()).length, 1);
    assert.equal((await fixture.store.listOutbox()).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(): Promise<{
  store: SqliteBridgeStore;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-external-events-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function externalEvent(overrides: Partial<BridgeReadEventRecord> = {}): BridgeReadEventRecord {
  return {
    schemaVersion: 2,
    eventSource: "paperback-progress-bridge",
    readingSourceId: "MangaDex",
    readingSourceName: "MangaDex",
    readingSourceKind: "external",
    actionId: "read-action-1",
    occurredAt: "2026-06-28T00:00:00.000Z",
    receivedAt: "2026-06-28T00:00:01.000Z",
    sourceMangaId: "mangadex-title-1",
    sourceChapterId: "chapter-5",
    sourceTitle: "External Story",
    sourceChapterNumber: 5,
    chapterKind: "manga",
    rawEventJson: "{}",
    ...overrides,
  };
}
