import assert from "node:assert/strict";
import test from "node:test";

import { assembleHtmlChapter } from "../../src/Kavita/html-assembler.js";

test("combines pages, removes executable content, rewrites anchors, and keeps reader markup", async () => {
  const html = await assembleHtmlChapter({
    title: "Chapter 1",
    pages: [
      '<h1 id="start">Chapter 1</h1><p>Hello <em>world</em>.</p><script>alert(1)</script>',
      '<p><a href="#start">Back</a></p><iframe src="bad"></iframe>',
    ],
    rewriteResources: async (fragment) => fragment,
  });

  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /Hello <em>world<\/em>/);
  assert.match(html, /href="#mutsuki-start"/);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<iframe"), false);
});
