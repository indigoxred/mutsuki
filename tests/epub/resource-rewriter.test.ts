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

test("inlines Kavita book-resource URLs using the embedded file query", async () => {
  const fetched: string[] = [];
  const rewritten = await rewriteHtmlResources({
    html: [
      '<img alt="Color" src="//read.example.test/api/book/66578/book-resources?apiKey=redacted&file=..%2FImages%2FColor1.jpg">',
      '<style>@font-face{src:url("//read.example.test/api/book/66578/book-resources?apiKey=redacted&file=OEBPS%2Ffonts%2FBook.ttf")}</style>',
    ].join(""),
    basePath: "page-1.xhtml",
    maxResourceBytes: 10_000,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      fetched.push(path);
      return {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: path.endsWith(".ttf") ? "font/ttf" : "image/jpeg",
      };
    },
  });

  assert.deepEqual(fetched, ["OEBPS/fonts/Book.ttf", "../Images/Color1.jpg"]);
  assert.match(rewritten.html, /data:image\/jpeg;base64,AQID/);
  assert.match(rewritten.html, /data:font\/ttf;base64,AQID/);
  assert.doesNotMatch(rewritten.html, /read\.example\.test\/api\/book/u);
});

test("leaves non-Kavita absolute resources unchanged", async () => {
  const fetched: string[] = [];
  const rewritten = await rewriteHtmlResources({
    html: '<img alt="Remote" src="https://cdn.example.test/remote.jpg">',
    basePath: "chapter.xhtml",
    maxResourceBytes: 10_000,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      fetched.push(path);
      return { bytes: new Uint8Array([1]).buffer, mimeType: "image/jpeg" };
    },
  });

  assert.deepEqual(fetched, []);
  assert.match(rewritten.html, /https:\/\/cdn\.example\.test\/remote\.jpg/u);
});
