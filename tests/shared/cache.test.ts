import assert from "node:assert/strict";
import test from "node:test";

import { LruCache } from "../../src/shared/cache.js";

test("evicts least-recently-used entries when the cache exceeds its size", () => {
  const cache = new LruCache<string, number>(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("c"), 3);
});
