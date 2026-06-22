export type NovelListingMode = "physical-books" | "internal-chapters";

export const DEFAULT_NOVEL_LISTING_MODE: NovelListingMode = "physical-books";

export const NOVEL_LISTING_MODE_OPTIONS: { id: NovelListingMode; title: string }[] = [
  { id: "physical-books", title: "Physical books" },
  { id: "internal-chapters", title: "Internal EPUB chapters" },
];

export function normalizeNovelListingMode(value: unknown): NovelListingMode {
  return NOVEL_LISTING_MODE_OPTIONS.some((option) => option.id === value)
    ? (value as NovelListingMode)
    : DEFAULT_NOVEL_LISTING_MODE;
}

export function novelListingModeDiagnosticName(mode: NovelListingMode): string {
  return mode;
}
