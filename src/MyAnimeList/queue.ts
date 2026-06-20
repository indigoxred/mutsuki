import { planMalUpdate } from "./policy.js";
import type {
  MalCurrentProgress,
  MalProgressUpdate,
  MalReadAction,
  TrackingPolicy,
} from "./models.js";

export interface ProcessMalQueueInput {
  actions: QueueAction[];
  getPolicy: (malMangaId: string) => TrackingPolicy;
  getCurrentProgress: (malMangaId: string) => Promise<MalCurrentProgress>;
  updateProgress: (
    malMangaId: string,
    update: MalProgressUpdate,
  ) => Promise<{ ok: true } | { ok: false; retryable: boolean }>;
}

export interface QueueProcessingResult {
  successfulItems: string[];
  failedItems: string[];
}

type QueueAction = MalReadAction & { id: string };

export async function processMalQueue(input: ProcessMalQueueInput): Promise<QueueProcessingResult> {
  const result: QueueProcessingResult = { successfulItems: [], failedItems: [] };
  const grouped = groupActions(input.actions as QueueAction[]);

  for (const actions of grouped.values()) {
    const winner = selectHighestAction(actions);
    for (const action of actions) {
      if (action.id !== winner.id) {
        result.successfulItems.push(action.id);
      }
    }

    const policy = input.getPolicy(winner.malMangaId);
    const current = await input.getCurrentProgress(winner.malMangaId);
    const update = planMalUpdate({ action: winner, current, policy });
    if (!update) {
      result.successfulItems.push(winner.id);
      continue;
    }

    const updateResult = await input.updateProgress(winner.malMangaId, update);
    if (updateResult.ok || !updateResult.retryable) {
      result.successfulItems.push(winner.id);
    } else {
      result.failedItems.push(winner.id);
    }
  }

  return result;
}

function groupActions(actions: QueueAction[]): Map<string, QueueAction[]> {
  const grouped = new Map<string, QueueAction[]>();
  for (const action of actions) {
    const existing = grouped.get(action.malMangaId) ?? [];
    existing.push(action);
    grouped.set(action.malMangaId, existing);
  }
  return grouped;
}

function selectHighestAction(actions: QueueAction[]): QueueAction {
  return [...actions].sort((a, b) => {
    const chapterDiff = (b.chapterNumber ?? 0) - (a.chapterNumber ?? 0);
    if (chapterDiff !== 0) return chapterDiff;
    return (b.volumeNumber ?? 0) - (a.volumeNumber ?? 0);
  })[0]!;
}
