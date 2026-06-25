import {
  ButtonRow,
  ContentRating,
  Form,
  InputRow,
  LabelRow,
  Section,
  ToggleRow,
  type ChapterReadActionQueueProcessingResult,
  type Extension,
  type FormSectionElement,
  type MangaProgress,
  type MangaProgressProviding,
  type Metadata,
  type PagedResults,
  type SearchQuery,
  type SearchResultItem,
  type SearchResultsProviding,
  type SettingsFormProviding,
  type SortingOption,
  type SourceManga,
  type TrackedMangaChapterReadAction,
} from "@paperback/types";

import {
  sendProgressBridgeEvent,
  type ProgressBridgeTransport,
} from "../shared/progress-bridge.js";

type ProgressBridgeImplementation = Extension &
  SearchResultsProviding &
  SettingsFormProviding &
  MangaProgressProviding;

export interface ProgressBridgeEvent {
  version: 1;
  source: "paperback-progress-provider";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  chapterSourceId: string;
  chapterMangaId: string;
  chapterKind: "manga" | "book";
  chapterNum: number;
  chapterVolume?: number;
  isLastInVolume: boolean;
  shouldMarkKavitaRead: false;
  kavitaMarkedRead: false;
  title: string;
  listingMode: "tracker-bridge";
  role: "read-action" | "diagnostic";
  trackedTitle: string;
  sourceTitle: string;
}

export interface ProgressBridgeSettings {
  progressBridgeUrl: string;
  progressBridgeToken: string;
  debugLogging: boolean;
}

export const DEFAULT_PROGRESS_BRIDGE_SETTINGS: ProgressBridgeSettings = {
  progressBridgeUrl: "",
  progressBridgeToken: "",
  debugLogging: false,
};

export class MutsukiProgressBridgeExtension implements ProgressBridgeImplementation {
  async initialise(): Promise<void> {
    console.log(
      "[MutsukiBridgeRuntime]",
      "build=0.1.0",
      "progressManagementForm=true",
      "progressGetter=true",
      "progressQueue=true",
    );
  }

  async getSettingsForm(): Promise<Form> {
    return new ProgressBridgeSettingsForm();
  }

  async getMangaProgressManagementForm(sourceManga: SourceManga): Promise<Form> {
    return new ProgressBridgeTrackingForm(sourceManga);
  }

  async getMangaProgress(sourceManga: SourceManga): Promise<MangaProgress | undefined> {
    return {
      sourceManga,
      lastReadChapter: {
        chapterId: `${sourceManga.mangaId}:progress-start`,
        sourceManga,
        langCode: "unknown",
        chapNum: 0,
      },
    };
  }

  async processChapterReadActionQueue(
    actions: TrackedMangaChapterReadAction[],
  ): Promise<ChapterReadActionQueueProcessingResult> {
    console.log(
      "[MutsukiBridgeQueue] ENTER",
      `actionCount=${actions.length}`,
      `actionIds=${actions.map((action) => action.id).join(",")}`,
    );
    let settings: ProgressBridgeSettings;
    try {
      settings = getProgressBridgeSettings();
    } catch {
      return { successfulItems: [], failedItems: actions.map((action) => action.id) };
    }
    if (!settings.progressBridgeUrl) {
      return { successfulItems: [], failedItems: actions.map((action) => action.id) };
    }
    return processProgressBridgeReadActionQueue({
      actions,
      sendBridgeEvent: (event) =>
        sendProgressBridgeEvent({
          bridgeUrl: settings.progressBridgeUrl,
          token: settings.progressBridgeToken || undefined,
          event,
          transport: paperbackProgressBridgeTransport,
        }),
    });
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    _metadata: Metadata | undefined,
    _sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const title = query.title.trim();
    if (!title) return { items: [] };
    return {
      items: [
        {
          mangaId: trackingIdForTitle(title),
          title,
          subtitle: "Forward read actions to Mutsuki Progress Bridge",
          imageUrl: "",
          contentRating: ContentRating.EVERYONE,
        },
      ],
    };
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    return sourceMangaForTrackingTarget(mangaId);
  }
}

