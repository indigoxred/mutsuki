export type NovelRenderingMode = "static-probe" | "plain-text" | "full-epub";

export const DEFAULT_NOVEL_RENDERING_MODE: NovelRenderingMode = "full-epub";

export const NOVEL_RENDERING_MODE_OPTIONS: { id: NovelRenderingMode; title: string }[] = [
  { id: "static-probe", title: "Static probe" },
  { id: "plain-text", title: "Plain text" },
  { id: "full-epub", title: "Full EPUB" },
];

export function normalizeNovelRenderingMode(value: unknown): NovelRenderingMode {
  return NOVEL_RENDERING_MODE_OPTIONS.some((option) => option.id === value)
    ? (value as NovelRenderingMode)
    : DEFAULT_NOVEL_RENDERING_MODE;
}

export function novelRenderingModeDiagnosticName(mode: NovelRenderingMode): string {
  if (mode === "static-probe") return "static";
  if (mode === "plain-text") return "plain-text";
  return "full";
}
