import { parseVolumeNumber } from "../shared/numbers.js";
import type { NovelPhysicalBook, ResolvedNovelVolume } from "./models.js";
import type { KavitaChapterDto } from "./chapter-mapper.js";

export function resolveNovelVolume(input: {
  chapter: Pick<KavitaChapterDto, "title" | "volumeNumber">;
  bookInfo: Record<string, unknown>;
  seriesTitle?: string;
}): ResolvedNovelVolume {
  const rawKavitaVolume =
    validStandaloneVolume(input.bookInfo.volumeNumber) ??
    validStandaloneVolume(input.chapter.volumeNumber);
  const candidates = [
    bookTitleVolumeCandidate(stringValue(input.bookInfo.bookTitle), rawKavitaVolume),
    resolvedVolumeCandidate("book-metadata", input.bookInfo.volumeNumber, 90, "standalone"),
    resolvedVolumeCandidate("chapter-title", input.chapter.title, 80, "marker"),
    resolvedVolumeCandidate(
      "file-range",
      stringValue(input.bookInfo.range ?? input.bookInfo.fileName ?? input.bookInfo.filename),
      75,
      "marker",
    ),
    resolvedVolumeCandidate("kavita-volume", input.chapter.volumeNumber, 70, "standalone"),
    resolvedVolumeCandidate(
      "series-title",
      stringValue(input.bookInfo.seriesName) ?? input.seriesTitle,
      50,
      "marker",
    ),
  ].filter((candidate): candidate is ResolvedNovelVolume => candidate.value !== undefined);

  candidates.sort(
    (a, b) => b.confidence - a.confidence || Number(b.isDecimal) - Number(a.isDecimal),
  );
  return (
    candidates[0] ?? {
      value: undefined,
      source: "unknown",
      confidence: 0,
      isDecimal: false,
    }
  );
}

export function compareNovelPhysicalBooks(a: NovelPhysicalBook, b: NovelPhysicalBook): number {
  const aVolume = a.resolvedVolume.value;
  const bVolume = b.resolvedVolume.value;
  if (aVolume !== undefined && bVolume !== undefined && aVolume !== bVolume) {
    return aVolume - bVolume;
  }
  if (aVolume !== undefined && bVolume === undefined) return -1;
  if (aVolume === undefined && bVolume !== undefined) return 1;
  return (
    a.sourceVolumeIndex - b.sourceVolumeIndex ||
    a.sourceChapterIndex - b.sourceChapterIndex ||
    a.kavitaChapterId - b.kavitaChapterId
  );
}

export function normalizePhysicalBookTitle(input: {
  seriesTitle?: string;
  bookTitle?: string;
  volume?: number;
}): string | undefined {
  const title = input.bookTitle?.trim();
  if (!title) return undefined;
  const series = input.seriesTitle?.trim();
  if (!series) return title;

  const compactTitle = normalizeComparableTitle(title);
  const compactSeries = normalizeComparableTitle(series);
  const volume = input.volume === undefined ? undefined : formatVolumeForPattern(input.volume);
  if (volume !== undefined) {
    const redundantPatterns = [
      `${compactSeries}volume${volume}`,
      `${compactSeries}vol${volume}`,
      `${compactSeries}v${volume}`,
      `${compactSeries}book${volume}`,
      `${compactSeries}part${volume}`,
    ];
    if (redundantPatterns.includes(compactTitle)) return undefined;
  }
  return title;
}

function resolvedVolumeCandidate(
  source: ResolvedNovelVolume["source"],
  value: unknown,
  confidence: number,
  mode: "marker" | "standalone",
): ResolvedNovelVolume {
  const parsed =
    mode === "standalone" ? validStandaloneVolume(value) : parseVolumeNumber(stringValue(value));
  if (parsed === undefined) {
    return { value: undefined, source: "unknown", confidence: 0, isDecimal: false };
  }
  return { value: parsed.value, source, confidence, isDecimal: parsed.isDecimal };
}

function bookTitleVolumeCandidate(
  title: string | undefined,
  rawKavitaVolume: { value: number; isDecimal: boolean } | undefined,
): ResolvedNovelVolume {
  const explicit = resolvedVolumeCandidate("book-title", title, 100, "marker");
  if (explicit.value !== undefined) return explicit;
  const refined = trailingDecimalRefinement(title, rawKavitaVolume);
  if (refined !== undefined) {
    return { value: refined, source: "book-title", confidence: 100, isDecimal: true };
  }
  return { value: undefined, source: "unknown", confidence: 0, isDecimal: false };
}

function trailingDecimalRefinement(
  title: string | undefined,
  rawKavitaVolume: { value: number; isDecimal: boolean } | undefined,
): number | undefined {
  if (title === undefined || rawKavitaVolume === undefined || rawKavitaVolume.isDecimal) {
    return undefined;
  }
  const decimalText = /\b(\d+\.\d+)\s*$/u.exec(title.trim())?.[1];
  if (decimalText === undefined) return undefined;
  const decimal = Number(decimalText);
  if (!Number.isFinite(decimal) || Math.trunc(decimal) !== rawKavitaVolume.value) {
    return undefined;
  }
  return decimal;
}

function validStandaloneVolume(value: unknown): { value: number; isDecimal: boolean } | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return undefined;
  return parseVolumeNumber(text);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeComparableTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function formatVolumeForPattern(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
