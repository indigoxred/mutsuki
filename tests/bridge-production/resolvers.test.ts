import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bridgeConfigFromEnv } from "../../apps/kavita-mal-bridge/src/config.js";
import { createJikanResolver } from "../../apps/kavita-mal-bridge/src/resolvers/jikan-resolver.js";
import { createMangaDexResolver } from "../../apps/kavita-mal-bridge/src/resolvers/mangadex-resolver.js";
import { titleVariantsFromExternalEvent } from "../../apps/kavita-mal-bridge/src/resolvers/title-resolver.js";
import { createWeebCentralResolver } from "../../apps/kavita-mal-bridge/src/resolvers/weebcentral-resolver.js";
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

test("title variants include safe thumbnail URL slugs without image extensions", () => {
  const variants = titleVariantsFromExternalEvent({
    schemaVersion: 3,
    eventSource: "paperback-progress-bridge",
    readingSourceId: "WeebCentral",
    readingSourceName: "WeebCentral",
    readingSourceKind: "external",
    actionId: "read-1",
    occurredAt: "2026-06-28T00:00:00.000Z",
    receivedAt: "2026-06-28T00:00:01.000Z",
    sourceMangaId: "04D66VAMY7PGK8HVKY3CCGTS",
    sourceChapterId: "chapter-1",
    sourceTitle: "Ookii Muki Muki Chiisai Muchi Muchi",
    sourceThumbnailUrl:
      "https://imgs-2.2xstorage.com/thumb/ookii-onnanoko-wa-daisuki-desu-ka.webp?apiKey=redacted",
    sourceChapterNumber: 1,
    chapterKind: "manga",
    rawEventJson: "{}",
  });

  assert.ok(variants.includes("ookii onnanoko wa daisuki desu ka"));
  assert.ok(!variants.some((variant) => variant.includes(".webp")));
});

