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

test("normalizes EPUB fragments into XHTML-safe Paperback novel markup", async () => {
  const html = await assembleHtmlChapter({
    title: "Illustrated Chapter",
    pages: [
      `<section epub:type="bodymatter" xmlns:epub="http://www.idpf.org/2007/ops"><p>&nbsp;A${String.fromCharCode(
        160,
      )}B</p><img src="cover.jpg"><br><hr></section>`,
    ],
    rewriteResources: async (fragment) =>
      fragment.replace('src="cover.jpg"', 'src="data:image/png;base64,AQID"'),
  });

  assert.match(html, /<meta charset="utf-8" \/>/u);
  assert.match(html, /<img src="data:image\/png;base64,AQID" \/>/u);
  assert.match(html, /<br \/>/u);
  assert.match(html, /<hr \/>/u);
  assert.equal(html.includes("epub:"), false);
  assert.equal(html.includes("xmlns:epub"), false);
  assert.equal(html.includes("&nbsp;"), false);
  assert.equal(html.includes(String.fromCharCode(160)), false);
});
