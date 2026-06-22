export type LargeEpubHandling = "auto-split" | "single-entry";

export const DEFAULT_LARGE_EPUB_HANDLING: LargeEpubHandling = "auto-split";

export const DEFAULT_TARGET_SOURCE_PAGES_PER_PART = 96;
export const MIN_TARGET_SOURCE_PAGES_PER_PART = 32;
export const MAX_TARGET_SOURCE_PAGES_PER_PART = 256;

export const LARGE_EPUB_HANDLING_OPTIONS: { id: LargeEpubHandling; title: string }[] = [
  { id: "auto-split", title: "Auto split oversized books" },
  { id: "single-entry", title: "Single entry (legacy)" },
];

export function normalizeLargeEpubHandling(value: unknown): LargeEpubHandling {
  return LARGE_EPUB_HANDLING_OPTIONS.some((option) => option.id === value)
    ? (value as LargeEpubHandling)
    : DEFAULT_LARGE_EPUB_HANDLING;
}

export function normalizeTargetSourcePagesPerPart(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_TARGET_SOURCE_PAGES_PER_PART;
  const stepped = Math.round(parsed / 16) * 16;
  return Math.min(
    MAX_TARGET_SOURCE_PAGES_PER_PART,
    Math.max(MIN_TARGET_SOURCE_PAGES_PER_PART, stepped),
  );
}

export function largeEpubHandlingDiagnosticName(mode: LargeEpubHandling): string {
  return mode;
}
