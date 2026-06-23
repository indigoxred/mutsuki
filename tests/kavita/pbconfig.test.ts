import assert from "node:assert/strict";
import test from "node:test";

import { SourceIntents } from "@paperback/types";

import kavitaConfig from "../../src/Kavita/pbconfig.js";

test("Kavita advertises progress as an explicit Paperback capability", () => {
  assert.ok(kavitaConfig.capabilities.includes(SourceIntents.PROGRESS_PROVIDING));
  assert.ok(kavitaConfig.capabilities.includes(SourceIntents.CHAPTER_PROVIDING));
  assert.ok(kavitaConfig.capabilities.includes(SourceIntents.DISCOVER_SECTION_PROVIDING));
  assert.ok(kavitaConfig.capabilities.includes(SourceIntents.SEARCH_RESULT_PROVIDING));
  assert.ok(kavitaConfig.capabilities.includes(SourceIntents.SETTINGS_FORM_PROVIDING));
});
