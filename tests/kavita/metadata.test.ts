import assert from "node:assert/strict";
import test from "node:test";

import { sourceMangaFromKavitaSeries } from "../../src/Kavita/metadata.js";

test("maps Kavita series covers through the authenticated series cover endpoint", () => {
  const manga = sourceMangaFromKavitaSeries(
    {
      id: 42,
      name: "Frieren",
      coverImage: "v123_c456.png",
      libraryId: 7,
    },
    (seriesId) =>
      `https://kavita.example.test/api/Image/series-cover?seriesId=${seriesId}&apiKey=secret-key`,
  );

  assert.equal(
    manga.mangaInfo.thumbnailUrl,
    "https://kavita.example.test/api/Image/series-cover?seriesId=42&apiKey=secret-key",
  );
});

test("detects numeric Kavita EPUB format as a Paperback novel", () => {
  const manga = sourceMangaFromKavitaSeries({
    id: 99,
    name: "Novel",
    format: 3,
    libraryName: "Novels",
  });

  assert.equal(manga.mangaInfo.contentType, "novel");
  assert.equal(manga.mangaInfo.additionalInfo?.format, "epub");
});
