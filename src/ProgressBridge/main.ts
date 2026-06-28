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

const PROGRESS_BRIDGE_VERSION = "0.1.6";
const PROGRESS_BRIDGE_ICON_URL =
  "https://indigoxred.github.io/mutsuki/ProgressBridge/static/icon.png";

export interface ProgressBridgeEvent {
  version: 1;
  schemaVersion: 3;
  source: "paperback-progress-provider";
  eventSource: "paperback-progress-bridge";
  actionId: string;
  occurredAt: string;
  receivedAt: string;
  mangaId: string;
  paperbackChapterId: string;
  chapterSourceId: string;
  chapterMangaId: string;
  readingSourceId: string;
  readingSourceName: string;
  readingSourceKind: "kavita" | "external" | "unknown";
  sourceMangaId: string;
  sourceChapterId: string;
  sourceChapterNumber: number;
  sourceChapterVolume?: number;
  kavitaSeriesId?: number;
  kavitaChapterId?: number;
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
  sourceTitleForMatching: string;
  sourcePrimaryTitle?: string;
  sourceAltTitles?: string[];
  sourceAuthor?: string;
  sourceArtist?: string;
  sourceShareUrl?: string;
  sourceThumbnailUrl?: string;
  sourceExternalIds: Record<string, string | number>;
  sourceOriginalMetadataJson?: string;
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
      `build=${PROGRESS_BRIDGE_VERSION}`,
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
          imageUrl: PROGRESS_BRIDGE_ICON_URL,
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
            "This tracker forwards Paperback read-action queue events to the Mutsuki bridge. It only receives events for titles associated with this tracker.",
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
        ButtonRow("send-bridge-test-event", {
          title: "Send bridge test event",
          onSelect: Application.Selector(
            this as ProgressBridgeSettingsForm,
            "handleSendBridgeTestEvent",
          ),
        }),
        this.status
          ? LabelRow("status", { title: "Bridge test", subtitle: this.status })
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

