import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";
import { createJikanResolver } from "../../apps/kavita-mal-bridge/src/resolvers/jikan-resolver.js";
import { SqliteBridgeStore } from "../../apps/kavita-mal-bridge/src/storage.js";

test("Jikan resolver caches candidate discovery by normalized query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-resolvers-"));
  const store = new SqliteBridgeStore(join(directory, "bridge.sqlite"));
  store.migrate();
  let fetchCount = 0;
  const resolver = createJikanResolver({
    config: bridgeConfigFromEnv({
      RESOLVER_CACHE_TTL_HOURS: "24",
      RESOLVER_MAX_CANDIDATES_PER_QUERY: "5",
    }),
    store,
    transport: {
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ data: [{ mal_id: 116880 }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  });

  try {
    const input = {
      event: {
        schemaVersion: 3 as const,
        eventSource: "paperback-progress-bridge" as const,
        readingSourceId: "WeebCentral",
        readingSourceName: "WeebCentral",
        readingSourceKind: "external" as const,
        actionId: "read-1",
        occurredAt: "2026-06-28T00:00:00.000Z",
        receivedAt: "2026-06-28T00:00:01.000Z",
        sourceMangaId: "01J76XYCVRSNNY2C2QH721967B",
        sourceChapterId: "chapter-1",
        sourceTitle: "Chained Soldier",
        sourceChapterNumber: 1,
        chapterKind: "manga" as const,
        rawEventJson: "{}",
      },
      series: {
        kavitaSeriesId: -1,
        title: "Chained Soldier",
        contentType: "manga" as const,
        mediaType: "manga" as const,
        isSpecial: false,
      },
      titleVariants: ["Chained Soldier"],
    };

    assert.deepEqual(await resolver.discoverCandidates(input), [
      { malId: 116880, provenance: ["jikan-search"] },
    ]);
    assert.deepEqual(await resolver.discoverCandidates(input), [
      { malId: 116880, provenance: ["jikan-search"] },
    ]);
    assert.equal(fetchCount, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