export async function processProgressBridgeReadActionQueue(input: {
  actions: TrackedMangaChapterReadAction[];
  sendBridgeEvent: (event: ProgressBridgeEvent) => Promise<void>;
  now?: () => Date;
}): Promise<ChapterReadActionQueueProcessingResult> {
  const successfulItems: string[] = [];
  const failedItems: string[] = [];

  for (const action of input.actions) {
    try {
      await input.sendBridgeEvent(
        progressBridgeEventFromAction(action, input.now?.() ?? new Date()),
      );
      successfulItems.push(action.id);
    } catch {
      failedItems.push(action.id);
    }
  }

  return { successfulItems, failedItems };
}

export function getProgressBridgeSettings(): ProgressBridgeSettings {
  const settings = {
    ...DEFAULT_PROGRESS_BRIDGE_SETTINGS,
    ...(Application.getState("progressBridgeSettings") as
      | Partial<ProgressBridgeSettings>
      | undefined),
    progressBridgeToken:
      (Application.getSecureState("progressBridgeToken") as string | undefined) ?? "",
  };
  return {
    progressBridgeUrl: settings.progressBridgeUrl.trim(),
    progressBridgeToken: settings.progressBridgeToken,
    debugLogging: Boolean(settings.debugLogging),
  };
}

export function setProgressBridgeSettings(settings: ProgressBridgeSettings): void {
  const { progressBridgeToken: _progressBridgeToken, ...nonSecret } = settings;
  Application.setState(nonSecret, "progressBridgeSettings");
  Application.setSecureState(settings.progressBridgeToken, "progressBridgeToken");
}

class ProgressBridgeSettingsForm extends Form {
  private settings = getProgressBridgeSettings();
  private status = "";

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section({ id: "bridge", header: "Progress Bridge" }, [
        LabelRow("purpose", {
          title: "Queue receiver",
          subtitle:
            "This tracker forwards Paperback read-action queue events to the mock bridge. It only receives events for titles associated with this tracker.",
        }),
        InputRow("progress-bridge-url", {
          title: "Progress bridge URL",
          value: this.settings.progressBridgeUrl,
          onValueChange: Application.Selector(
            this as ProgressBridgeSettingsForm,
            "handleProgressBridgeUrlChange",
          ),
        }),
        InputRow("progress-bridge-token", {
          title: "Progress bridge token",
          value: this.settings.progressBridgeToken,
          isSecureEntry: true,
          onValueChange: Application.Selector(
            this as ProgressBridgeSettingsForm,
            "handleProgressBridgeTokenChange",
          ),
        }),
        ToggleRow("debug", {
          title: "Debug Logging",
          value: this.settings.debugLogging,
          onValueChange: Application.Selector(
            this as ProgressBridgeSettingsForm,
            "handleDebugLoggingChange",
          ),
        }),
        ButtonRow("send-mock-bridge-test-event", {
          title: "Send mock bridge test event",
          onSelect: Application.Selector(
            this as ProgressBridgeSettingsForm,
            "handleSendMockBridgeTestEvent",
          ),
        }),
        this.status
          ? LabelRow("status", { title: "Mock bridge test", subtitle: this.status })
          : undefined,
      ]),
    ];
  }

  async handleProgressBridgeUrlChange(value: string): Promise<void> {
    this.update({ progressBridgeUrl: value.trim() });
  }

  async handleProgressBridgeTokenChange(value: string): Promise<void> {
    this.update({ progressBridgeToken: value });
  }

  async handleDebugLoggingChange(value: boolean): Promise<void> {
    this.update({ debugLogging: value });
  }

  async handleSendMockBridgeTestEvent(): Promise<void> {
    try {
      await sendProgressBridgeEvent({
        bridgeUrl: this.settings.progressBridgeUrl,
        token: this.settings.progressBridgeToken || undefined,
        event: diagnosticProgressBridgeEvent(new Date().toISOString()),
        transport: paperbackProgressBridgeTransport,
      });
      this.status = "Diagnostic event sent.";
    } catch (error) {
      this.status = error instanceof Error ? error.message : "Diagnostic event failed.";
    }
    this.reloadForm();
  }

  private update(settings: Partial<ProgressBridgeSettings>): void {
    this.settings = { ...this.settings, ...settings };
    setProgressBridgeSettings(this.settings);
  }
}

