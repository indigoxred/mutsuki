import assert from "node:assert/strict";
import test from "node:test";

import { actionFromPaperback } from "../../src/MyAnimeList/action.js";

test("extracts final-in-volume and special metadata from Paperback read actions", () => {
  const action = actionFromPaperback({
    id: "queue-1",
    chapterId: "kavita-book:55:page:5:end:7:last:1",
    chapterNum: 2,
    chapterVolume: 1,
    sourceManga: {
      mangaId: "123",
      mangaInfo: {
        thumbnailUrl: "",
        synopsis: "",
        primaryTitle: "Novel",
        secondaryTitles: [],
        contentRating: "SAFE",
        contentType: "novel",
      },
    },
    readChapter: {
      chapterId: "kavita-book:55:page:5:end:7:last:1",
      sourceManga: {
        mangaId: "123",
        mangaInfo: {
          thumbnailUrl: "",
          synopsis: "",
          primaryTitle: "Novel",
          secondaryTitles: [],
          contentRating: "SAFE",
        },
      },
      langCode: "en",
      chapNum: 2,
      volume: 1,
      title: "Afterword",
      additionalInfo: { isSpecial: "true", isLastInVolume: "true" },
    },
    chapterSourceId: "mutsuki-kavita",
    chapterMangaId: "kavita-series:7",
    creationDate: new Date("2026-01-01T00:00:00Z"),
    errorCount: 0,
  });

  assert.deepEqual(action, {
    id: "queue-1",
    malMangaId: "123",
    chapterNumber: 2,
    volumeNumber: 1,
    isLastInVolume: true,
    isSpecial: true,
  });
});
