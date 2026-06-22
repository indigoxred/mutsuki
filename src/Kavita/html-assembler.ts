import { SaxesParser } from "saxes";

export interface RawEpubPage {
  pageNumber: number;
  html: string;
  tocTitle?: string;
}

export interface PreparedEpubPage {
  pageNumber: number;
  bodyHtml: string;
  stylesheetBlocks: PreparedStylesheet[];
  sourceTitle?: string;
  tocTitle?: string;
  visibleTextCharacters: number;
  injectedTitle: boolean;
}

export interface PreparedStylesheet {
  html: string;
  basePath: string;
}

export interface AssembleHtmlChapterInput {
  title: string;
  pages: string[] | RawEpubPage[];
  rewriteResources: (fragment: string, pageNumber: number) => Promise<string>;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const EXECUTABLE_TAGS = new Set(["script", "iframe", "frame", "object", "embed", "form"]);
const SAFE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "class",
  "colspan",
  "dir",
  "height",
  "href",
  "id",
  "lang",
  "name",
  "rel",
  "role",
  "rowspan",
  "src",
  "srcset",
  "title",
  "type",
  "width",
]);
const FALLBACK_READER_CSS = [
  "html,body{margin:0;padding:0}",
  "body{line-height:1.65;padding:1rem}",
  ".mutsuki-spine-item{display:block}",
  ".mutsuki-spine-item+.mutsuki-spine-item{break-before:page;page-break-before:always;-webkit-column-break-before:always}",
  "h1,h2,h3,h4,h5,h6{display:block;font-weight:700;line-height:1.25;margin:1.5em 0 .75em;break-after:avoid-page;page-break-after:avoid}",
  "p{display:block;margin:.75em 0}",
  "hr{display:block;margin:1.5em auto}",
  "img{max-width:100%;height:auto}",
  "table{max-width:100%}",
  ".mutsuki-page-break{display:block;break-before:page;page-break-before:always;-webkit-column-break-before:always}",
].join("");

const HTML_ENTITY_REPLACEMENTS: Record<string, string> = {
  bull: "&#8226;",
  copy: "&#169;",
  hellip: "&#8230;",
  laquo: "&#171;",
  ldquo: "&#8220;",
  lsquo: "&#8216;",
  mdash: "&#8212;",
  middot: "&#183;",
  nbsp: " ",
  ndash: "&#8211;",
  raquo: "&#187;",
  rdquo: "&#8221;",
  reg: "&#174;",
  rsquo: "&#8217;",
  trade: "&#8482;",
};
const XML_ENTITY_NAMES: Record<string, string> = {
  amp: "&amp;",
  apos: "&apos;",
  gt: "&gt;",
  lt: "&lt;",
  quot: "&quot;",
};

export async function assembleHtmlChapter(input: AssembleHtmlChapterInput): Promise<string> {
  const rawPages = normalizeRawPages(input.pages);
  const preparedPages = rawPages.map(prepareEpubPage);
  const cssBlocks = await rewriteAndDedupeStylesheets(preparedPages, input.rewriteResources);
  const rewrittenPages: string[] = [];

  for (const page of preparedPages) {
    const rewritten = await input.rewriteResources(page.bodyHtml, page.pageNumber);
    rewrittenPages.push(
      `<section class="mutsuki-spine-item" data-mutsuki-page="${page.pageNumber}">${normalizeXhtml(
        sanitizeExecutableContent(rewritten),
      )}</section>`,
    );
  }

  return normalizeXhtml(
    [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      `<title>${escapeHtml(input.title)}</title>`,
      `<style>${FALLBACK_READER_CSS}</style>`,
      ...cssBlocks.map((css) => `<style data-mutsuki-css="publisher">${css}</style>`),
      "</head>",
      "<body>",
      ...rewrittenPages,
      "</body>",
      "</html>",
    ].join(""),
  );
}

export function prepareEpubPage(page: RawEpubPage): PreparedEpubPage {
  const normalizedInput = normalizeInputDocument(page.html);
  const state = parseDocument(normalizedInput, page.pageNumber);
  const tocTitle = meaningfulTitle(page.tocTitle);
  const sourceTitle = firstHeadingText(state.bodyHtml);
  const injectedTitle =
    tocTitle !== undefined && !containsEquivalentHeading(state.bodyHtml, tocTitle);
  const bodyHtml = injectedTitle
    ? `<h2 class="mutsuki-injected-title">${escapeHtml(tocTitle)}</h2>${state.bodyHtml}`
    : state.bodyHtml;

  return {
    pageNumber: page.pageNumber,
    bodyHtml,
    stylesheetBlocks: state.stylesheetBlocks,
    sourceTitle,
    tocTitle,
    visibleTextCharacters: extractVisibleText(bodyHtml).length,
    injectedTitle,
  };
}

