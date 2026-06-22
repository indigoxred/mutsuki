import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Mutsuki Kavita",
  description: "Connects Paperback to Kavita for manga, PDFs, and EPUB light novels.",
  version: "0.1.8",
  icon: "icon.png",
  language: "en",
  contentRating: ContentRating.EVERYONE,
  capabilities: [
    SourceIntents.DISCOVER_SECTION_PROVIDING |
      SourceIntents.SEARCH_RESULT_PROVIDING |
      SourceIntents.CHAPTER_PROVIDING |
      SourceIntents.SETTINGS_FORM_PROVIDING,
  ],
  badges: [
    {
      label: "Kavita",
      textColor: "#ffffff",
      backgroundColor: "#2f6f73",
    },
    {
      label: "Novel",
      textColor: "#111827",
      backgroundColor: "#e4d8ba",
    },
  ],
  developers: [
    {
      name: "Mutsuki Contributors",
    },
  ],
} satisfies ExtensionInfo;
