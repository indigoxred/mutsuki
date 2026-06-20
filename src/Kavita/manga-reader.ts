import type { Chapter, ChapterDetails, SourceManga } from "@paperback/types";

import type { KavitaClient } from "./client.js";
import { mangaChapterToPaperback, type KavitaChapterDto } from "./chapter-mapper.js";

export function mapKavitaMangaChapters(
  sourceManga: SourceManga,
  chapters: KavitaChapterDto[],
  client: KavitaClient,
): Chapter[] {
  return chapters.map(
    (chapter, index) =>
      mangaChapterToPaperback({
        sourceManga,
        kavitaChapter: chapter,
        pageUrl: (page) => client.getImagePageUrl({ chapterId: chapter.id, page }),
        sortingIndex: index,
      }).chapter as Chapter,
  );
}

export async function getKavitaImageChapterDetails(
  sourceManga: SourceManga,
  chapter: KavitaChapterDto,
  client: KavitaClient,
): Promise<ChapterDetails> {
  return mangaChapterToPaperback({
    sourceManga,
    kavitaChapter: chapter,
    pageUrl: (page) => client.getImagePageUrl({ chapterId: chapter.id, page }),
    sortingIndex: 0,
  }).details;
}
