import assert from "node:assert/strict";
import test from "node:test";

import { isSameOrigin, normalizeKavitaBaseUrl, toKavitaApiUrl } from "../../src/shared/url.js";

test("normalizes root and api Kavita URLs without duplicating api", () => {
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000"), "http://localhost:5000");
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000/"), "http://localhost:5000");
  assert.equal(normalizeKavitaBaseUrl("http://localhost:5000/api"), "http://localhost:5000");
  assert.equal(
    toKavitaApiUrl("http://localhost:5000/api", "/Book/12/book-info"),
    "http://localhost:5000/api/Book/12/book-info",
  );
});

test("same origin checks prevent sending credentials to another host", () => {
  const baseUrl = normalizeKavitaBaseUrl("https://kavita.example.test/api");
  assert.equal(isSameOrigin(baseUrl, "https://kavita.example.test/api/Library/libraries"), true);
  assert.equal(isSameOrigin(baseUrl, "https://evil.example.test/api/Library/libraries"), false);
});

test("rejects blank or unsupported Kavita URLs", () => {
  assert.throws(() => normalizeKavitaBaseUrl(""), /Kavita URL is required/);
  assert.throws(() => normalizeKavitaBaseUrl("ftp://example.test"), /http or https/);
});
