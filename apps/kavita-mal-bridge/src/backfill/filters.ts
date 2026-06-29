import type { HistoryProbeEvent } from "../history-probe.js";

export type BackfillClassification =
  | "accepted"
  | "filtered-single-page"
  | "filtered-below-completion-threshold"
  | "filtered-too-few-chapters"
  | "possible-one-shot-needs-confirmation"
  | "weak-identity"
  | "duplicate"
  | "needs-review";

export interface BackfillFilterOptions {
  ignorePagesReadLessThanOrEqual?: number;
  completionThresholdPercent?: number;
  minDistinctCompletedChapters?: number;
  oneShotHandlingEnabled?: boolean;
}

export interface ClassifiedBackfillRecord {
  record: HistoryProbeEvent;
  classification: BackfillClassification;
  reason: string;
}

const DEFAULT_OPTIONS: Required<BackfillFilterOptions> = {
  ignorePagesReadLessThanOrEqual: 1,
  completionThresholdPercent: 80,
  minDistinctCompletedChapters: 2,
  oneShotHandlingEnabled: false,
};

export function classifyBackfillRecord(
  record: HistoryProbeEvent,
  options: BackfillFilterOptions = {},
): ClassifiedBackfillRecord {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  if (!hasStrongIdentity(record)) {
    return { record, classification: "weak-identity", reason: "Missing stable source identity." };
  }
  if ((record.pagesRead ?? 0) <= resolved.ignorePagesReadLessThanOrEqual) {
    return {
      record,
      classification: "filtered-single-page",
      reason: "Only one or fewer pages were read.",
    };
  }
  if ((record.completionPercent ?? 0) < resolved.completionThresholdPercent) {
    return {
      record,
      classification: "filtered-below-completion-threshold",
      reason: "Completion percent is below the configured threshold.",
    };
  }
  return { record, classification: "accepted", reason: "Record passed basic filters." };
}

export function filterBackfillRecords(
  records: HistoryProbeEvent[],
  options: BackfillFilterOptions = {},
): ClassifiedBackfillRecord[] {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const firstPass = records.map((record) => classifyBackfillRecord(record, resolved));
  const completedByTitle = new Map<string, Set<string>>();
  for (const item of firstPass) {
    if (item.classification !== "accepted") continue;
    const key = titleKey(item.record);
    if (!completedByTitle.has(key)) completedByTitle.set(key, new Set());
    completedByTitle.get(key)?.add(item.record.sourceChapterId ?? "");
  }
  const seen = new Set<string>();
  return firstPass.map((item) => {
    if (item.classification !== "accepted") return item;
    const dedupeKey = `${item.record.readingSourceId}:${item.record.sourceMangaId}:${item.record.sourceChapterId}`;
    if (seen.has(dedupeKey)) {
      return { ...item, classification: "duplicate", reason: "Duplicate historical record." };
    }
    seen.add(dedupeKey);
    const chapterCount = completedByTitle.get(titleKey(item.record))?.size ?? 0;
    if (chapterCount < resolved.minDistinctCompletedChapters) {
      return resolved.oneShotHandlingEnabled
        ? {
            ...item,
            classification: "possible-one-shot-needs-confirmation",
            reason: "Only one chapter was seen; one-shot handling requires review.",
          }
        : {
            ...item,
            classification: "filtered-too-few-chapters",
            reason: "Too few distinct completed chapters for automatic backfill.",
          };
    }
    return item;
  });
}

function hasStrongIdentity(record: HistoryProbeEvent): boolean {
  return (
    record.reliability === "reliable" &&
    Boolean(record.readingSourceId) &&
    Boolean(record.sourceMangaId) &&
    Boolean(record.sourceMangaTitle) &&
    Boolean(record.sourceChapterId) &&
    Number.isFinite(record.sourceChapterNumber) &&
    record.completed === true
  );
}

function titleKey(record: HistoryProbeEvent): string {
  return `${record.readingSourceId ?? ""}:${record.sourceMangaId ?? ""}`;
}