  async handleSendBridgeTestEvent(): Promise<void> {
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
  const readingSourceId = safeReadingSourceId(action.chapterSourceId);
  const mangaInfo = action.readChapter?.sourceManga.mangaInfo;
  const sourceTitle = mangaInfo?.primaryTitle ?? "";
  const externalIds = safeExternalIds(mangaInfo?.additionalInfo);
  return {
    version: 1,
    schemaVersion: 3,
    source: "paperback-progress-provider",
    eventSource: "paperback-progress-bridge",
    actionId: action.id,
    occurredAt: dateToIso(action.creationDate),
    receivedAt: receivedAt.toISOString(),
    mangaId: action.sourceManga.mangaId,
    paperbackChapterId: action.chapterId,
    chapterSourceId: action.chapterSourceId,
    chapterMangaId: action.chapterMangaId,
    readingSourceId,
    readingSourceName: friendlySourceName(readingSourceId),
    readingSourceKind: readingSourceKind(readingSourceId, action.chapterId),
    sourceMangaId: action.chapterMangaId,
    sourceChapterId: action.chapterId,
    sourceChapterNumber: action.chapterNum,
    sourceChapterVolume: action.chapterVolume,
    kavitaSeriesId: positiveInteger(additionalInfo.kavitaSeriesId),
    kavitaChapterId: positiveInteger(additionalInfo.kavitaChapterId),
    chapterKind: action.chapterId.startsWith("kavita-book:") ? "book" : "manga",
    chapterNum: action.chapterNum,
    chapterVolume: action.chapterVolume,
    isLastInVolume,
    shouldMarkKavitaRead: false,
    kavitaMarkedRead: false,
    title: titleFromReadAction(action),
    listingMode: "tracker-bridge",
    role: "read-action",
    trackedTitle: action.sourceManga.mangaInfo.primaryTitle,
    sourceTitle,
    sourceTitleForMatching: sourceTitle || action.sourceManga.mangaInfo.primaryTitle,
    sourcePrimaryTitle: sourceTitle || undefined,
    sourceAltTitles: safeStringArray(mangaInfo?.secondaryTitles),
    sourceAuthor: safeShortString(mangaInfo?.author),
    sourceArtist: safeShortString(mangaInfo?.artist),
    sourceShareUrl: safeUrlString(mangaInfo?.shareUrl),
    sourceThumbnailUrl: safeUrlString(mangaInfo?.thumbnailUrl),
    sourceExternalIds: externalIds,
    sourceOriginalMetadataJson:
      Object.keys(externalIds).length > 0 ? safeMetadataJson(mangaInfo?.additionalInfo) : undefined,
  };
}

function diagnosticProgressBridgeEvent(now: string): ProgressBridgeEvent {
  return {
    version: 1,
    schemaVersion: 3,
    source: "paperback-progress-provider",
    eventSource: "paperback-progress-bridge",
    actionId: "diagnostic-progress-bridge-settings-test",
    occurredAt: now,
    receivedAt: now,
    mangaId: "bridge-track:diagnostic",
    paperbackChapterId: "diagnostic:progress-bridge-test",
    chapterSourceId: "ProgressBridge",
    chapterMangaId: "diagnostic",
    readingSourceId: "ProgressBridge",
    readingSourceName: "ProgressBridge",
    readingSourceKind: "unknown",
    sourceMangaId: "diagnostic",
    sourceChapterId: "diagnostic:progress-bridge-test",
    sourceChapterNumber: 0,
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
    sourceTitleForMatching: "Diagnostic",
    sourceExternalIds: {},
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
      thumbnailUrl: PROGRESS_BRIDGE_ICON_URL,
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

function titleFromReadAction(action: TrackedMangaChapterReadAction): string {
  const title = action.readChapter?.title?.trim();
  if (title) return title;
  return `Chapter ${formatProgressNumber(action.chapterNum)}`;
}

function formatProgressNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/u, "");
}

function safeReadingSourceId(value: string): string {
  const trimmed = value.trim();
  return trimmed || "unknown";
}

function friendlySourceName(sourceId: string): string {
  return sourceId;
}

function readingSourceKind(sourceId: string, chapterId: string): "kavita" | "external" | "unknown" {
  if (/^(?:kavita|mutsuki(?:\s|-)?kavita)$/iu.test(sourceId) || chapterId.startsWith("kavita-")) {
    return "kavita";
  }
  return sourceId === "unknown" ? "unknown" : "external";
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((item) => {
    const sanitized = safeShortString(item);
    return sanitized ? [sanitized] : [];
  });
  return values.length > 0 ? values.slice(0, 25) : undefined;
}

function safeShortString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactSecretText(value).slice(0, 500);
}

function safeUrlString(value: unknown): string | undefined {
  const sanitized = safeShortString(value);
  if (!sanitized) return undefined;
  return sanitized.replace(
    /([?&](?:apiKey|token|access_token|auth|key)=)[^&\s"')<>]+/giu,
    "$1redacted",
  );
}

function safeExternalIds(value: unknown): Record<string, string | number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const ids: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (isSecretKey(key)) continue;
    if (typeof item === "number" && Number.isFinite(item)) {
      ids[safeExternalIdKey(key)] = item;
    } else if (typeof item === "string" && item.trim()) {
      ids[safeExternalIdKey(key)] = redactSecretText(item).slice(0, 500);
    }
  }
  return ids;
}

function safeMetadataJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return JSON.stringify(safeExternalIds(value)).slice(0, 4000);
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[^&\s"')<>]+/giu, "Bearer redacted")
    .replace(/x-api-key[:=]\s*[^&\s"')<>]+/giu, "x-api-key=redacted")
    .replace(/apiKey=[^&\s"')<>]+/giu, "apiKey=redacted")
    .replace(/([?&](?:token|access_token|auth|key)=)[^&\s"')<>]+/giu, "$1redacted");
}

function isSecretKey(key: string): boolean {
  return /token|api.?key|authorization|auth|secret|cookie|session|password/iu.test(key);
}

function safeExternalIdKey(key: string): string {
  return key.replace(/[^\w.-]+/gu, "_").slice(0, 80);
}

const paperbackProgressBridgeTransport: ProgressBridgeTransport = async (request) => {
  const [response] = await Application.scheduleRequest(request);
  return { status: response.status };
};

export const ProgressBridge = new MutsukiProgressBridgeExtension();
