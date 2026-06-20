import assert from "node:assert/strict";
import test from "node:test";

import { rewriteHtmlResources } from "../../src/Kavita/resource-rewriter.js";

test("inlines relative images and CSS url resources as data URLs", async () => {
  const fetched: string[] = [];
  const rewritten = await rewriteHtmlResources({
    html: '<link rel="stylesheet" href="../style/main.css"><img alt="Cover" src="images/Cover Image.png">',
    basePath: "OPS/chapters/ch1.xhtml",
    maxResourceBytes: 10_000,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      fetched.push(path);
      if (path === "OPS/style/main.css") {
        return {
          bytes: new TextEncoder().encode("body{background:url('../images/bg.png')}").buffer,
          mimeType: "text/css",
        };
      }
      return {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: "image/png",
      };
    },
  });

  assert.deepEqual(fetched, [
    "OPS/style/main.css",
    "OPS/images/bg.png",
    "OPS/chapters/images/Cover Image.png",
  ]);
  assert.equal(rewritten.html.includes("data:text/css;base64"), false);
  assert.match(rewritten.html, /<style>/);
  assert.match(rewritten.html, /data:image\/png;base64,AQID/);
  assert.deepEqual(rewritten.warnings, []);
});

test("replaces missing and oversized resources with nonfatal placeholders", async () => {
  const rewritten = await rewriteHtmlResources({
    html: '<img alt="Missing" src="missing.png"><img alt="Huge" src="huge.png">',
    basePath: "chapter.xhtml",
    maxResourceBytes: 2,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      if (path === "missing.png") return undefined;
      return { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/png" };
    },
  });

  assert.match(rewritten.html, /data-mutsuki-missing-resource="missing.png"/);
  assert.match(rewritten.html, /data-mutsuki-missing-resource="huge.png"/);
  assert.equal(rewritten.warnings.length, 2);
});
