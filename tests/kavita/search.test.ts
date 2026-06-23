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
          coverImage: "series55.png",
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

test("does not emit search image URLs for Kavita results with empty cover images", async () => {
  let coverRequests = 0;
  const client = {
    searchSeries: async () => ({
      series: [
        {
          seriesId: 14998,
          name: "Anohana:Part 1",
          coverImage: "",
        },
      ],
    }),
    getSeriesCoverUrl: (seriesId: number) => {
      coverRequests += 1;
      return `cover-${seriesId}`;
    },
  };

  const items = await searchKavita(
    client as unknown as Parameters<typeof searchKavita>[0],
    "anohana",
    20,
  );

  assert.equal(items[0]?.imageUrl, "");
  assert.equal(coverRequests, 0);
});