test("Jikan resolver does not cache retryable failures as empty results", async () => {
  const fixture = await resolverFixture();
  let fetchCount = 0;
  const resolver = createJikanResolver({
    config: bridgeConfigFromEnv({
      RESOLVER_CACHE_TTL_HOURS: "24",
      RESOLVER_MAX_CANDIDATES_PER_QUERY: "5",
    }),
    store: fixture.store,
    transport: {
      fetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? new Response("rate limit", { status: 429 })
          : new Response(JSON.stringify({ data: [{ mal_id: 116880 }] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      },
    },
  });

  try {
    const input = resolverInput();
    assert.deepEqual(await resolver.discoverCandidates(input), []);
    assert.deepEqual(await resolver.discoverCandidates(input), [
      { malId: 116880, provenance: ["jikan-search"] },
    ]);
    assert.equal(fetchCount, 2);
    const diagnostics = await fixture.store.listResolverDiagnostics({
      readingSourceId: "WeebCentral",
      sourceMangaId: "01J76XYCVRSNNY2C2QH721967B",
    });
    assert.ok(diagnostics.some((entry) => entry.outcome === "rate-limited"));
    assert.ok(diagnostics.some((entry) => entry.outcome === "ok"));
  } finally {
    await fixture.cleanup();
  }
});

test("WeebCentral resolver enriches public series page AniList links into MAL candidates", async () => {
  const fixture = await resolverFixture();
  const requestedUrls: string[] = [];
  const resolver = createWeebCentralResolver({
    config: bridgeConfigFromEnv({ RESOLVER_CACHE_TTL_HOURS: "24" }),
    store: fixture.store,
    transport: {
      fetch: async (url, init) => {
        requestedUrls.push(url);
        if (url.includes("weebcentral.com/series/01K4D06VAMY7PGK8HVKY3CCGTS")) {
          assert.equal(init?.headers instanceof Headers, false);
          return new Response(
            `<!doctype html><html><head>
              <link rel="canonical" href="https://weebcentral.com/series/01K4D06VAMY7PGK8HVKY3CCGTS/ookii-muki-muki-chiisai-muchi-muchi">
              <meta property="og:title" content="Ookii Muki Muki Chiisai Muchi Muchi | Weeb Central">
            </head><body>
              <h1>Ookii Muki Muki Chiisai Muchi Muchi</h1>
              <span><strong>Author(s): </strong><a>HINOHARA Fuki</a></span>
              <a href="https://anilist.co/manga/195696">AniList</a>
              <a href="https://www.mangaupdates.com/series/umsaqer">MangaUpdates</a>
              <p class="whitespace-pre-wrap">Synthetic description only.</p>
            </body></html>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          );
        }
        if (url === "https://graphql.anilist.co") {
          const body = init?.body;
          if (typeof body !== "string") throw new Error("Expected AniList GraphQL JSON body.");
          assert.match(body, /195696/u);
          return new Response(
            JSON.stringify({
              data: {
                Media: {
                  idMal: 182880,
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected URL ${url}`);
      },
    },
  });

  try {
    const candidates = await resolver.discoverCandidates(
      resolverInput({
        sourceMangaId: "01K4D06VAMY7PGK8HVKY3CCGTS",
        sourceTitle: "Ookii Muki Muki Chiisai Muchi Muchi",
        sourceShareUrl: "https://weebcentral.com/series/01K4D06VAMY7PGK8HVKY3CCGTS",
      }),
    );

    assert.deepEqual(candidates, [
      {
        malId: 182880,
        provenance: ["weebcentral-enrichment", "weebcentral-anilist-id", "mal-direct-lookup"],
      },
    ]);
    assert.equal(requestedUrls.filter((url) => url.includes("weebcentral.com/series")).length, 1);
    assert.deepEqual(
      await resolver.discoverCandidates(
        resolverInput({
          sourceMangaId: "01K4D06VAMY7PGK8HVKY3CCGTS",
          sourceTitle: "Ookii Muki Muki Chiisai Muchi Muchi",
          sourceShareUrl: "https://weebcentral.com/series/01K4D06VAMY7PGK8HVKY3CCGTS",
        }),
      ),
      candidates,
    );
    assert.equal(requestedUrls.filter((url) => url.includes("weebcentral.com/series")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("MangaDex resolver enriches public manga metadata external links into MAL candidates", async () => {
  const fixture = await resolverFixture();
  const requestedUrls: string[] = [];
  const resolver = createMangaDexResolver({
    config: bridgeConfigFromEnv({ RESOLVER_CACHE_TTL_HOURS: "24" }),
    store: fixture.store,
    transport: {
      fetch: async (url, init) => {
        requestedUrls.push(url);
        assert.equal(init?.headers instanceof Headers, false);
        if (url.includes("api.mangadex.org/manga/b52534a4-9206-43c8-96a7-88e9b0f02c50")) {
          return new Response(
            JSON.stringify({
              data: {
                id: "b52534a4-9206-43c8-96a7-88e9b0f02c50",
                type: "manga",
                attributes: {
                  title: { en: "Ikinokore! Shachiku-chan" },
                  altTitles: [{ ja: "いきのこれ！ 社畜ちゃん" }],
                  links: {
                    mal: "106075",
                    al: "99031",
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://graphql.anilist.co") {
          const body = init?.body;
          if (typeof body !== "string") throw new Error("Expected AniList GraphQL JSON body.");
          assert.match(body, /99031/u);
          return new Response(JSON.stringify({ data: { Media: { idMal: 106075 } } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    },
  });

  try {
    const input = resolverInput({
      readingSourceId: "MangaDex",
      readingSourceName: "MangaDex",
      sourceMangaId: "b52534a4-9206-43c8-96a7-88e9b0f02c50",
      sourceTitle: "Ikinokore! Shachiku-chan",
      sourceShareUrl: "https://mangadex.org/title/b52534a4-9206-43c8-96a7-88e9b0f02c50",
    });
    const candidates = await resolver.discoverCandidates(input);

    assert.deepEqual(candidates, [
      {
        malId: 106075,
        provenance: [
          "mangadex-enrichment",
          "mangadex-mal-id",
          "mangadex-anilist-id",
          "mal-direct-lookup",
        ],
      },
    ]);
    assert.equal(requestedUrls.filter((url) => url.includes("api.mangadex.org/manga")).length, 1);
    assert.deepEqual(await resolver.discoverCandidates(input), candidates);
    assert.equal(requestedUrls.filter((url) => url.includes("api.mangadex.org/manga")).length, 1);
    const diagnostics = await fixture.store.listResolverDiagnostics({
      readingSourceId: "MangaDex",
      sourceMangaId: "b52534a4-9206-43c8-96a7-88e9b0f02c50",
    });
    assert.ok(diagnostics.some((entry) => entry.resolver === "mangadex" && entry.outcome === "ok"));
  } finally {
    await fixture.cleanup();
  }
});

async function resolverFixture(): Promise<{
  store: SqliteBridgeStore;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mutsuki-resolvers-"));
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

function resolverInput(
  overrides: Partial<Parameters<typeof titleVariantsFromExternalEvent>[0]> = {},
) {
  const event = {
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
    ...overrides,
  };
  return {
    event,
    series: {
      kavitaSeriesId: -1,
      title: event.sourceTitle,
      contentType: "manga" as const,
      mediaType: "manga" as const,
      webLinks: event.sourceShareUrl ? [event.sourceShareUrl] : undefined,
      externalIds: event.sourceExternalIds,
      isSpecial: false,
    },
    titleVariants: titleVariantsFromExternalEvent(event),
  };
}
