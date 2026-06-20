import { classifySpecialTitle, parseReadingNumber } from "../shared/numbers.js";
import type { KavitaTocItem, MutsukiLogicalChapter } from "./models.js";

export interface LogicalChapterInput {
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  volumeNumber: number;
  totalPages: number;
  toc: KavitaTocItem[];
}

interface FlatTocItem {
  title: string;
  page: number;
  tocPath: string[];
}

export function flattenKavitaToc(toc: KavitaTocItem[], totalPages: number): FlatTocItem[] {
  const flattened: FlatTocItem[] = [];

  const visit = (item: KavitaTocItem, parents: string[]): void => {
    const title = item.title.trim() || `Page ${item.page}`;
    const tocPath = [...parents, title];
    if (Number.isInteger(item.page) && item.page >= 1 && item.page <= totalPages) {
      flattened.push({ title, page: item.page, tocPath });
    }
    for (const child of item.children ?? []) {
      visit(child, tocPath);
    }
  };

  for (const item of toc) {
    visit(item, []);
  }

  const byPage = new Map<number, FlatTocItem>();
  for (const item of flattened.sort((a, b) => a.page - b.page)) {
    if (!byPage.has(item.page)) {
      byPage.set(item.page, item);
    }
  }

  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

export function logicalChaptersFromToc(input: LogicalChapterInput): MutsukiLogicalChapter[] {
  const totalPages = Math.max(1, input.totalPages);
  const flat = flattenKavitaToc(input.toc, totalPages);

  if (flat.length === 0) {
    return [
      {
        kavitaSeriesId: input.kavitaSeriesId,
        kavitaVolumeId: input.kavitaVolumeId,
        kavitaChapterId: input.kavitaChapterId,
        title: `Volume ${input.volumeNumber}`,
        tocPath: [`Volume ${input.volumeNumber}`],
        startPage: 1,
        endPage: totalPages,
        chapterNumber: 1,
        volumeNumber: input.volumeNumber,
        isSpecial: false,
        isLastInVolume: true,
      },
    ];
  }

  return flat.map((item, index) => {
    const next = flat[index + 1];
    const parsed = parseReadingNumber(item.title);
    return {
      kavitaSeriesId: input.kavitaSeriesId,
      kavitaVolumeId: input.kavitaVolumeId,
      kavitaChapterId: input.kavitaChapterId,
      title: item.title,
      tocPath: item.tocPath,
      startPage: item.page,
      endPage: next ? Math.max(item.page, next.page - 1) : totalPages,
      chapterNumber: parsed?.value ?? index + 1,
      volumeNumber: input.volumeNumber,
      isSpecial: classifySpecialTitle(item.title),
      isLastInVolume: index === flat.length - 1,
    };
  });
}

export function buildEpubChapterId(input: {
  physicalChapterId: number;
  startPage: number;
  endPage: number;
  isLastInVolume: boolean;
}): string {
  return `kavita-book:${input.physicalChapterId}:page:${input.startPage}:end:${input.endPage}:last:${
    input.isLastInVolume ? 1 : 0
  }`;
}

export function parseFinalInVolumeFromChapterId(chapterId: string | undefined): boolean {
  return /:last:1$/u.test(chapterId ?? "");
}
