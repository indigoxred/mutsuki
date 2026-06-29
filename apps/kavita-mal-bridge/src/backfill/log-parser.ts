import type { HistoryProbeEvent, HistoryProbeReliability } from "../history-probe.js";
import { redactHistoryProbeString } from "../history-probe.js";

export interface PaperbackLogParserOptions {
  completionThresholdPercent?: number;
}

export interface PaperbackLogParseResult {
  records: HistoryProbeEvent[];
  ignored: {
    prefetch: number;
    partialProgress: number;
    duplicates: number;
    unusable: number;
  };
}

interface PendingCompleteLine {
  title: string;
  chapterTitle: string;
  chapterNumber?: number;
  chapterVolume?: number;
  timestamp?: string;
}

export function parsePaperbackDebugLog(
  logText: string,
  options: PaperbackLogParserOptions = {},
): PaperbackLogParseResult {
  const threshold = options.completionThresholdPercent ?? 80;
  const records: HistoryProbeEvent[] = [];
  const ignored = { prefetch: 0, partialProgress: 0, duplicates: 0, unusable: 0 };
  const pendingCompleteLines: PendingCompleteLine[] = [];
  const seen = new Set<string>();

  for (const rawLine of logText.split(/\r?\n/u)) {
    const line = redactHistoryProbeString(rawLine);
    if (!line.trim()) continue;
    if (/\[PREFETCHER\]/u.test(line)) {
      ignored.prefetch++;
      continue;
    }
    const marked = parseMarkedCompleteLine(line);
    if (marked) {
      pendingCompleteLines.push(marked);
      continue;
    }
    const progress = parseProgressLine(line);
    if (!progress) continue;
    if (!progress.completed || progress.completionPercent < threshold) {
      ignored.partialProgress++;
      continue;
    }
    const dedupeKey = `${progress.sourceChapterId}:${progress.pagesRead}:${progress.totalPages}`;
    if (seen.has(dedupeKey)) {
      ignored.duplicates++;
      continue;
    }
    const completeLine = pendingCompleteLines.pop();
    if (!completeLine) {
      ignored.unusable++;
      continue;
    }
    seen.add(dedupeKey);
    records.push({
      source: "Paperback debug log",
      readingSourceId: undefined,
      sourceMangaId: undefined,
      sourceMangaTitle: completeLine.title,
      sourceChapterId: progress.sourceChapterId,
      sourceChapterTitle: completeLine.chapterTitle,
      sourceChapterNumber: completeLine.chapterNumber,
      sourceChapterVolume: completeLine.chapterVolume,
      completed: true,
      pagesRead: progress.pagesRead,
      totalPages: progress.totalPages,
      completionPercent: progress.completionPercent,
      readAt: completeLine.timestamp ?? progress.timestamp,
      reliability: reliabilityForLogRecord(undefined, undefined, progress.sourceChapterId),
      rawRecordJson: JSON.stringify({ marked: completeLine, progress }),
    });
  }

  return { records, ignored };
}

function parseMarkedCompleteLine(line: string): PendingCompleteLine | undefined {
  const match =
    /^(?:(?<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+)?Marked\s+(?<title>.+?)\s+-\s+(?<chapter>.+?)\s+as\s+COMPLETE\b/u.exec(
      line,
    );
  const groups = match?.groups;
  if (!groups?.title || !groups.chapter) return undefined;
  const volume = /Vol\.\s*(?<volume>\d+(?:\.\d+)?)/u.exec(groups.chapter)?.groups?.volume;
  const chapter = /Ch\.\s*(?<chapter>\d+(?:\.\d+)?)/u.exec(groups.chapter)?.groups?.chapter;
  return {
    title: groups.title.trim(),
    chapterTitle: groups.chapter.trim(),
    chapterNumber: chapter ? Number(chapter) : undefined,
    chapterVolume: volume ? Number(volume) : undefined,
    timestamp: groups.timestamp,
  };
}

function parseProgressLine(line: string):
  | {
      sourceChapterId: string;
      pagesRead: number;
      totalPages: number;
      completionPercent: number;
      completed: boolean;
      timestamp?: string;
    }
  | undefined {
  const match =
    /^(?:(?<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+)?Updated chapter progress for (?<chapterId>.+?) to (?<read>\d+)\/(?<total>\d+)\b/u.exec(
      line,
    );
  const groups = match?.groups;
  if (!groups?.chapterId || !groups.read || !groups.total) return undefined;
  const pagesRead = Number(groups.read);
  const totalPages = Number(groups.total);
  const completionPercent = totalPages > 0 ? (pagesRead / totalPages) * 100 : 0;
  return {
    sourceChapterId: groups.chapterId.trim(),
    pagesRead,
    totalPages,
    completionPercent,
    completed: totalPages > 0 && pagesRead >= totalPages,
    timestamp: groups.timestamp,
  };
}

function reliabilityForLogRecord(
  readingSourceId: string | undefined,
  sourceMangaId: string | undefined,
  sourceChapterId: string | undefined,
): HistoryProbeReliability {
  return readingSourceId && sourceMangaId && sourceChapterId ? "reliable" : "weak";
}
