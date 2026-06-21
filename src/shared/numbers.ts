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
  const standalone = /^\d+(?:\.\d+)?$/u.exec(text)?.[0];
  const numericMatch =
    standalone ?? /\b(?:chapter|volume|vol\.?|ch\.?|part)\s*(\d+(?:\.\d+)?)/iu.exec(text)?.[1];
  if (numericMatch !== undefined) return readingNumberFromNumericText(numericMatch);

  const prefixedText = /\b(?:chapter|volume|vol\.?|ch\.?|part)\s+([a-z]+(?:[-\s]+[a-z]+)?)/iu.exec(
    text,
  )?.[1];
  if (!prefixedText) return undefined;

  for (const candidate of numberTextCandidates(prefixedText)) {
    const roman = romanNumeralValue(candidate);
    if (roman !== undefined) return { value: roman, isDecimal: false };

    const word = numberWordValue(candidate);
    if (word !== undefined) return { value: word, isDecimal: false };
  }

  return undefined;
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

function readingNumberFromNumericText(text: string): ReadingNumber | undefined {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return { value, isDecimal: !Number.isInteger(value) };
}

function romanNumeralValue(input: string): number | undefined {
  const text = input.trim().toUpperCase();
  if (!/^(?=[IVXLCDM]+$)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/u.test(text)) {
    return undefined;
  }

  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    const current = values[text[index] ?? ""] ?? 0;
    const next = values[text[index + 1] ?? ""] ?? 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : undefined;
}

function numberTextCandidates(input: string): string[] {
  const trimmed = input.trim();
  const firstWord = trimmed.split(/[-\s]+/u)[0] ?? "";
  return firstWord && firstWord !== trimmed ? [trimmed, firstWord] : [trimmed];
}

function numberWordValue(input: string): number | undefined {
  const words = input
    .toLowerCase()
    .split(/[-\s]+/u)
    .filter(Boolean);
  if (words.length === 0 || words.length > 2) return undefined;

  const units: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  if (words.length === 1) return units[words[0] ?? ""] ?? tens[words[0] ?? ""];
  const ten = tens[words[0] ?? ""];
  const unit = units[words[1] ?? ""];
  if (ten === undefined || unit === undefined || unit >= 10) return undefined;
  return ten + unit;
}
