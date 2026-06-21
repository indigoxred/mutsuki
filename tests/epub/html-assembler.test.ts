import assert from "node:assert/strict";
import test from "node:test";

import { SaxesParser, type SaxesTagNS } from "saxes";

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

test("assembled Full EPUB XHTML has a strict XML-safe root document", async () => {
  const html = await assembleHtmlChapter({
    title: "Synthetic Failing Fixture",
    pages: [
      [
        "<div>",
        "<style>",
        "@page { margin: 0; }",
        ".bodyText { font-style: italic; margin: 1rem; }",
        "</style>",
        '<section epub:type="bodymatter" xmlns:epub="http://www.idpf.org/2007/ops">',
        '<p class="bodyText"><span>Alpha &copy; Beta &amp; Gamma &nbsp; Delta</span><br></p>',
        "<p><span>Tom & Jerry keep visible synthetic text for validation.</span></p>",
        '<p><a id="note" href="#note">Anchor text survives.</a><wbr><hr></p>',
        '<p><img alt="Cover" src="images/cover.png"></p>',
        "</section>",
        "</div>",
      ].join(""),
    ],
    rewriteResources: async (fragment) =>
      fragment.replace('src="images/cover.png"', 'src="data:image/png;base64,AQID"'),
  });

  assert.equal(html.startsWith("<html"), true);
  assert.equal(html.includes("<!doctype"), false);
  assert.equal(html.includes("<!DOCTYPE"), false);
  assert.equal(html.includes("@page"), false);
  assert.equal(html.includes("font-style: italic"), true);
  assert.equal(html.includes("&copy;"), false);
  assert.equal(html.includes("&nbsp;"), false);
  assert.equal(html.includes("Tom & Jerry"), false);
  assert.match(html, /<br \/>/u);
  assert.match(html, /<hr \/>/u);
  assert.match(html, /<wbr \/>/u);
  assert.match(html, /<img alt="Cover" src="data:image\/png;base64,AQID" \/>/u);

  const parsed = parseStrictXhtml(html);
  assert.deepEqual(parsed.rootNames, ["html"]);
  assert.equal(parsed.rootNamespace, "http://www.w3.org/1999/xhtml");
  assert.match(parsed.visibleText, /Alpha © Beta & Gamma\s+Delta/u);
  assert.match(parsed.visibleText, /Tom & Jerry keep visible synthetic text/u);
  assert.match(parsed.visibleText, /Anchor text survives/u);
});

function parseStrictXhtml(html: string): {
  rootNames: string[];
  rootNamespace: string | undefined;
  visibleText: string;
} {
  const parser = new SaxesParser({ xmlns: true });
  const rootNames: string[] = [];
  const text: string[] = [];
  let rootNamespace: string | undefined;
  let depth = 0;
  let parseError: Error | undefined;

  parser.on("opentag", (tag: SaxesTagNS) => {
    if (depth === 0) {
      rootNames.push(tag.name);
      rootNamespace = tag.uri;
    }
    depth += 1;
  });
  parser.on("closetag", () => {
    depth -= 1;
  });
  parser.on("text", (value) => {
    text.push(value);
  });
  parser.on("error", (error) => {
    parseError = error;
  });

  parser.write(html).close();
  if (parseError) throw parseError;

  return {
    rootNames,
    rootNamespace,
    visibleText: text.join("").replace(/\s+/gu, " ").trim(),
  };
}
