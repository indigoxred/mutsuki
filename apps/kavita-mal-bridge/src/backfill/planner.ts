import type { HistoryProbeEvent } from "../history-probe.js";
import {
  filterBackfillRecords,
  type BackfillClassification,
  type BackfillFilterOptions,
} from "./filters.js";

export interface BackfillMappingPreview {
  malId: number;
  currentChapter: number;
  currentVolume: number;
  chapterOffset?: number;
  volumeOffset?: number;
}

export type BackfillPreviewStatus =
  | "would-update"
  | "no-op-mal-ahead"
  | "needs-review"
  | "weak-identity"
  | BackfillClassification;

export interface BackfillPreviewRow {
  readingSourceId?: string;
  sourceMangaId?: string;
  sourceMangaTitle?: string;
  status: BackfillPreviewStatus;
  reason: string;
  malId?: number;
  wouldUpdate?: {
    chapter?: number;
    volume?: number;
  };
}

export interface BackfillPreview {
  rows: BackfillPreviewRow[];
  acceptedCount: number;
  filteredCount: number;
  reviewCount: number;
}

export function planBackfillPreview(input: {
  records: HistoryProbeEvent[];
  mappings: Map<string, BackfillMappingPreview>;
  filterOptions?: BackfillFilterOptions;
}): BackfillPreview {
  const classified = filterBackfillRecords(input.records, input.filterOptions);
  const rows = classified.map((item): BackfillPreviewRow => {
    const base = {
      readingSourceId: item.record.readingSourceId,
      sourceMangaId: item.record.sourceMangaId,
      sourceMangaTitle: item.record.sourceMangaTitle,
    };
    if (item.classification !== "accepted") {
      return {
        ...base,
        status: item.classification,
        reason: item.reason,
      };
    }
    const mapping = input.mappings.get(mappingKey(item.record));
    if (!mapping) {
      return {
        ...base,
        status: "needs-review",
        reason: "No trusted MAL mapping exists for this historical title.",
      };
    }
    const desiredChapter = Math.floor(
      (item.record.sourceChapterNumber ?? 0) + (mapping.chapterOffset ?? 0),
    );
    const desiredVolume = Math.floor(
      (item.record.sourceChapterVolume ?? 0) + (mapping.volumeOffset ?? 0),
    );
    const chapterUpdate = Math.max(mapping.currentChapter, desiredChapter);
    const volumeUpdate = Math.max(mapping.currentVolume, desiredVolume);
    if (chapterUpdate === mapping.currentChapter && volumeUpdate === mapping.currentVolume) {
      return {
        ...base,
        malId: mapping.malId,
        status: "no-op-mal-ahead",
        reason: "MAL is already at or ahead of the historical progress.",
      };
    }
    return {
      ...base,
      malId: mapping.malId,
      status: "would-update",
      reason: "Dry-run preview only; no MAL outbox row is created.",
      wouldUpdate: {
        chapter: chapterUpdate > mapping.currentChapter ? chapterUpdate : undefined,
        volume: volumeUpdate > mapping.currentVolume ? volumeUpdate : undefined,
      },
    };
  });
  return {
    rows,
    acceptedCount: rows.filter((row) => row.status === "would-update").length,
    filteredCount: rows.filter(
      (row) => row.status.startsWith("filtered") || row.status === "duplicate",
    ).length,
    reviewCount: rows.filter(
      (row) => row.status === "needs-review" || row.status === "weak-identity",
    ).length,
  };
}

function mappingKey(record: HistoryProbeEvent): string {
  return `${record.readingSourceId ?? ""}:${record.sourceMangaId ?? ""}`;
}
