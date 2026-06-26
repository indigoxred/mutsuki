export type MatchMethod = "mal-url" | "mal-id" | "external-id" | "title-search" | "manual";

export interface KavitaSeriesCandidate {
  kavitaSeriesId: number;
  libraryId?: number;
  title: string;
  altTitles?: string[];
  authors?: string[];
  publicationYear?: number;
  volumeCount?: number;
  mediaType?: "manga" | "light_novel" | "novel" | "unknown";
  webLinks?: string[];
  externalIds?: Record<string, string | number | undefined>;
}

export interface MalSearchCandidate {
  malId: number;
  title: string;
  altTitles?: string[];
  authors?: string[];
  mediaType?: string;
  startYear?: number;
  volumes?: number;
  chapters?: number;
}

export type MatchDecision =
  | {
      status: "matched";
      malId: number;
      matchMethod: MatchMethod;
      confidence: number;
      candidate?: MalSearchCandidate;
    }
  | {
      status: "review";
      reason: "no-candidates" | "ambiguous-or-low-confidence";
      confidence: number;
      candidates: ScoredMalCandidate[];
    };

export interface ScoredMalCandidate extends MalSearchCandidate {
  confidence: number;
  reasons: string[];
}

const AUTO_MATCH_THRESHOLD = 0.92;
const AUTO_MATCH_MARGIN = 0.12;

export function matchKavitaSeriesToMal(input: {
  series: KavitaSeriesCandidate;
  searchCandidates: MalSearchCandidate[];
}): MatchDecision {
  const deterministic = deterministicMalId(input.series);
  if (deterministic) {
    return {
      status: "matched",
      malId: deterministic.malId,
      matchMethod: deterministic.method,
      confidence: 1,
    };
  }

  const scored = input.searchCandidates
    .map((candidate) => scoreCandidate(input.series, candidate))
    .sort((a, b) => b.confidence - a.confidence);
  const top = scored[0];
  if (!top) {
    return { status: "review", reason: "no-candidates", confidence: 0, candidates: [] };
  }
  const runnerUp = scored[1]?.confidence ?? 0;
  if (top.confidence >= AUTO_MATCH_THRESHOLD && top.confidence - runnerUp >= AUTO_MATCH_MARGIN) {
    return {
      status: "matched",
      malId: top.malId,
      matchMethod: "title-search",
      confidence: top.confidence,
      candidate: top,
    };
  }
  return {
    status: "review",
    reason: "ambiguous-or-low-confidence",
    confidence: top.confidence,
    candidates: scored.slice(0, 5),
  };
}

export function normalizeTitleForMatching(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function deterministicMalId(
  series: KavitaSeriesCandidate,
): { malId: number; method: MatchMethod } | undefined {
  const direct = numberFromUnknown(series.externalIds?.mal ?? series.externalIds?.myanimelist);
  if (direct !== undefined) return { malId: direct, method: "mal-id" };

  for (const link of series.webLinks ?? []) {
    const match = /myanimelist\.net\/manga\/(\d+)/iu.exec(link);
    if (match?.[1]) return { malId: Number(match[1]), method: "mal-url" };
  }

  return undefined;
}

function scoreCandidate(
  series: KavitaSeriesCandidate,
  candidate: MalSearchCandidate,
): ScoredMalCandidate {
  let confidence = 0;
  const reasons: string[] = [];
  const seriesTitles = [series.title, ...(series.altTitles ?? [])].map(normalizeTitleForMatching);
  const candidateTitles = [candidate.title, ...(candidate.altTitles ?? [])].map(
    normalizeTitleForMatching,
  );

  if (hasExactTitle(seriesTitles, candidateTitles)) {
    confidence += 0.66;
    reasons.push("exact-title");
  } else {
    const tokenScore = bestTokenScore(seriesTitles, candidateTitles);
    confidence += tokenScore * 0.55;
    if (tokenScore >= 0.75) reasons.push("similar-title");
  }

  if (hasSharedAuthor(series.authors, candidate.authors)) {
    confidence += 0.14;
    reasons.push("author");
  }
  if (
    series.publicationYear !== undefined &&
    candidate.startYear !== undefined &&
    Math.abs(series.publicationYear - candidate.startYear) <= 1
  ) {
    confidence += 0.08;
    reasons.push("year");
  }
  if (
    series.volumeCount !== undefined &&
    candidate.volumes !== undefined &&
    series.volumeCount > 0 &&
    candidate.volumes > 0 &&
    Math.abs(series.volumeCount - candidate.volumes) <= 1
  ) {
    confidence += 0.08;
    reasons.push("volume-count");
  }
  if (mediaTypesCompatible(series.mediaType, candidate.mediaType)) {
    confidence += 0.06;
    reasons.push("media-type");
  }

  return {
    ...candidate,
    confidence: Math.min(1, Number(confidence.toFixed(4))),
    reasons,
  };
}

function hasExactTitle(left: string[], right: string[]): boolean {
  return left.some((leftTitle) => right.some((rightTitle) => leftTitle === rightTitle));
}

function bestTokenScore(left: string[], right: string[]): number {
  let best = 0;
  for (const leftTitle of left) {
    for (const rightTitle of right) {
      best = Math.max(best, jaccard(tokens(leftTitle), tokens(rightTitle)));
    }
  }
  return best;
}

function tokens(title: string): Set<string> {
  return new Set(title.split(" ").filter(Boolean));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function hasSharedAuthor(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = new Set((left ?? []).map(normalizeTitleForMatching));
  return (right ?? []).some((author) => normalizedLeft.has(normalizeTitleForMatching(author)));
}

function mediaTypesCompatible(
  kavitaType: KavitaSeriesCandidate["mediaType"],
  malType: string | undefined,
): boolean {
  if (!kavitaType || kavitaType === "unknown" || !malType) return false;
  if (kavitaType === "novel") return malType === "light_novel" || malType === "novel";
  if (kavitaType === "light_novel") return malType === "light_novel";
  return malType === "manga" || malType === "manhwa" || malType === "manhua";
}

function numberFromUnknown(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
