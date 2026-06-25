import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Mutsuki Progress Bridge",
  description: "Diagnostic tracker that forwards Paperback read-action queue events to a bridge.",
  version: "0.1.0",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.EVERYONE,
  capabilities: [
    SourceIntents.PROGRESS_PROVIDING,
    SourceIntents.SETTINGS_FORM_PROVIDING,
    SourceIntents.SEARCH_RESULT_PROVIDING,
  ],
  badges: [
    {
      label: "Tracker",
      textColor: "#ffffff",
      backgroundColor: "#10b981",
    },
  ],
  developers: [
    {
      name: "Mutsuki Contributors",
    },
  ],
} satisfies ExtensionInfo;
