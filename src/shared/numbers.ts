export interface ReadingNumber {
  value: number;
  isDecimal: boolean;
}

const SPECIAL_TITLE_PATTERN =
  /\b(prologue|epilogue|afterword|side\s*story|bonus|special|extra|interlude)\b/iu;

export function parsePositiveInteger(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  const text = String(input).trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseReadingNumber(input: string | number | undefined): ReadingNumber | undefined {
  if (input === undefined) return undefined;
  const text = String(input).trim();
  const match = /(?:chapter|volume|vol\.?|ch\.?)?\s*(\d+(?:\.\d+)?)/iu.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return { value, isDecimal: !Number.isInteger(value) };
}

export function classifySpecialTitle(title: string | undefined): boolean {
  if (!title) return false;
  return SPECIAL_TITLE_PATTERN.test(title);
}

export function applyIntegerOffset(value: number | undefined, offset: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const adjusted = value + offset;
  return Number.isInteger(adjusted) && adjusted > 0 ? adjusted : undefined;
}
