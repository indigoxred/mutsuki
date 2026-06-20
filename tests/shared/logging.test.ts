import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../../src/shared/logging.js";

test("redacts bearer tokens, API keys, refresh tokens, OAuth codes, and URL credentials", () => {
  const input =
    "Authorization: Bearer abc.def?apiKey=secret&refresh_token=refresh&code=oauth https://user:pass@example.test/api";
  const redacted = redactSecrets(input);

  assert.equal(redacted.includes("abc.def"), false);
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("refresh"), false);
  assert.equal(redacted.includes("oauth"), false);
  assert.equal(redacted.includes("user:pass"), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);
});
