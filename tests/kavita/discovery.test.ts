import assert from "node:assert/strict";
import test from "node:test";

import { ContentRating } from "@paperback/types";

import { getKavitaDiscoverItems, getKavitaDiscoverSections } from "../../src/Kavita/discovery.js";
import { DEFAULT_KAVITA_SETTINGS } from "../../src/Kavita/settings.js";

test("always includes an all series browse section", () => {
  const sections = getKavitaDiscoverSections({
    ...DEFAULT_KAVITA_SETTINGS,
    showOnDeck: false,
    showRecentlyUpdated: false,
    showNewlyAdded: false,
  });

  assert.deepEqual(
    sections.map((section) => section.id),
    ["all-series"],
  );
});

test("maps all series browse items from Kavita series results", async () => {
  const calls: [number, number][] = [];
  const client = {
    getAllSeries: async (pageNumber: number, pageSize: number) => {
      calls.push([pageNumber, pageSize]);
      return [
        {
          id: 42,
          name: "Frieren",
          localizedName: "Sousou no Frieren",
          coverImage: "cover.jpg",
        },
      ];
    },
    getSeriesCoverUrl: (seriesId: number) =>
      `https://kavita.example.test/api/Image/series-cover?seriesId=${seriesId}&apiKey=secret-key`,
  };

  const page = await getKavitaDiscoverItems(
    client as unknown as Parameters<typeof getKavitaDiscoverItems>[0],
    "all-series",
    1,
  );

  assert.deepEqual(calls, [[0, 1]]);
  assert.deepEqual(page.metadata, { page: 1 });
  assert.deepEqual(page.items, [
    {
      type: "simpleCarouselItem",
      mangaId: "kavita-series:42",
      chapterId: "kavita-chapter:0",
      imageUrl: "https://kavita.example.test/api/Image/series-cover?seriesId=42&apiKey=secret-key",
      title: "Frieren",
      subtitle: "Sousou no Frieren",
      contentRating: ContentRating.EVERYONE,
    },
  ]);
});

test("uses discover metadata as the next Kavita page number", async () => {
  const calls: [number, number][] = [];
  const client = {
    getAllSeries: async (pageNumber: number, pageSize: number) => {
      calls.push([pageNumber, pageSize]);
      return [];
    },
    getSeriesCoverUrl: (seriesId: number) => `cover-${seriesId}`,
  };

  const page = await getKavitaDiscoverItems(
    client as unknown as Parameters<typeof getKavitaDiscoverItems>[0],
    "all-series",
    40,
    { page: 3 },
  );

  assert.deepEqual(calls, [[3, 40]]);
  assert.equal(page.metadata, undefined);
});

test("recently updated EPUB items do not emit manga chapter ids", async () => {
  const client = {
    getRecentlyUpdated: async () => [
      {
        seriesId: 42,
        name: "A Simple Survey",
        localizedName: "A Simple Survey",
        format: 3,
        chapterId: 55,
      },
    ],
    getSeriesCoverUrl: (seriesId: number) => `cover-${seriesId}`,
  };

  const page = await getKavitaDiscoverItems(
    client as unknown as Parameters<typeof getKavitaDiscoverItems>[0],
    "recently-updated",
    10,
  );

  assert.equal(page.items[0]?.type, "simpleCarouselItem");
  assert.equal("chapterId" in (page.items[0] as unknown as Record<string, unknown>), false);
  assert.equal(page.items[0]?.mangaId, "kavita-series:42");
});
