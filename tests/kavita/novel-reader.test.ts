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

test("maps a one-page Kavita EPUB to page zero instead of page one", async () => {
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
        return [
          {
            title: "A Simple Survey:Volume2",
            page: 0,
            children: [{ title: "Greeting", page: 0 }],
          },
        ];
      },
    } as unknown as KavitaClient,
    kavitaSeriesId: 7,
    kavitaVolumeId: 8,
    kavitaChapterId: 55,
    volumeNumber: 1,
    totalPages: 1,
  });

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0]?.additionalInfo?.startPage, "0");
  assert.equal(chapters[0]?.additionalInfo?.endPage, "0");
});