async function rewriteAndDedupeStylesheets(
  pages: PreparedEpubPage[],
  rewriteResources: (fragment: string, pageNumber: number) => Promise<string>,
): Promise<string[]> {
  const seen = new Set<string>();
  const seenRawBlocks = new Set<string>();
  const cssBlocks: string[] = [];

  for (const page of pages) {
    for (const block of page.stylesheetBlocks) {
      const rawHash = normalizeStylesheetBlockForHash(block.html);
      if (!rawHash || seenRawBlocks.has(rawHash)) continue;
      seenRawBlocks.add(rawHash);
      const rewritten = normalizeXhtml(await rewriteResources(block.html, page.pageNumber));
      for (const css of extractStyleBlocks(rewritten)) {
        const clean = sanitizeCss(css);
        const hash = normalizeCssForHash(clean);
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        cssBlocks.push(clean);
      }
    }
  }

  return cssBlocks;
}

function normalizeRawPages(pages: string[] | RawEpubPage[]): RawEpubPage[] {
  return pages.map((page, index) =>
    typeof page === "string" ? { pageNumber: index, html: page } : page,
  );
}

function normalizeInputDocument(html: string): string {
  const cleaned = html
    .replace(/^\uFEFF/u, "")
    .replace(/<\?xml[\s\S]*?\?>/giu, "")
    .replace(/<!doctype[\s\S]*?>/giu, "");
  const normalized = normalizeEntities(closeVoidElements(cleaned));
  return /<html\b/iu.test(normalized)
    ? normalized
    : `<html xmlns="http://www.w3.org/1999/xhtml"><body>${normalized}</body></html>`;
}

function closeVoidElements(html: string): string {
  const voidTagPattern =
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\s[^>]*?)?>/giu;
  const voidClosingTagPattern =
    /<\/(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\s*>/giu;
  return html
    .replace(voidTagPattern, (match: string, tag: string, attributes = "") =>
      /\/\s*>$/u.test(match) ? match : `<${tag}${attributes} />`,
    )
    .replace(voidClosingTagPattern, "");
}

