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
  const client = {
    getAllSeries: async () => [
      {
        id: 42,
        name: "Frieren",
        localizedName: "Sousou no Frieren",
        coverImage: "cover.jpg",
      },
    ],
  };

  const items = await getKavitaDiscoverItems(
    client as unknown as Parameters<typeof getKavitaDiscoverItems>[0],
    "all-series",
    40,
  );

  assert.deepEqual(items, [
    {
      type: "simpleCarouselItem",
      mangaId: "kavita-series:42",
      chapterId: "kavita-chapter:0",
      imageUrl: "cover.jpg",
      title: "Frieren",
      subtitle: "Sousou no Frieren",
      contentRating: ContentRating.EVERYONE,
    },
  ]);
});
