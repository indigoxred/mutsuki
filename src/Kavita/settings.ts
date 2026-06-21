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
  novelRenderingMode: NovelRenderingMode;
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
  novelRenderingMode: DEFAULT_NOVEL_RENDERING_MODE,
  debugLogging: false,
};

export function getKavitaSettings(): KavitaSettings {
  const settings = {
    ...DEFAULT_KAVITA_SETTINGS,
    ...(Application.getState("kavitaSettings") as Partial<KavitaSettings> | undefined),
    apiKey: (Application.getSecureState("kavitaApiKey") as string | undefined) ?? "",
  };
  return {
    ...settings,
    novelRenderingMode: normalizeNovelRenderingMode(settings.novelRenderingMode),
  };
}

export function setKavitaSettings(settings: KavitaSettings): void {
  const { apiKey: _apiKey, ...nonSecret } = settings;
  Application.setState(nonSecret, "kavitaSettings");
  Application.setSecureState(settings.apiKey, "kavitaApiKey");
}

export class KavitaSettingsForm extends Form {
  private settings = getKavitaSettings();
  private connectionStatus = "";

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
          subtitle: "Bytes per generated HTML chapter.",
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

  async handleDebugLoggingChange(value: boolean): Promise<void> {
    this.update({ debugLogging: value });
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
