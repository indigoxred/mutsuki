import {
  ButtonRow,
  Form,
  InputRow,
  LabelRow,
  Section,
  SelectRow,
  StepperRow,
  ToggleRow,
  type FormSectionElement,
} from "@paperback/types";

import { normalizeKavitaBaseUrl } from "../shared/url.js";
import { KavitaClient, type KavitaTransport } from "./client.js";
import { sendProgressBridgeEvent, type ProgressBridgeTransport } from "./progress-bridge.js";
import type { KavitaProgressBridgeEvent } from "./progress.js";
import {
  DEFAULT_LARGE_EPUB_HANDLING,
  DEFAULT_TARGET_SOURCE_PAGES_PER_PART,
  LARGE_EPUB_HANDLING_OPTIONS,
  MAX_TARGET_SOURCE_PAGES_PER_PART,
  MIN_TARGET_SOURCE_PAGES_PER_PART,
  normalizeLargeEpubHandling,
  normalizeTargetSourcePagesPerPart,
  type LargeEpubHandling,
} from "./large-epub-handling.js";
import {
  DEFAULT_NOVEL_LISTING_MODE,
  normalizeNovelListingMode,
  NOVEL_LISTING_MODE_OPTIONS,
  type NovelListingMode,
} from "./novel-listing-mode.js";
import {
  DEFAULT_NOVEL_RENDERING_MODE,
  normalizeNovelRenderingMode,
  NOVEL_RENDERING_MODE_OPTIONS,
  type NovelRenderingMode,
} from "./novel-rendering-mode.js";

export interface KavitaSettings {
  baseUrl: string;
  apiKey: string;
  pageSize: number;
  languageCode: string;
  showOnDeck: boolean;
  showRecentlyUpdated: boolean;
  showNewlyAdded: boolean;
  includeMangaLibraries: boolean;
  includeBookLibraries: boolean;
  htmlResourceSizeLimit: number;
  htmlChapterSizeLimit: number;
  novelListingMode: NovelListingMode;
  largeEpubHandling: LargeEpubHandling;
  targetSourcePagesPerPart: number;
  includePublisherExtras: boolean;
  novelRenderingMode: NovelRenderingMode;
  progressBridgeUrl: string;
  progressBridgeToken: string;
  debugLogging: boolean;
}

export const DEFAULT_KAVITA_SETTINGS: KavitaSettings = {
  baseUrl: "",
  apiKey: "",
  pageSize: 40,
  languageCode: "en",
  showOnDeck: true,
  showRecentlyUpdated: true,
  showNewlyAdded: true,
  includeMangaLibraries: true,
  includeBookLibraries: true,
  htmlResourceSizeLimit: 2_000_000,
  htmlChapterSizeLimit: 8_000_000,
  novelListingMode: DEFAULT_NOVEL_LISTING_MODE,
  largeEpubHandling: DEFAULT_LARGE_EPUB_HANDLING,
  targetSourcePagesPerPart: DEFAULT_TARGET_SOURCE_PAGES_PER_PART,
  includePublisherExtras: false,
  novelRenderingMode: DEFAULT_NOVEL_RENDERING_MODE,
  progressBridgeUrl: "",
  progressBridgeToken: "",
  debugLogging: false,
};

export function getKavitaSettings(): KavitaSettings {
  const settings = {
    ...DEFAULT_KAVITA_SETTINGS,
    ...(Application.getState("kavitaSettings") as Partial<KavitaSettings> | undefined),
    apiKey: (Application.getSecureState("kavitaApiKey") as string | undefined) ?? "",
    progressBridgeToken:
      (Application.getSecureState("kavitaProgressBridgeToken") as string | undefined) ?? "",
  };
  return {
    ...settings,
    novelListingMode: normalizeNovelListingMode(settings.novelListingMode),
    largeEpubHandling: normalizeLargeEpubHandling(settings.largeEpubHandling),
    targetSourcePagesPerPart: normalizeTargetSourcePagesPerPart(settings.targetSourcePagesPerPart),
    novelRenderingMode: normalizeNovelRenderingMode(settings.novelRenderingMode),
    includePublisherExtras: Boolean(settings.includePublisherExtras),
  };
}

