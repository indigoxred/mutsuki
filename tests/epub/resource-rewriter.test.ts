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
    "OPS/chapters/images/Cover Image.png",
    "OPS/style/main.css",
    "OPS/images/bg.png",
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

  assert.deepEqual(fetched, ["../Images/Color1.jpg"]);
  assert.match(rewritten.html, /data:image\/jpeg;base64,AQID/);
  assert.doesNotMatch(rewritten.html, /data:font\/ttf/u);
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

test("removes missing stylesheets and CSS imports while caching resource misses", async () => {
  const fetchCounts = new Map<string, number>();
  const resourceUrl = (file: string): string =>
    `//read.example.test/api/book/65572/book-resources?apiKey=secret-key&file=${encodeURIComponent(
      file,
    )}`;

  const rewritten = await rewriteHtmlResources({
    html: [
      `<link rel="stylesheet" href="${resourceUrl("item/style/style-reset.css")}">`,
      `<link rel="stylesheet" href="${resourceUrl("item/style/main.css")}">`,
      "<style>",
      `@import url("${resourceUrl("item/style/style-reset.css")}");`,
      `.hero{background:url("${resourceUrl("images/bg.jpg")}")}`,
      "</style>",
      "<p>Visible Hitagi text survives.</p>",
      `<img alt="Cover" src="${resourceUrl("images/cover.jpg")}">`,
    ].join(""),
    basePath: "page-6.xhtml",
    maxResourceBytes: 20_000,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      fetchCounts.set(path, (fetchCounts.get(path) ?? 0) + 1);
      if (path === "item/style/main.css") {
        return {
          bytes: new TextEncoder().encode(
            [
              `@import url("${resourceUrl("item/style/style-standard.css")}");`,
              `@import url("${resourceUrl("item/style/style-reset.css")}");`,
              `.chapter{background:url("${resourceUrl("images/bg.jpg")}")}`,
            ].join(""),
          ).buffer,
          mimeType: "text/css",
        };
      }
      if (path.startsWith("item/style/")) return undefined;
      return { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/jpeg" };
    },
  });

  assert.equal(fetchCounts.get("item/style/style-reset.css"), 1);
  assert.equal(fetchCounts.get("item/style/style-standard.css"), 1);
  assert.equal(fetchCounts.get("images/bg.jpg"), 1);
  assert.equal(rewritten.html.includes("Stylesheet unavailable"), false);
  assert.equal(rewritten.html.includes("@import"), false);
  assert.equal(rewritten.html.includes("style-reset.css"), false);
  assert.equal(rewritten.html.includes("style-standard.css"), false);
  assert.match(rewritten.html, /Visible Hitagi text survives/u);
  assert.match(rewritten.html, /data:image\/jpeg;base64,AQID/u);
  assert.match(
    rewritten.warnings.join("\n"),
    /Missing EPUB resource: item\/style\/style-reset\.css/u,
  );
});

test("converts protected SVG images and img srcsets to safe data URLs", async () => {
  const fetched: string[] = [];
  const resourceUrl = (file: string): string =>
    `//read.example.test/api/book/68789/book-resources?apiKey=secret-key&file=${encodeURIComponent(
      file,
    )}`;

  const rewritten = await rewriteHtmlResources({
    html: [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="kavita-scale-width" width="1200" height="1800">',
      `<image width="1200" height="1800" xlink:href="${resourceUrl("images/page-a.jpg")}"></image>`,
      "</svg>",
      '<svg xmlns="http://www.w3.org/2000/svg" class="kavita-scale-width">',
      `<image href="${resourceUrl("images/page-b.jpg")}"></image>`,
      "</svg>",
      `<img alt="Set" src="${resourceUrl("images/fallback.jpg")}" srcset="${resourceUrl(
        "images/small.jpg",
      )} 1x, ${resourceUrl("images/large.jpg")} 2x">`,
    ].join(""),
    basePath: "page-0.xhtml",
    maxResourceBytes: 20_000,
    maxChapterBytes: 100_000,
    fetchResource: async (path) => {
      fetched.push(path);
      return { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/jpeg" };
    },
  });

  assert.deepEqual(fetched, [
    "images/fallback.jpg",
    "images/small.jpg",
    "images/large.jpg",
    "images/page-a.jpg",
    "images/page-b.jpg",
  ]);
  assert.equal(rewritten.html.includes("<svg"), false);
  assert.equal(rewritten.html.includes("xlink:"), false);
  assert.equal(rewritten.html.includes("/book-resources?"), false);
  assert.equal(rewritten.html.includes("apiKey="), false);
  assert.equal(rewritten.html.includes("secret-key"), false);
  assert.match(
    rewritten.html,
    /<img src="data:image\/jpeg;base64,AQID" alt="" class="kavita-scale-width"[^>]*\/>/u,
  );
  assert.match(
    rewritten.html,
    /srcset="data:image\/jpeg;base64,AQID 1x, data:image\/jpeg;base64,AQID 2x"/u,
  );
});
