import assert from "node:assert/strict";
import test from "node:test";

import { ContentRating } from "@paperback/types";

import { searchKavita } from "../../src/Kavita/search.js";

test("maps current Kavita grouped search results into Paperback items", async () => {
  const client = {
    searchSeries: async () => ({
      series: [
        {
          seriesId: 55,
          name: "Dungeon Meshi",
          localizedName: "Delicious in Dungeon",
        },
      ],
    }),
  };

  const items = await searchKavita(
    client as unknown as Parameters<typeof searchKavita>[0],
    "dungeon",
    20,
  );

  assert.deepEqual(items, [
    {
      mangaId: "kavita-series:55",
      title: "Dungeon Meshi",
      imageUrl: "",
      contentRating: ContentRating.EVERYONE,
    },
  ]);
});
