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
      "<!doctype html>",
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
    .replace(/&nbsp;/giu, " ")
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
