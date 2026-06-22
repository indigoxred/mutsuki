export interface KavitaTocItem {
  title: string;
  page: number;
  part?: string;
  anchor?: string;
  href?: string;
  children?: KavitaTocItem[];
}

export type NovelTocRole =
  | "structural"
  | "publisher-backmatter"
  | "frontmatter"
  | "readable-special"
  | "narrative";

export interface MutsukiLogicalChapter {
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  title?: string;
  tocPath: string[];
  startPage: number;
  endPage: number;
  part?: string;
  chapterNumber: number;
  volumeNumber?: number;
  isSpecial: boolean;
  role: NovelTocRole;
  isLastInVolume: boolean;
  structuralTocEntriesFiltered?: number;
  publisherTocEntriesFiltered?: number;
  frontmatterTocEntries?: number;
  readableSpecialTocEntries?: number;
  narrativeTocEntries?: number;
  parsedWordChapterNumberCount?: number;
}

export interface ResolvedNovelVolume {
  value?: number;
  source:
    | "book-title"
    | "book-metadata"
    | "chapter-title"
    | "file-range"
    | "kavita-volume"
    | "series-title"
    | "unknown";
  confidence: number;
  isDecimal: boolean;
}

export interface NovelPhysicalBook {
  kavitaChapterId: number;
  kavitaVolumeId?: number;
  sourceVolumeIndex: number;
  sourceChapterIndex: number;
  title?: string;
  fileName?: string;
  range?: string;
  pageCount: number;
  rawVolume?: string;
  resolvedVolume: ResolvedNovelVolume;
  volumeResolutionSource: ResolvedNovelVolume["source"];
  chapter: { title?: string; volumeNumber?: string };
}

export interface NovelReadingUnit {
  id: string;
  physicalChapterId: number;
  physicalVolumeId?: number;
  physicalVolumeNumber?: number;
  startPage: number;
  endPage: number;
  segmentIndex: number;
  segmentCount: number;
  title: string;
  role: "frontmatter" | "narrative" | "special";
  isLastInPhysicalBook: boolean;
  sourceTocPath: string[];
}

export interface KavitaBookInfo {
  chapterNumber?: string;
  volumeNumber?: string;
  volumeId?: number;
  bookTitle?: string;
  seriesName?: string;
  seriesFormat?: number | string;
  seriesId: number;
  libraryId: number;
  isSpecial?: boolean;
  pages: number;
}

export interface ResourceFetchResult {
  bytes: ArrayBuffer;
  mimeType: string;
}
