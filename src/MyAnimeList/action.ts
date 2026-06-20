import { classifySpecialTitle } from "../shared/numbers.js";
import { parseFinalInVolumeFromChapterId } from "../Kavita/toc.js";
import type { MalReadAction } from "./models.js";

interface PaperbackReadActionLike {
  id: string;
  sourceManga: {
    mangaId: string;
    mangaInfo?: unknown;
  };
  readChapter?: {
    chapterId?: string;
    sourceManga?: unknown;
    langCode?: string;
    chapNum?: number;
    volume?: number;
    title?: string;
    additionalInfo?: Record<string, string>;
  };
  chapterId: string;
  chapterSourceId?: string;
  chapterMangaId?: string;
  chapterNum: number;
  chapterVolume?: number;
  creationDate?: Date;
  errorCount?: number;
}

export function actionFromPaperback(
  action: PaperbackReadActionLike,
): MalReadAction & { id: string } {
  const additionalInfo = action.readChapter?.additionalInfo ?? {};
  return {
    id: action.id,
    malMangaId: action.sourceManga.mangaId,
    chapterNumber: action.chapterNum,
    volumeNumber: action.chapterVolume,
    isLastInVolume:
      additionalInfo.isLastInVolume === "true" || parseFinalInVolumeFromChapterId(action.chapterId),
    isSpecial:
      additionalInfo.isSpecial === "true" || classifySpecialTitle(action.readChapter?.title),
  };
}
