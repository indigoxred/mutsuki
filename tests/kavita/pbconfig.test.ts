import assert from "node:assert/strict";
import test from "node:test";

import { SourceIntents } from "@paperback/types";

import kavitaConfig from "../../src/Kavita/pbconfig.js";

test("Kavita stays content-only and does not advertise tracker progress capability", () => {
  const capabilities = kavitaConfig.capabilities as readonly SourceIntents[];
  assert.equal(capabilities.includes(SourceIntents.PROGRESS_PROVIDING), false);
  assert.ok(capabilities.includes(SourceIntents.CHAPTER_PROVIDING));
  assert.ok(capabilities.includes(SourceIntents.DISCOVER_SECTION_PROVIDING));
  assert.ok(capabilities.includes(SourceIntents.SEARCH_RESULT_PROVIDING));
  assert.ok(capabilities.includes(SourceIntents.SETTINGS_FORM_PROVIDING));
});
