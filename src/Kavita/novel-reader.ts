import type { Chapter, ChapterDetails, SourceManga } from "@paperback/types";

import { assembleHtmlChapter } from "./html-assembler.js";
import type { KavitaClient } from "./client.js";
import { novelChapterToPaperback } from "./chapter-mapper.js";
import { rewriteHtmlResources } from "./resource-rewriter.js";
import { logicalChaptersFromToc } from "./toc.js";

export async function getNovelChaptersFromBook(input: {
  sourceManga: SourceManga;
  client: KavitaClient;
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  volumeNumber: number;
  totalPages: number;
}): Promise<Chapter[]> {
  const toc = await input.client.getBookChapters(input.kavitaChapterId);
  return logicalChaptersFromToc({
    kavitaSeriesId: input.kavitaSeriesId,
    kavitaVolumeId: input.kavitaVolumeId,
    kavitaChapterId: input.kavitaChapterId,
    volumeNumber: input.volumeNumber,
    totalPages: input.totalPages,
    toc,
  }).map(
    (logicalChapter, index) =>
      novelChapterToPaperback({
        sourceManga: input.sourceManga,
        logicalChapter,
        html: "",
        sortingIndex: index,
      }).chapter as Chapter,
  );
}

export async function getNovelChapterDetails(input: {
  sourceManga: SourceManga;
  chapter: Chapter;
  client: KavitaClient;
  maxResourceBytes: number;
  maxChapterBytes: number;
}): Promise<ChapterDetails> {
  const info = input.chapter.additionalInfo ?? {};
  const kavitaChapterId = Number(info.kavitaChapterId);
  const startPage = Number(info.startPage);
  const endPage = Number(info.endPage);
  const pages: string[] = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pages.push(await input.client.getBookPage(kavitaChapterId, page));
  }

  const html = await assembleHtmlChapter({
    title: input.chapter.title ?? `Chapter ${input.chapter.chapNum}`,
    pages,
    rewriteResources: async (fragment) =>
      (
        await rewriteHtmlResources({
          html: fragment,
          basePath: `page-${startPage}.xhtml`,
          maxResourceBytes: input.maxResourceBytes,
          maxChapterBytes: input.maxChapterBytes,
          fetchResource: async (path) => input.client.getBookResource(kavitaChapterId, path),
        })
      ).html,
  });

  return {
    id: input.chapter.chapterId,
    mangaId: input.sourceManga.mangaId,
    type: "html",
    html,
  };
}
