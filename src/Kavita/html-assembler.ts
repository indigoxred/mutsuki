export interface AssembleHtmlChapterInput {
  title: string;
  pages: string[];
  rewriteResources: (fragment: string) => Promise<string>;
}

const VOID_TAGS = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";
const VOID_TAG_PATTERN = new RegExp(`<(${VOID_TAGS})(\\s[^>]*?)?>`, "giu");
const VOID_CLOSING_TAG_PATTERN = new RegExp(`</(?:${VOID_TAGS})\\s*>`, "giu");

export async function assembleHtmlChapter(input: AssembleHtmlChapterInput): Promise<string> {
  const rewrittenPages: string[] = [];
  for (const page of input.pages) {
    rewrittenPages.push(
      normalizeXhtml(await input.rewriteResources(sanitizeExecutableContent(rewriteAnchors(page)))),
    );
  }

  return normalizeXhtml(
    [
      '<html xmlns="http://www.w3.org/1999/xhtml">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(input.title)}</title>`,
      "<style>body{line-height:1.65;margin:0;padding:1rem;}img{max-width:100%;height:auto;}table{max-width:100%;}</style>",
      "</head>",
      "<body>",
      ...rewrittenPages,
      "</body>",
      "</html>",
    ].join(""),
  );
}

function sanitizeExecutableContent(html: string): string {
  return html
    .replace(/\s+epub:[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, "")
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
  return html
    .replace(/\u00a0/gu, " ")
    .replace(/&(#x[0-9a-f]+;|#\d+;|[a-z][a-z0-9]+;)?/giu, normalizeEntity)
    .replace(
      /<style\b([^>]*)>([\s\S]*?)<\/style>/giu,
      (_match, attributes: string, css: string) =>
        `<style${attributes}>${removePageRules(css)}</style>`,
    )
    .replace(VOID_TAG_PATTERN, (match: string, tag: string, attributes = "") => {
      if (/\/\s*>$/u.test(match)) return match;
      return `<${tag}${attributes} />`;
    })
    .replace(VOID_CLOSING_TAG_PATTERN, "");
}

function rewriteAnchors(html: string): string {
  return html
    .replace(
      /\bid=(["'])([^"']+)\1/giu,
      (_match, quote: string, id: string) => `id=${quote}mutsuki-${id}${quote}`,
    )
    .replace(
      /\bhref=(["'])#([^"']+)\1/giu,
      (_match, quote: string, id: string) => `href=${quote}#mutsuki-${id}${quote}`,
    );
}

const XML_ENTITY_NAMES: Record<string, string> = {
  amp: "&amp;",
  apos: "&apos;",
  gt: "&gt;",
  lt: "&lt;",
  quot: "&quot;",
};

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

function normalizeEntity(match: string, entity: string | undefined): string {
  if (entity === undefined) return "&amp;";
  const body = entity.slice(0, -1);
  const lower = body.toLowerCase();
  if (/^#(?:x[0-9a-f]+|\d+)$/iu.test(body)) return `&${body};`;
  if (XML_ENTITY_NAMES[lower] !== undefined) return XML_ENTITY_NAMES[lower];
  const replacement = HTML_ENTITY_REPLACEMENTS[lower];
  return replacement === undefined ? `&amp;${body};` : replacement;
}

function removePageRules(css: string): string {
  let output = "";
  let index = 0;
  const pageRulePattern = /@page\b/giu;
  let match: RegExpExecArray | null;
  while ((match = pageRulePattern.exec(css)) !== null) {
    output += css.slice(index, match.index);
    const blockStart = css.indexOf("{", match.index);
    if (blockStart < 0) {
      index = match.index + match[0].length;
      continue;
    }
    const blockEnd = matchingBraceIndex(css, blockStart);
    index = blockEnd < 0 ? css.length : blockEnd + 1;
    pageRulePattern.lastIndex = index;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
