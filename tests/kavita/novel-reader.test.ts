import assert from "node:assert/strict";
import test from "node:test";

import { ContentRating } from "@paperback/types";

import type { KavitaClient } from "../../src/Kavita/client.js";
import { getNovelChaptersFromBook } from "../../src/Kavita/novel-reader.js";

test("does not expose zero-page Kavita book placeholders as readable chapters", async () => {
  let requestedToc = false;
  const chapters = await getNovelChaptersFromBook({
    sourceManga: {
      mangaId: "kavita-series:7",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Novel",
        secondaryTitles: [],
        contentRating: ContentRating.EVERYONE,
        contentType: "novel",
      },
    },
    client: {
      async getBookChapters() {
        requestedToc = true;
        return [];
      },
    } as unknown as KavitaClient,
    kavitaSeriesId: 7,
    kavitaVolumeId: 8,
    kavitaChapterId: 55,
    volumeNumber: 1,
    totalPages: 0,
  });

  assert.equal(requestedToc, false);
  assert.deepEqual(chapters, []);
});
