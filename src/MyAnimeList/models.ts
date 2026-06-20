export type TrackingMode = "chapter-and-volume" | "chapter-only" | "volume-only" | "disabled";

export interface TrackingPolicy {
  mode: TrackingMode;
  chapterOffset: number;
  volumeOffset: number;
  ignoreSpecials: boolean;
  decimalChapterPolicy: "ignore" | "floor" | "allow";
  markCompletedAutomatically: boolean;
  preserveExistingStatus: boolean;
}

export interface MalReadAction {
  id?: string;
  malMangaId: string;
  chapterNumber?: number;
  volumeNumber?: number;
  isLastInVolume: boolean;
  isSpecial: boolean;
}

export type MalStatus = "reading" | "completed" | "on_hold" | "dropped" | "plan_to_read";

export interface MalCurrentProgress {
  chaptersRead: number;
  volumesRead: number;
  status: MalStatus;
  totalChapters: number;
  totalVolumes: number;
}

export interface MalProgressUpdate {
  num_chapters_read?: number;
  num_volumes_read?: number;
  status?: "reading" | "completed";
}