export function setKavitaSettings(settings: KavitaSettings): void {
  const { apiKey: _apiKey, progressBridgeToken: _progressBridgeToken, ...nonSecret } = settings;
  Application.setState(nonSecret, "kavitaSettings");
  Application.setSecureState(settings.apiKey, "kavitaApiKey");
  Application.setSecureState(settings.progressBridgeToken, "kavitaProgressBridgeToken");
}

export class KavitaSettingsForm extends Form {
  private settings = getKavitaSettings();
  private connectionStatus = "";
  private progressBridgeStatus = "";

  override getSections(): FormSectionElement<unknown>[] {
    return [
      Section({ id: "connection", header: "Connection" }, [
        InputRow("base-url", {
          title: "Kavita URL",
          value: this.settings.baseUrl,
          onValueChange: Application.Selector(this as KavitaSettingsForm, "handleBaseUrlChange"),
        }),
        InputRow("api-key", {
          title: "Auth Key",
          value: this.settings.apiKey,
          isSecureEntry: true,
          onValueChange: Application.Selector(this as KavitaSettingsForm, "handleApiKeyChange"),
        }),
        ButtonRow("test", {
          title: "Test Connection",
          onSelect: Application.Selector(this as KavitaSettingsForm, "handleTestConnection"),
        }),
        this.connectionStatus
          ? LabelRow("status", { title: "Status", subtitle: this.connectionStatus })
          : undefined,
      ]),
      Section({ id: "display", header: "Discovery" }, [
        StepperRow("page-size", {
          title: "Page Size",
          value: this.settings.pageSize,
          minValue: 10,
          maxValue: 100,
          stepValue: 5,
          loopOver: false,
          onValueChange: Application.Selector(this as KavitaSettingsForm, "handlePageSizeChange"),
        }),
        InputRow("language", {
          title: "Default Language",
          value: this.settings.languageCode,
          onValueChange: Application.Selector(this as KavitaSettingsForm, "handleLanguageChange"),
        }),
        ToggleRow("show-on-deck", {
          title: "Show On Deck",
          value: this.settings.showOnDeck,
          onValueChange: Application.Selector(this as KavitaSettingsForm, "handleShowOnDeckChange"),
        }),
        ToggleRow("show-recent", {
          title: "Show Recently Updated",
          value: this.settings.showRecentlyUpdated,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleShowRecentlyUpdatedChange",
          ),
        }),
        ToggleRow("show-new", {
          title: "Show Newly Added",
          value: this.settings.showNewlyAdded,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleShowNewlyAddedChange",
          ),
        }),
        ToggleRow("include-manga", {
          title: "Include Manga Libraries",
          value: this.settings.includeMangaLibraries,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleIncludeMangaLibrariesChange",
          ),
        }),
        ToggleRow("include-books", {
          title: "Include Book Libraries",
          value: this.settings.includeBookLibraries,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleIncludeBookLibrariesChange",
          ),
        }),
      ]),
      Section({ id: "limits", header: "HTML Reader" }, [
        SelectRow("novel-listing-mode", {
          title: "Novel listing mode",
          value: [this.settings.novelListingMode],
          minItemCount: 1,
          maxItemCount: 1,
          layout: "list",
          items: NOVEL_LISTING_MODE_OPTIONS,
          subtitle:
            "Physical books mirrors Kavita with stable book ordering. Internal chapters may interleave under Paperback's Chapter Number sort.",
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleNovelListingModeChange",
          ),
        }),
        SelectRow("novel-rendering-mode", {
          title: "Novel rendering mode",
          value: [this.settings.novelRenderingMode],
          minItemCount: 1,
          maxItemCount: 1,
          layout: "list",
          items: NOVEL_RENDERING_MODE_OPTIONS,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleNovelRenderingModeChange",
          ),
        }),
        SelectRow("large-epub-handling", {
          title: "Large EPUB handling",
          value: [this.settings.largeEpubHandling],
          minItemCount: 1,
          maxItemCount: 1,
          layout: "list",
          items: LARGE_EPUB_HANDLING_OPTIONS,
          subtitle:
            "Auto split preserves formatting and loading speed. Single entry is legacy and may exceed the XHTML budget.",
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleLargeEpubHandlingChange",
          ),
        }),
        StepperRow("target-source-pages-per-part", {
          title: "Target source pages per part",
          value: this.settings.targetSourcePagesPerPart,
          minValue: MIN_TARGET_SOURCE_PAGES_PER_PART,
          maxValue: MAX_TARGET_SOURCE_PAGES_PER_PART,
          stepValue: 16,
          loopOver: false,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleTargetSourcePagesPerPartChange",
          ),
        }),
        ToggleRow("include-publisher-extras", {
          title: "Include publisher extras",
          value: this.settings.includePublisherExtras,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleIncludePublisherExtrasChange",
          ),
        }),
        StepperRow("resource-limit", {
          title: "Resource Limit",
          subtitle: "Bytes per EPUB resource.",
          value: this.settings.htmlResourceSizeLimit,
          minValue: 100_000,
          maxValue: 10_000_000,
          stepValue: 100_000,
          loopOver: false,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleResourceLimitChange",
          ),
        }),
        StepperRow("chapter-limit", {
          title: "Chapter Limit",
          subtitle:
            "Maximum completed HTML size. Text is preserved and excess illustrations are omitted.",
          value: this.settings.htmlChapterSizeLimit,
          minValue: 500_000,
          maxValue: 30_000_000,
          stepValue: 500_000,
          loopOver: false,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleChapterLimitChange",
          ),
        }),
        ToggleRow("debug", {
          title: "Debug Logging",
          value: this.settings.debugLogging,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleDebugLoggingChange",
          ),
        }),
      ]),
      Section({ id: "progress-sync", header: "Progress Sync" }, [
        LabelRow("progress-sync-note", {
          title: "Progress diagnostics",
          subtitle:
            "The mock bridge test proves app-to-bridge networking only. Automatic read queue delivery is still under verification.",
        }),
        InputRow("progress-bridge-url", {
          title: "Progress bridge URL",
          value: this.settings.progressBridgeUrl,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleProgressBridgeUrlChange",
          ),
        }),
        InputRow("progress-bridge-token", {
          title: "Progress bridge token",
          value: this.settings.progressBridgeToken,
          isSecureEntry: true,
          onValueChange: Application.Selector(
            this as KavitaSettingsForm,
            "handleProgressBridgeTokenChange",
          ),
        }),
        ButtonRow("send-mock-bridge-test-event", {
          title: "Send mock bridge test event",
          onSelect: Application.Selector(
            this as KavitaSettingsForm,
            "handleSendMockBridgeTestEvent",
          ),
        }),
        this.progressBridgeStatus
          ? LabelRow("progress-bridge-status", {
              title: "Mock bridge test",
              subtitle: this.progressBridgeStatus,
            })
          : undefined,
      ]),
    ];
  }

  async handleBaseUrlChange(value: string): Promise<void> {
    this.update({ baseUrl: value });
  }

  async handleApiKeyChange(value: string): Promise<void> {
    this.update({ apiKey: value });
  }

  async handlePageSizeChange(value: number): Promise<void> {
    this.update({ pageSize: value });
  }

  async handleLanguageChange(value: string): Promise<void> {
    this.update({ languageCode: value || "en" });
  }

  async handleShowOnDeckChange(value: boolean): Promise<void> {
    this.update({ showOnDeck: value });
  }

  async handleShowRecentlyUpdatedChange(value: boolean): Promise<void> {
    this.update({ showRecentlyUpdated: value });
  }

  async handleShowNewlyAddedChange(value: boolean): Promise<void> {
    this.update({ showNewlyAdded: value });
  }

  async handleIncludeMangaLibrariesChange(value: boolean): Promise<void> {
    this.update({ includeMangaLibraries: value });
  }

  async handleIncludeBookLibrariesChange(value: boolean): Promise<void> {
    this.update({ includeBookLibraries: value });
  }

  async handleResourceLimitChange(value: number): Promise<void> {
    this.update({ htmlResourceSizeLimit: value });
  }

  async handleChapterLimitChange(value: number): Promise<void> {
    this.update({ htmlChapterSizeLimit: value });
  }

  async handleNovelRenderingModeChange(value: string[]): Promise<void> {
    this.update({ novelRenderingMode: normalizeNovelRenderingMode(value[0]) });
  }

  async handleNovelListingModeChange(value: string[]): Promise<void> {
    this.update({ novelListingMode: normalizeNovelListingMode(value[0]) });
  }

  async handleLargeEpubHandlingChange(value: string[]): Promise<void> {
    this.update({ largeEpubHandling: normalizeLargeEpubHandling(value[0]) });
  }

  async handleTargetSourcePagesPerPartChange(value: number): Promise<void> {
    this.update({ targetSourcePagesPerPart: normalizeTargetSourcePagesPerPart(value) });
  }

  async handleIncludePublisherExtrasChange(value: boolean): Promise<void> {
    this.update({ includePublisherExtras: value });
  }

  async handleDebugLoggingChange(value: boolean): Promise<void> {
    this.update({ debugLogging: value });
  }

  async handleProgressBridgeUrlChange(value: string): Promise<void> {
    this.update({ progressBridgeUrl: value.trim() });
  }

  async handleProgressBridgeTokenChange(value: string): Promise<void> {
    this.update({ progressBridgeToken: value });
  }

  async handleSendMockBridgeTestEvent(): Promise<void> {
    try {
      const now = new Date().toISOString();
      await sendProgressBridgeEvent({
        bridgeUrl: this.settings.progressBridgeUrl,
        token: this.settings.progressBridgeToken || undefined,
        event: diagnosticMockBridgeEvent(now),
        transport: settingsProgressBridgeTransport,
      });
      this.progressBridgeStatus = "Diagnostic event sent.";
    } catch (error) {
      this.progressBridgeStatus =
        error instanceof Error ? error.message : "Diagnostic event failed.";
    }
    this.reloadForm();
  }

  async handleTestConnection(): Promise<void> {
    try {
      const baseUrl = normalizeKavitaBaseUrl(this.settings.baseUrl);
      const apiKey = this.settings.apiKey.trim();
      if (!apiKey) throw new Error("Missing Kavita auth key.");
      await new KavitaClient({
        baseUrl,
        apiKey,
        transport: settingsTransport,
      }).testConnection();
      this.connectionStatus = "Connection verified.";
    } catch (error) {
      this.connectionStatus = error instanceof Error ? error.message : "Invalid Kavita settings.";
    }
    this.reloadForm();
  }

  private update(settings: Partial<KavitaSettings>): void {
    this.settings = { ...this.settings, ...settings };
    setKavitaSettings(this.settings);
  }
}

