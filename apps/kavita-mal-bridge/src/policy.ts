export type BridgeTrackingMode = "chapter-and-volume" | "chapter-only" | "volume-only" | "disabled";

export type DecimalChapterPolicy = "ignore" | "floor" | "track";

export interface BridgeTrackingPolicy {
  trackingMode: BridgeTrackingMode;
  chapterOffset: number;
  volumeOffset: number;
  ignoreSpecials: boolean;
  decimalChapterPolicy: DecimalChapterPolicy;
}

export interface BridgeObservedProgress {
  kavitaCompletedChapter?: number;
  kavitaCompletedVolume?: number;
  isSpecial: boolean;
}

export interface MalListProgress {
  chaptersRead: number;
  volumesRead: number;
  status: "reading" | "completed" | "on_hold" | "dropped" | "plan_to_read";
  totalChapters?: number;
  totalVolumes?: number;
}

export interface BridgeMalProgressUpdate {
  num_chapters_read?: number;
  num_volumes_read?: number;
  status?: "reading" | "completed";
}

export function defaultTrackingPolicyForSeries(
  contentType: "manga" | "novel" | undefined,
): BridgeTrackingPolicy {
  return {
    trackingMode: contentType === "novel" ? "volume-only" : "chapter-and-volume",
    chapterOffset: 0,
    volumeOffset: 0,
    ignoreSpecials: true,
    decimalChapterPolicy: "ignore",
  };
}

export function planBridgeMalUpdate(input: {
  observed: BridgeObservedProgress;
  current: MalListProgress;
  policy: BridgeTrackingPolicy;
}): BridgeMalProgressUpdate | undefined {
  const { observed, current, policy } = input;
  if (policy.trackingMode === "disabled") return undefined;
  if (policy.ignoreSpecials && observed.isSpecial) return undefined;

  const chapter = normalizeChapter(observed.kavitaCompletedChapter, policy);
  const volume = normalizeWholeNumber(observed.kavitaCompletedVolume, policy.volumeOffset);
  const update: BridgeMalProgressUpdate = {};

  if (
    chapter !== undefined &&
    (policy.trackingMode === "chapter-and-volume" || policy.trackingMode === "chapter-only")
  ) {
    const targetChapter = capToKnownTotal(chapter, current.totalChapters ?? 0);
    if (targetChapter > current.chaptersRead) update.num_chapters_read = targetChapter;
  }

  if (
    volume !== undefined &&
    (policy.trackingMode === "chapter-and-volume" || policy.trackingMode === "volume-only")
  ) {
    const targetVolume = capToKnownTotal(volume, current.totalVolumes ?? 0);
    if (targetVolume > current.volumesRead) update.num_volumes_read = targetVolume;
  }

  if (Object.keys(update).length === 0) return undefined;
  if (current.status === "plan_to_read") update.status = "reading";
  return update;
}

function normalizeChapter(
  value: number | undefined,
  policy: BridgeTrackingPolicy,
): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  let withOffset = value + policy.chapterOffset;
  if (!Number.isInteger(withOffset)) {
    if (policy.decimalChapterPolicy === "ignore") return undefined;
    if (policy.decimalChapterPolicy === "floor") withOffset = Math.floor(withOffset);
  }
  return withOffset > 0 ? withOffset : undefined;
}

function normalizeWholeNumber(value: number | undefined, offset: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const withOffset = value + offset;
  return Number.isInteger(withOffset) && withOffset > 0 ? withOffset : undefined;
}

function capToKnownTotal(value: number, total: number): number {
  return total > 0 ? Math.min(value, total) : value;
}
