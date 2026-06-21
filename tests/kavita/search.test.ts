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
    getSeriesCoverUrl: (seriesId: number) =>
      `https://kavita.example.test/api/Image/series-cover?seriesId=${seriesId}&apiKey=secret-key`,
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
      imageUrl: "https://kavita.example.test/api/Image/series-cover?seriesId=55&apiKey=secret-key",
      contentRating: ContentRating.EVERYONE,
    },
  ]);
});