const settingsTransport: KavitaTransport = async (request) => {
  const [response, buffer] = await Application.scheduleRequest(request);
  const contentType = response.headers["content-type"] ?? response.mimeType;
  const isText = contentType?.includes("json") || contentType?.startsWith("text/");
  return {
    status: response.status,
    headers: response.headers,
    body: isText ? Application.arrayBufferToUTF8String(buffer) : buffer,
  };
};

const settingsProgressBridgeTransport: ProgressBridgeTransport = async (request) => {
  const [response] = await Application.scheduleRequest(request);
  return { status: response.status };
};

function diagnosticMockBridgeEvent(now: string): KavitaProgressBridgeEvent {
  return {
    version: 1,
    schemaVersion: 2,
    source: "paperback-mutsuki",
    eventSource: "mutsuki-kavita-source",
    actionId: "diagnostic-settings-test",
    occurredAt: now,
    receivedAt: now,
    mangaId: "diagnostic:kavita-settings",
    paperbackChapterId: "diagnostic:mock-bridge-test",
    readingSourceId: "Kavita",
    readingSourceName: "Mutsuki Kavita",
    readingSourceKind: "kavita",
    sourceMangaId: "diagnostic:kavita-settings",
    sourceChapterId: "diagnostic:mock-bridge-test",
    sourceChapterNumber: 0,
    kavitaSeriesId: 1,
    kavitaChapterId: 1,
    chapterKind: "manga",
    chapterNum: 0,
    isLastInVolume: false,
    shouldMarkKavitaRead: false,
    kavitaMarkedRead: false,
    title: "Mutsuki diagnostic mock bridge test event",
    listingMode: "diagnostic",
    role: "diagnostic",
  };
}
