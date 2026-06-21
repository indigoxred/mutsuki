export interface KavitaTocItem {
  title: string;
  page: number;
  children?: KavitaTocItem[];
}

export interface MutsukiLogicalChapter {
  kavitaSeriesId: number;
  kavitaVolumeId?: number;
  kavitaChapterId: number;
  title: string;
  tocPath: string[];
  startPage: number;
  endPage: number;
  chapterNumber: number;
  volumeNumber?: number;
  isSpecial: boolean;
  isLastInVolume: boolean;
  structuralTocEntriesFiltered?: number;
  parsedWordChapterNumberCount?: number;
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