function normalizeEntities(html: string): string {
  return html
    .replace(/\u00a0/gu, " ")
    .replace(/&(#x[0-9a-f]+;|#\d+;|[a-z][a-z0-9]+;)?/giu, normalizeEntity);
}

function parseDocument(
  html: string,
  pageNumber: number,
): { bodyHtml: string; stylesheetBlocks: PreparedStylesheet[] } {
  const parser = new SaxesParser({ xmlns: false });
  const body: string[] = [];
  const stylesheetBlocks: PreparedStylesheet[] = [];
  const elementStack: string[] = [];
  let inBody = !/<body\b/iu.test(html);
  let styleDepth = 0;
  let styleText = "";
  let skipDepth = 0;
  let parseError: Error | undefined;

  parser.on("opentag", (tag) => {
    const name = tag.name.toLowerCase();
    if (name === "head") {
      return;
    }
    if (name === "body") {
      inBody = true;
      return;
    }
    if (EXECUTABLE_TAGS.has(name)) {
      skipDepth += 1;
      return;
    }
    if (skipDepth > 0) {
      skipDepth += 1;
      return;
    }
    if (name === "style") {
      styleDepth = 1;
      styleText = "";
      return;
    }
    if (name === "link" && isStylesheetLink(tag.attributes)) {
      stylesheetBlocks.push({
        html: serializeVoidTag("link", tag.attributes, pageNumber),
        basePath: `page-${pageNumber}.xhtml`,
      });
      return;
    }
    if (!inBody || name === "html") return;

    const serialized = serializeOpenTag(name, tag.attributes, pageNumber);
    body.push(serialized);
    if (!VOID_TAGS.has(name)) elementStack.push(name);
  });

  parser.on("closetag", (tag) => {
    const name = tag.name.toLowerCase();
    if (name === "head") {
      return;
    }
    if (name === "body") {
      inBody = false;
      return;
    }
    if (skipDepth > 0) {
      skipDepth -= 1;
      return;
    }
    if (styleDepth > 0) {
      styleDepth -= 1;
      if (styleDepth === 0) {
        stylesheetBlocks.push({
          html: `<style>${escapeCdataForStyle(styleText)}</style>`,
          basePath: `page-${pageNumber}.xhtml`,
        });
        styleText = "";
      }
      return;
    }
    if (!inBody || VOID_TAGS.has(name)) return;
    const open = elementStack.pop();
    if (open) body.push(`</${open}>`);
  });

  parser.on("text", (text) => {
    if (skipDepth > 0) return;
    if (styleDepth > 0) {
      styleText += text;
      return;
    }
    if (inBody) body.push(escapeHtml(text));
  });
  parser.on("cdata", (text) => {
    if (styleDepth > 0) styleText += text;
    else if (inBody) body.push(escapeHtml(text));
  });
  parser.on("error", (error) => {
    parseError = error;
  });

  parser.write(html).close();
  if (parseError) {
    return fallbackPrepareBody(html, pageNumber);
  }

  return { bodyHtml: body.join(""), stylesheetBlocks };
}

function fallbackPrepareBody(
  html: string,
  pageNumber: number,
): { bodyHtml: string; stylesheetBlocks: PreparedStylesheet[] } {
  const stylesheetBlocks = extractRawStyleAndLinkBlocks(html).map((block) => ({
    html: block,
    basePath: `page-${pageNumber}.xhtml`,
  }));
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(html)?.[1] ?? html;
  return {
    bodyHtml: sanitizeExecutableContent(
      normalizeXhtml(
        body
          .replace(/<head\b[\s\S]*?<\/head>/giu, "")
          .replace(/<html\b[^>]*>/giu, "")
          .replace(/<\/html>/giu, "")
          .replace(/<style\b[\s\S]*?<\/style>/giu, "")
          .replace(/<link\b[^>]*\bstylesheet\b[^>]*>/giu, ""),
      ),
    ),
    stylesheetBlocks,
  };
}

function extractRawStyleAndLinkBlocks(html: string): string[] {
  return [
    ...(html.match(/<link\b[^>]*\bstylesheet\b[^>]*\/?>/giu) ?? []),
    ...(html.match(/<style\b[^>]*>[\s\S]*?<\/style>/giu) ?? []),
  ];
}

function serializeOpenTag(
  name: string,
  attributes: Record<string, string>,
  pageNumber: number,
): string {
  const serializedAttributes = serializeAttributes(name, attributes, pageNumber);
  if (name === "hr") {
    const className = classWithPageBreak(attributes.class ?? "");
    return `<hr${serializeAttributes(name, { ...attributes, class: className }, pageNumber)} />`;
  }
  if (isPageBreakElement(name, attributes)) {
    return `<span class="mutsuki-page-break"></span>${VOID_TAGS.has(name) ? "" : `<${name}${serializedAttributes}>`}`;
  }
  return VOID_TAGS.has(name)
    ? `<${name}${serializedAttributes} />`
    : `<${name}${serializedAttributes}>`;
}

function serializeVoidTag(
  name: string,
  attributes: Record<string, string>,
  pageNumber: number,
): string {
  return `<${name}${serializeAttributes(name, attributes, pageNumber)} />`;
}

function serializeAttributes(
  tagName: string,
  attributes: Record<string, string>,
  pageNumber: number,
): string {
  const output: string[] = [];
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (isAllowedSvgNamespaceAttribute(tagName, name)) {
      output.push(` ${name}="${escapeAttribute(rawValue)}"`);
      continue;
    }
    if (isAllowedSvgResourceAttribute(tagName, name)) {
      output.push(` ${name}="${escapeAttribute(rawValue)}"`);
      continue;
    }
    if (name.startsWith("on") || name.startsWith("xmlns") || name.includes(":")) continue;
    if (name === "style") {
      const safeStyle = sanitizeInlineStyle(rawValue);
      if (safeStyle) output.push(` style="${escapeAttribute(safeStyle)}"`);
      continue;
    }
    if (!SAFE_ATTRIBUTES.has(name) && !name.startsWith("data-")) continue;
    if ((name === "href" || name === "src") && /^\s*javascript:/iu.test(rawValue)) continue;
    if (name === "id") {
      output.push(` id="${escapeAttribute(pageScopedId(pageNumber, rawValue))}"`);
      continue;
    }
    if (name === "href" && rawValue.startsWith("#")) {
      output.push(` href="#${escapeAttribute(pageScopedId(pageNumber, rawValue.slice(1)))}"`);
      continue;
    }
    if (tagName === "a" && name === "name") {
      output.push(` id="${escapeAttribute(pageScopedId(pageNumber, rawValue))}"`);
      continue;
    }
    output.push(` ${name}="${escapeAttribute(rawValue)}"`);
  }
  return output.join("");
}

function isAllowedSvgNamespaceAttribute(tagName: string, name: string): boolean {
  return tagName === "svg" && (name === "xmlns" || name === "xmlns:xlink");
}

function isAllowedSvgResourceAttribute(tagName: string, name: string): boolean {
  return tagName === "image" && (name === "href" || name === "xlink:href");
}

function isStylesheetLink(attributes: Record<string, string>): boolean {
  return /\bstylesheet\b/iu.test(attributes.rel ?? attributes.REL ?? "");
}

function isPageBreakElement(name: string, attributes: Record<string, string>): boolean {
  const className = attributes.class ?? "";
  const style = attributes.style ?? "";
  return (
    /(?:^|\s)(?:mbppagebreak|pagebreak|page-break)(?:\s|$)/iu.test(className) ||
    /(?:page-break-before|break-before)\s*:\s*(?:always|page)/iu.test(style) ||
    name === "hr"
  );
}

function pageScopedId(pageNumber: number, id: string): string {
  return `mutsuki-p${pageNumber}-${id.replace(/[^\w.-]+/gu, "-")}`;
}

function sanitizeExecutableContent(html: string): string {
  return html
    .replace(/\s+epub:[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\s+xlink:[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\s+xmlns:[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/<script\b[\s\S]*?<\/script>/giu, "")
    .replace(
      /<(?:iframe|frame|object|embed|form)\b[\s\S]*?<\/(?:iframe|frame|object|embed|form)>/giu,
      "",
    )
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
    .replace(/\s(?:src|href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/giu, "");
}

function normalizeXhtml(html: string): string {
  return closeVoidElements(normalizeEntities(html))
    .replace(
      /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
      (_match, attributes: string, css: string) =>
        `<style${attributes}>${sanitizeCss(css)}</style>`,
    )
    .replace(
      /<span class="mutsuki-page-break"><\/span><hr \/>/giu,
      '<hr class="mutsuki-page-break" />',
    );
}

function sanitizeCss(css: string): string {
  return removeCssRule(removeCssRule(css, "@page"), "@font-face")
    .replace(/url\(\s*(["']?)[^"')]+\.(?:ttf|otf|woff2?)\1\s*\)/giu, "none")
    .replace(/(?:color|background-color)\s*:[^;}{]+;?/giu, "")
    .replace(/position\s*:\s*fixed\s*;?/giu, "")
    .trim();
}

function sanitizeInlineStyle(style: string): string {
  return sanitizeCss(style)
    .replace(/(?:^|;)\s*(?:width|height)\s*:\s*(?:100vw|100vh|[1-9]\d{3,}px)\s*;?/giu, "")
    .trim();
}

function removeCssRule(css: string, atRule: string): string {
  let output = "";
  let index = 0;
  const pattern = new RegExp(`${escapeRegex(atRule)}\\b`, "giu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    output += css.slice(index, match.index);
    const blockStart = css.indexOf("{", match.index);
    if (blockStart < 0) {
      index = match.index + match[0].length;
      continue;
    }
    const blockEnd = matchingBraceIndex(css, blockStart);
    index = blockEnd < 0 ? css.length : blockEnd + 1;
    pattern.lastIndex = index;
  }
  return output + css.slice(index);
}

function matchingBraceIndex(css: string, blockStart: number): number {
  let depth = 0;
  for (let index = blockStart; index < css.length; index += 1) {
    const character = css[index];
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractStyleBlocks(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map((match) => match[1] ?? "");
}

function normalizeCssForHash(css: string): string {
  return css
    .replace(/\s+/gu, " ")
    .replace(/\s*([{}:;,])\s*/gu, "$1")
    .trim();
}

function normalizeStylesheetBlockForHash(block: string): string {
  return block
    .replace(/\s+/gu, " ")
    .replace(/\s*=\s*/gu, "=")
    .trim()
    .toLowerCase();
}

function classWithPageBreak(className: string): string {
  const classes = new Set(className.split(/\s+/u).filter(Boolean));
  classes.add("mutsuki-page-break");
  return [...classes].join(" ");
}

function firstHeadingText(html: string): string | undefined {
  const match = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(html);
  return match ? extractVisibleText(match[1] ?? "") : undefined;
}

function containsEquivalentHeading(html: string, title: string): boolean {
  const normalizedTitle = normalizeTextForComparison(title);
  for (const match of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/giu)) {
    if (normalizeTextForComparison(extractVisibleText(match[1] ?? "")) === normalizedTitle) {
      return true;
    }
  }
  return false;
}

function meaningfulTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed || /^(?:cover|contents|table of contents|navigation)$/iu.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeTextForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function extractVisibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeEntity(match: string, entity: string | undefined): string {
  if (entity === undefined) return "&amp;";
  const body = entity.slice(0, -1);
  const lower = body.toLowerCase();
  if (/^#(?:x[0-9a-f]+|\d+)$/iu.test(body)) return `&${body};`;
  if (XML_ENTITY_NAMES[lower] !== undefined) return XML_ENTITY_NAMES[lower];
  const replacement = HTML_ENTITY_REPLACEMENTS[lower];
  return replacement === undefined ? `&amp;${body};` : replacement;
}

function escapeCdataForStyle(value: string): string {
  return value.replace(/<\/style/giu, "<\\/style");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
