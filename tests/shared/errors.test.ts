import assert from "node:assert/strict";
import test from "node:test";

import { classifyHttpStatus } from "../../src/shared/errors.js";

test("classifies retryable and permanent HTTP responses", () => {
  assert.equal(classifyHttpStatus(429), "transient");
  assert.equal(classifyHttpStatus(500), "transient");
  assert.equal(classifyHttpStatus(503), "transient");
  assert.equal(classifyHttpStatus(401), "auth");
  assert.equal(classifyHttpStatus(403), "auth");
  assert.equal(classifyHttpStatus(404), "permanent");
});