class ProgressBridgeTrackingForm extends Form {
  constructor(private readonly sourceManga: SourceManga) {
    super();
  }

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section({ id: "tracking", header: "Progress Bridge" }, [
        LabelRow("target", {
          title: "Tracking target",
          subtitle: this.sourceManga.mangaInfo.primaryTitle,
        }),
        LabelRow("note", {
          title: "Bridge forwarding",
          subtitle:
            "Paperback will queue completed chapter actions here only when this tracker is associated with the title.",
        }),
      ]),
    ];
  }
}

function progressBridgeEventFromAction(
  action: TrackedMangaChapterReadAction,
  receivedAt: Date,
): ProgressBridgeEvent {
  const additionalInfo = action.readChapter?.additionalInfo ?? {};
  const isLastInVolume = additionalInfo.isLastInVolume === "true";
  return {
    version: 1,
    source: "paperback-progress-provider",
    actionId: action.id,
    occurredAt: dateToIso(action.creationDate),
    receivedAt: receivedAt.toISOString(),
    mangaId: action.sourceManga.mangaId,
    paperbackChapterId: action.chapterId,
    chapterSourceId: action.chapterSourceId,
    chapterMangaId: action.chapterMangaId,
    chapterKind: action.chapterId.startsWith("kavita-book:") ? "book" : "manga",
    chapterNum: action.chapterNum,
    chapterVolume: action.chapterVolume,
    isLastInVolume,
    shouldMarkKavitaRead: false,
    kavitaMarkedRead: false,
    title: action.readChapter?.title ?? "",
    listingMode: "tracker-bridge",
    role: "read-action",
    trackedTitle: action.sourceManga.mangaInfo.primaryTitle,
    sourceTitle: action.readChapter?.sourceManga.mangaInfo.primaryTitle ?? "",
  };
}

function diagnosticProgressBridgeEvent(now: string): ProgressBridgeEvent {
  return {
    version: 1,
    source: "paperback-progress-provider",
    actionId: "diagnostic-progress-bridge-settings-test",
    occurredAt: now,
    receivedAt: now,
    mangaId: "bridge-track:diagnostic",
    paperbackChapterId: "diagnostic:progress-bridge-test",
    chapterSourceId: "ProgressBridge",
    chapterMangaId: "diagnostic",
    chapterKind: "manga",
    chapterNum: 0,
    isLastInVolume: false,
    shouldMarkKavitaRead: false,
    kavitaMarkedRead: false,
    title: "Mutsuki Progress Bridge diagnostic event",
    listingMode: "tracker-bridge",
    role: "diagnostic",
    trackedTitle: "Diagnostic",
    sourceTitle: "Diagnostic",
  };
}

function trackingIdForTitle(title: string): string {
  return `bridge-track:${slugify(title)}`;
}

function sourceMangaForTrackingTarget(mangaId: string): SourceManga {
  return {
    mangaId,
    mangaInfo: {
      primaryTitle: titleFromTrackingId(mangaId),
      secondaryTitles: [],
      thumbnailUrl: "",
      synopsis:
        "Synthetic Mutsuki Progress Bridge tracking target. It forwards queued read actions to the configured bridge.",
      contentRating: ContentRating.EVERYONE,
    },
  };
}

function titleFromTrackingId(mangaId: string): string {
  const slug = mangaId.replace(/^bridge-track:/u, "");
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "untitled";
}

function dateToIso(value: Date): string {
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
}

const paperbackProgressBridgeTransport: ProgressBridgeTransport = async (request) => {
  const [response] = await Application.scheduleRequest(request);
  return { status: response.status };
};

export const ProgressBridge = new MutsukiProgressBridgeExtension();
