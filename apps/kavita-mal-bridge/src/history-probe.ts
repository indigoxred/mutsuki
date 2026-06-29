export type HistoryProbeStatus =
  | "sample-collected"
  | "no-extension-accessible-history-api-found"
  | "error";

export type HistoryProbeReliability = "reliable" | "weak" | "unusable";

export interface HistoryProbeFinding {
  code: string;
  message: string;
}

export interface HistoryProbeEvent {
  source?: string;
  readingSourceId?: string;
  sourceMangaId?: string;
  sourceMangaTitle?: string;
  sourceChapterId?: string;
  sourceChapterTitle?: string;
  sourceChapterNumber?: number;
  sourceChapterVolume?: number;
  completed?: boolean;
  pagesRead?: number;
  totalPages?: number;
  completionPercent?: number;
  readAt?: string;
  updatedAt?: string;
  reliability: HistoryProbeReliability;
  rawRecordJson?: string;
}

export interface HistoryProbeSubmission {
  schemaVersion: 1;
  probeRunId: string;
  source: string;
  status: HistoryProbeStatus;
  createdAt: string;
  inspectedApis: string[];
  findings: HistoryProbeFinding[];
  events: HistoryProbeEvent[];
}

export interface HistoryProbeRunRecord {
  probeRunId: string;
  schemaVersion: 1;
  source: string;
  status: HistoryProbeStatus;
  createdAt: string;
  receivedAt: string;
  inspectedApis: string[];
  rawSubmissionJson: string;
}

export interface StoredHistoryProbeEvent extends HistoryProbeEvent {
  id: number;
  probeRunId: string;
  createdAt: string;
}

export interface StoredHistoryProbeFinding extends HistoryProbeFinding {
  id: number;
  probeRunId: string;
  createdAt: string;
}

export interface HistoryProbeStatusSummary {
  lastRun?: HistoryProbeRunRecord;
  recordCount: number;
  reliability: Record<HistoryProbeReliability, number>;
  findings: StoredHistoryProbeFinding[];
}

export function parseHistoryProbeSubmission(input: unknown): HistoryProbeSubmission {
  if (!isRecord(input)) throw new Error("History probe submission must be an object.");
  const probeRunId = requiredShortString(input.probeRunId, "probeRunId");
  const source = requiredShortString(input.source, "source");
  const status = historyProbeStatus(input.status);
  const createdAt = optionalShortString(input.createdAt) ?? new Date().toISOString();
  const inspectedApis = stringArray(input.inspectedApis).slice(0, 100);
  const findings = Array.isArray(input.findings)
    ? input.findings.slice(0, 100).flatMap((finding) => {
        if (!isRecord(finding)) return [];
        const code = optionalShortString(finding.code);
        const message = optionalShortString(finding.message);
        return code && message ? [{ code, message }] : [];
      })
    : [];
  const events = Array.isArray(input.events)
    ? input.events.slice(0, 50).flatMap(parseHistoryProbeEvent)
    : [];

  return {
    schemaVersion: 1,
    probeRunId,
    source,
    status,
    createdAt,
    inspectedApis,
    findings,
    events,
  };
}

export function sanitizedHistoryProbeRawJson(submission: HistoryProbeSubmission): string {
  return JSON.stringify(redactSecretsDeep(submission)).slice(0, 20_000);
}

export function redactHistoryProbeString(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*)Bearer\s+[^&\s"')<>]+/giu, "$1Bearer redacted")
    .replace(/Bearer\s+[^&\s"')<>]+/giu, "Bearer redacted")
    .replace(/(x-api-key\s*[:=]\s*)[^&\s"')<>]+/giu, "$1redacted")
    .replace(
      /([?&](?:apiKey|apikey|token|access_token|refresh_token|auth|key|signature|sig)=)[^&\s"')<>]+/giu,
      "$1redacted",
    )
    .replace(/(Cookie\s*[:=]\s*)[^\n\r]+/giu, "$1redacted")
    .replace(/"?cookie"?\s*:\s*"[^"]*"/giu, '"redacted-header":"redacted"')
    .replace(/(session(?:id)?\s*[:=]\s*)[^&\s"')<>]+/giu, "$1redacted")
    .replace(/(password\s*[:=]\s*)[^&\s"')<>]+/giu, "$1redacted")
    .replace(/https?:\/\/[^\s"')<>]+(?:image|img|cover|page)[^\s"')<>]*/giu, "redacted-image-url")
    .slice(0, 4000);
}

function parseHistoryProbeEvent(value: unknown): HistoryProbeEvent[] {
  if (!isRecord(value)) return [];
  const reliability = historyProbeReliability(value.reliability);
  const event: HistoryProbeEvent = {
    source: optionalShortString(value.source),
    readingSourceId: optionalShortString(value.readingSourceId),
    sourceMangaId: optionalShortString(value.sourceMangaId),
    sourceMangaTitle: optionalShortString(value.sourceMangaTitle),
    sourceChapterId: optionalShortString(value.sourceChapterId),
    sourceChapterTitle: optionalShortString(value.sourceChapterTitle),
    sourceChapterNumber: optionalFiniteNumber(value.sourceChapterNumber),
    sourceChapterVolume: optionalFiniteNumber(value.sourceChapterVolume),
    completed: typeof value.completed === "boolean" ? value.completed : undefined,
    pagesRead: optionalFiniteNumber(value.pagesRead),
    totalPages: optionalFiniteNumber(value.totalPages),
    completionPercent: optionalFiniteNumber(value.completionPercent),
    readAt: optionalShortString(value.readAt),
    updatedAt: optionalShortString(value.updatedAt),
    reliability,
    rawRecordJson: optionalShortString(value.rawRecordJson),
  };
  if (event.rawRecordJson) event.rawRecordJson = redactHistoryProbeString(event.rawRecordJson);
  return [event];
}

function historyProbeStatus(value: unknown): HistoryProbeStatus {
  return value === "sample-collected" ||
    value === "no-extension-accessible-history-api-found" ||
    value === "error"
    ? value
    : "error";
}

function historyProbeReliability(value: unknown): HistoryProbeReliability {
  return value === "reliable" || value === "weak" || value === "unusable" ? value : "unusable";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const sanitized = optionalShortString(item);
    return sanitized ? [sanitized] : [];
  });
}

function requiredShortString(value: unknown, field: string): string {
  const sanitized = optionalShortString(value);
  if (!sanitized) throw new Error(`Missing ${field}.`);
  return sanitized;
}

function optionalShortString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactHistoryProbeString(value.trim()).slice(0, 1000);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === "string") return redactHistoryProbeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactSecretsDeep(item, depth + 1));
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (/token|api.?key|authorization|auth|secret|cookie|session|password/iu.test(key)) {
      output[safeKey(key)] = "redacted";
    } else {
      output[safeKey(key)] = redactSecretsDeep(item, depth + 1);
    }
  }
  return output;
}

function safeKey(value: string): string {
  return value.replace(/[^\w.-]+/gu, "_").slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
