import { ContentRating, SourceIntents, type ExtensionInfo } from "@paperback/types";

export default {
  name: "Mutsuki MyAnimeList",
  description: "Tracks Paperback reading progress to MyAnimeList chapters and completed volumes.",
  version: "0.1.0",
  icon: "icon.svg",
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
      backgroundColor: "#356fbd",
    },
  ],
  developers: [
    {
      name: "Mutsuki Contributors",
    },
  ],
} satisfies ExtensionInfo;
