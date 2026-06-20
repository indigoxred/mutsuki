import { applyIntegerOffset } from "../shared/numbers.js";
import type {
  MalCurrentProgress,
  MalProgressUpdate,
  MalReadAction,
  TrackingPolicy,
} from "./models.js";

export function defaultPolicyForContentType(
  contentType: "manga" | "novel" | undefined,
): TrackingPolicy {
  return {
    mode: contentType === "novel" ? "volume-only" : "chapter-and-volume",
    chapterOffset: 0,
    volumeOffset: 0,
    ignoreSpecials: true,
    decimalChapterPolicy: "ignore",
    markCompletedAutomatically: false,
    preserveExistingStatus: true,
  };
}

export function planMalUpdate(input: {
  action: MalReadAction;
  current: MalCurrentProgress;
  policy: TrackingPolicy;
}): MalProgressUpdate | undefined {
  const { action, current, policy } = input;
  if (policy.mode === "disabled") return undefined;
  if (policy.ignoreSpecials && action.isSpecial) return undefined;
  if (
    policy.decimalChapterPolicy === "ignore" &&
    action.chapterNumber !== undefined &&
    !Number.isInteger(action.chapterNumber)
  ) {
    return undefined;
  }

  const targetChapter = normalizeChapter(action.chapterNumber, policy);
  const targetVolume = applyIntegerOffset(action.volumeNumber, policy.volumeOffset);
  const update: MalProgressUpdate = {};

  if (
    (policy.mode === "chapter-and-volume" || policy.mode === "chapter-only") &&
    targetChapter !== undefined
  ) {
    const cappedChapter = capToKnownTotal(targetChapter, current.totalChapters);
    if (cappedChapter > current.chaptersRead) {
      update.num_chapters_read = cappedChapter;
    }
  }

  if (
    (policy.mode === "chapter-and-volume" || policy.mode === "volume-only") &&
    action.isLastInVolume &&
    targetVolume !== undefined
  ) {
    const cappedVolume = capToKnownTotal(targetVolume, current.totalVolumes);
    if (cappedVolume > current.volumesRead) {
      update.num_volumes_read = cappedVolume;
    }
  }

  if (Object.keys(update).length === 0) return undefined;

  maybeSetStatus(update, current, policy);
  return update;
}

function normalizeChapter(
  chapterNumber: number | undefined,
  policy: TrackingPolicy,
): number | undefined {
  if (chapterNumber === undefined || !Number.isFinite(chapterNumber)) return undefined;
  let value = chapterNumber + policy.chapterOffset;
  if (!Number.isInteger(value)) {
    if (policy.decimalChapterPolicy === "ignore") return undefined;
    if (policy.decimalChapterPolicy === "floor") value = Math.floor(value);
  }
  return value > 0 ? value : undefined;
}

function capToKnownTotal(value: number, total: number): number {
  return total > 0 ? Math.min(value, total) : value;
}

function maybeSetStatus(
  update: MalProgressUpdate,
  current: MalCurrentProgress,
  policy: TrackingPolicy,
): void {
  const reachedChapterTotal =
    current.totalChapters > 0 &&
    (update.num_chapters_read ?? current.chaptersRead) >= current.totalChapters;
  const reachedVolumeTotal =
    current.totalVolumes > 0 &&
    (update.num_volumes_read ?? current.volumesRead) >= current.totalVolumes;

  if (policy.markCompletedAutomatically && (reachedChapterTotal || reachedVolumeTotal)) {
    update.status = "completed";
    return;
  }

  if (
    policy.preserveExistingStatus &&
    (current.status === "on_hold" || current.status === "dropped")
  ) {
    return;
  }

  if (current.status === "plan_to_read") {
    update.status = "reading";
  }
}
