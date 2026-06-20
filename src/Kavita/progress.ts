import { parseFinalInVolumeFromChapterId } from "./toc.js";
import type { KavitaClient } from "./client.js";

export async function markKavitaCompletedIfSafe(input: {
  client: KavitaClient;
  seriesId: number;
  chapterId: number;
  paperbackChapterId: string;
}): Promise<boolean> {
  if (
    input.paperbackChapterId.startsWith("kavita-book:") &&
    !parseFinalInVolumeFromChapterId(input.paperbackChapterId)
  ) {
    return false;
  }
  await input.client.markChapterRead({ seriesId: input.seriesId, chapterId: input.chapterId });
  return true;
}
