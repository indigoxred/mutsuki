import type { ResourceFetchResult } from "./models.js";

export type ResourceFetchCache = Map<string, Promise<ResourceFetchResult | undefined>>;

export interface ResourceRewriteInput {
  html: string;
  basePath: string;
  maxResourceBytes: number;
  maxChapterBytes: number;
  fetchResource: (path: string) => Promise<ResourceFetchResult | undefined>;
  resourceCache?: ResourceFetchCache;
}

export interface ResourceRewriteStats {
  missingResourceCount: number;
  missingStylesheetCount: number;
  rewrittenHtmlImageCount: number;
  rewrittenSvgImageCount: number;
  unresolvedNamespacePrefixCount: number;
}

export interface ResourceRewriteResult {
  html: string;
  warnings: string[];
  stats: ResourceRewriteStats;
}

interface RewriteContext {
  input: ResourceRewriteInput;
  warnings: string[];
  stats: ResourceRewriteStats;
  resourceCache: ResourceFetchCache;
  missingStylesheetPaths: Set<string>;
}

const MAX_CSS_IMPORT_DEPTH = 8;

export async function rewriteHtmlResources(
  input: ResourceRewriteInput,
): Promise<ResourceRewriteResult> {
  const context: RewriteContext = {
    input,
    warnings: [],
    stats: emptyStats(),
    resourceCache: input.resourceCache ?? new Map(),
    missingStylesheetPaths: new Set(),
  };
  let html = input.html;

  html = await rewriteStylesheets(html, context);
  html = await rewriteInlineStyleBlocks(html, context);
  html = await rewriteSvgImageWrappers(html, context);
  html = await rewriteHtmlImageElements(html, context);

  if (utf8ByteLength(html) > input.maxChapterBytes) {
    context.warnings.push("Generated chapter HTML exceeded the configured size limit.");
    html = `<p data-mutsuki-missing-resource="chapter-size-limit">Chapter exceeded configured HTML size limit.</p>`;
  }

  context.stats.unresolvedNamespacePrefixCount = countUnresolvedNamespacePrefixes(html);
  return { html, warnings: context.warnings, stats: context.stats };
}

function emptyStats(): ResourceRewriteStats {
  return {
    missingResourceCount: 0,
    missingStylesheetCount: 0,
    rewrittenHtmlImageCount: 0,
    rewrittenSvgImageCount: 0,
    unresolvedNamespacePrefixCount: 0,
  };
}

async function rewriteStylesheets(html: string, context: RewriteContext): Promise<string> {
  const stylesheetPattern = /<link\b([^>]*)>/giu;
  return replaceAsync(html, stylesheetPattern, async (match: string, attributes: string) => {
    const href = extractAttribute(attributes, "href");
    if (!href || !/\bstylesheet\b/iu.test(extractAttribute(attributes, "rel") ?? "")) return match;

    const path = resolveFetchableResourcePath(context.input.basePath, href);
    if (path === undefined) return match;

    const resource = await fetchBounded(path, context);
    if (!resource) {
      recordMissingStylesheet(path, context);
      return "";
    }

    const css = new TextDecoder().decode(resource.bytes);
    const inlined = await rewriteCss(css, path, context, 0, new Set([path]));
    return `<style>${inlined}</style>`;
  });
}

async function rewriteInlineStyleBlocks(html: string, context: RewriteContext): Promise<string> {
  const stylePattern = /<style\b([^>]*)>([\s\S]*?)<\/style>/giu;
  return replaceAsync(
    html,
    stylePattern,
    async (_match: string, attributes: string, css: string) =>
      `<style${attributes}>${await rewriteCss(css, context.input.basePath, context, 0, new Set())}</style>`,
  );
}

async function rewriteCss(
  css: string,
  stylesheetPath: string,
  context: RewriteContext,
  depth: number,
  importStack: Set<string>,
): Promise<string> {
  const withoutImports = await rewriteCssImports(css, stylesheetPath, context, depth, importStack);
  return rewriteCssUrls(withoutImports, stylesheetPath, context);
}

async function rewriteCssImports(
  css: string,
  stylesheetPath: string,
  context: RewriteContext,
  depth: number,
  importStack: Set<string>,
): Promise<string> {
  const importPattern = /@import\s+(?:url\(\s*)?(?:(["'])([^"']+)\1|([^"')\s;]+))\s*\)?[^;]*;/giu;
  return replaceAsync(
    css,
    importPattern,
    async (match: string, _quote: string, quotedHref: string, unquotedHref: string) => {
      const href = (quotedHref || unquotedHref || "").trim();
      const path = resolveFetchableResourcePath(stylesheetPath, href);
      if (path === undefined) return match;

      if (depth >= MAX_CSS_IMPORT_DEPTH || importStack.has(path)) {
        context.warnings.push(`Skipped cyclic or deeply nested EPUB CSS import: ${path}`);
        return "";
      }

      const resource = await fetchBounded(path, context);
      if (!resource) {
        recordMissingStylesheet(path, context);
        return "";
      }

      const nextStack = new Set(importStack);
      nextStack.add(path);
      return rewriteCss(
        new TextDecoder().decode(resource.bytes),
        path,
        context,
        depth + 1,
        nextStack,
      );
    },
  );
}

async function rewriteCssUrls(
  css: string,
  stylesheetPath: string,
  context: RewriteContext,
): Promise<string> {
  const urlPattern = /url\(\s*(["']?)(?!data:|#)([^"')]+)\1\s*\)/giu;
  return replaceAsync(css, urlPattern, async (match: string, _quote: string, href: string) => {
    const path = resolveFetchableResourcePath(stylesheetPath, href.trim());
    if (path === undefined) return match;
    const resource = await fetchBounded(path, context);
    return resource ? `url("${toDataUrl(resource)}")` : "none";
  });
}

async function rewriteSvgImageWrappers(html: string, context: RewriteContext): Promise<string> {
  const svgPattern = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/giu;
  return replaceAsync(
    html,
    svgPattern,
    async (match: string, svgAttributes: string, body: string) => {
      const imageMatch = /<image\b([^>]*)>/iu.exec(body);
      if (!imageMatch?.[1]) return match.includes("xlink:") ? "" : match;

      const imageAttributes = imageMatch[1];
      const href =
        extractAttribute(imageAttributes, "xlink:href") ??
        extractAttribute(imageAttributes, "href");
      if (!href) return match.includes("xlink:") ? "" : match;

      const path = resolveFetchableResourcePath(context.input.basePath, href);
      if (path === undefined) {
        return missingResourcePlaceholder(
          "svg-image",
          imageAltText(svgAttributes, imageAttributes),
        );
      }

      const resource = await fetchBounded(path, context);
      if (!resource) {
        return missingResourcePlaceholder(path, imageAltText(svgAttributes, imageAttributes));
      }

      context.stats.rewrittenSvgImageCount += 1;
      return svgImageToXhtmlImage(resource, svgAttributes, imageAttributes);
    },
  );
}

async function rewriteHtmlImageElements(html: string, context: RewriteContext): Promise<string> {
  const imagePattern = /<img\b([^>]*)>/giu;
  return replaceAsync(html, imagePattern, async (match: string, originalAttributes: string) => {
    let attributes = originalAttributes;
    let rewritten = false;

    const src = extractAttribute(attributes, "src");
    if (src) {
      const path = resolveFetchableResourcePath(context.input.basePath, src);
      if (path !== undefined) {
        const resource = await fetchBounded(path, context);
        if (!resource) {
          return missingResourcePlaceholder(
            path,
            extractAttribute(attributes, "alt") ?? "Image unavailable",
          );
        }
        attributes = setAttribute(attributes, "src", toDataUrl(resource));
        rewritten = true;
      }
    }

    const srcset = extractAttribute(attributes, "srcset");
    if (srcset) {
      const rewrittenSrcset = await rewriteSrcset(srcset, context);
      if (rewrittenSrcset.rewritten) {
        rewritten = true;
        attributes =
          rewrittenSrcset.value === undefined
            ? removeAttribute(attributes, "srcset")
            : setAttribute(attributes, "srcset", rewrittenSrcset.value);
      }
    }

    if (rewritten) context.stats.rewrittenHtmlImageCount += 1;
    return rewritten ? `<img${attributes}>` : match;
  });
}

async function rewriteSrcset(
  srcset: string,
  context: RewriteContext,
): Promise<{ value: string | undefined; rewritten: boolean }> {
  const candidates: string[] = [];
  let rewritten = false;

  for (const rawCandidate of srcset.split(",")) {
    const candidate = rawCandidate.trim();
    if (!candidate) continue;
    const match = /^(\S+)(.*)$/u.exec(candidate);
    const href = match?.[1];
    if (!href) continue;

    const path = resolveFetchableResourcePath(context.input.basePath, href);
    if (path === undefined) {
      candidates.push(candidate);
      continue;
    }

    rewritten = true;
    const resource = await fetchBounded(path, context);
    if (resource) candidates.push(`${toDataUrl(resource)}${match[2] ?? ""}`);
  }

  return { value: candidates.length > 0 ? candidates.join(", ") : undefined, rewritten };
}

async function fetchBounded(
  path: string,
  context: RewriteContext,
): Promise<ResourceFetchResult | undefined> {
  let promise = context.resourceCache.get(path);
  if (!promise) {
    promise = context.input.fetchResource(path).then((resource) => {
      if (!resource) {
        context.stats.missingResourceCount += 1;
        context.warnings.push(`Missing EPUB resource: ${path}`);
        return undefined;
      }

      if (resource.bytes.byteLength > context.input.maxResourceBytes) {
        context.stats.missingResourceCount += 1;
        context.warnings.push(`EPUB resource exceeded size limit: ${path}`);
        return undefined;
      }

      return resource;
    });
    context.resourceCache.set(path, promise);
  }
  return promise;
}

function recordMissingStylesheet(path: string, context: RewriteContext): void {
  if (context.missingStylesheetPaths.has(path)) return;
  context.missingStylesheetPaths.add(path);
  context.stats.missingStylesheetCount += 1;
}

function missingResourcePlaceholder(path: string, label: string): string {
  return `<span data-mutsuki-missing-resource="${escapeAttribute(path)}">${escapeHtml(label)}</span>`;
}

function svgImageToXhtmlImage(
  resource: ResourceFetchResult,
  svgAttributes: string,
  imageAttributes: string,
): string {
  const className =
    extractAttribute(imageAttributes, "class") ??
    extractAttribute(svgAttributes, "class") ??
    "kavita-scale-width";
  const width =
    extractAttribute(imageAttributes, "width") ?? extractAttribute(svgAttributes, "width");
  const height =
    extractAttribute(imageAttributes, "height") ?? extractAttribute(svgAttributes, "height");
  return [
    `<img src="${toDataUrl(resource)}"`,
    ` alt="${escapeAttribute(imageAltText(svgAttributes, imageAttributes))}"`,
    className ? ` class="${escapeAttribute(className)}"` : "",
    width ? ` width="${escapeAttribute(width)}"` : "",
    height ? ` height="${escapeAttribute(height)}"` : "",
    " />",
  ].join("");
}

function imageAltText(svgAttributes: string, imageAttributes: string): string {
  return (
    extractAttribute(imageAttributes, "alt") ??
    extractAttribute(svgAttributes, "aria-label") ??
    extractAttribute(svgAttributes, "title") ??
    ""
  );
}

function resolveFetchableResourcePath(basePath: string, href: string): string | undefined {
  const kavitaResourcePath = extractKavitaBookResourceFile(href);
  if (kavitaResourcePath !== undefined) return kavitaResourcePath;
  if (isExternalOrSpecialUrl(href)) return undefined;
  return resolveEpubPath(basePath, href);
}

function extractKavitaBookResourceFile(href: string): string | undefined {
  const withoutHash = href.split("#")[0] ?? "";
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return undefined;

  const path = withoutHash.slice(0, queryIndex);
  if (!/\/book\/\d+\/book-resources$/iu.test(path)) return undefined;

  const query = withoutHash.slice(queryIndex + 1);
  for (const part of query.split("&")) {
    const [rawName = "", rawValue = ""] = part.split("=");
    if (decodeQueryComponent(rawName) === "file") {
      return decodeQueryComponent(rawValue);
    }
  }
  return undefined;
}

function isExternalOrSpecialUrl(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(href.trim());
}

function resolveEpubPath(basePath: string, relativePath: string): string {
  const cleanRelative = decodeURI(relativePath.split("#")[0]?.split("?")[0] ?? "").replace(
    /\\/gu,
    "/",
  );
  if (cleanRelative.startsWith("/")) return cleanRelative.replace(/^\/+/u, "");

  const baseParts = basePath.replace(/\\/gu, "/").split("/");
  baseParts.pop();
  for (const part of cleanRelative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join("/");
}

function toDataUrl(resource: ResourceFetchResult): string {
  return `data:${resource.mimeType || "application/octet-stream"};base64,${arrayBufferToBase64(resource.bytes)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    output += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return output;
}

function extractAttribute(html: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${escapeRegex(name)}\\s*=\\s*(["'])(.*?)\\1`, "iu").exec(html);
  return match?.[2];
}

function setAttribute(attributes: string, name: string, value: string): string {
  const pattern = new RegExp(`(^|\\s)${escapeRegex(name)}\\s*=\\s*(["'])(.*?)\\2`, "iu");
  if (pattern.test(attributes)) {
    return attributes.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${name}="${escapeAttribute(value)}"`,
    );
  }
  return `${attributes} ${name}="${escapeAttribute(value)}"`;
}

function removeAttribute(attributes: string, name: string): string {
  return attributes.replace(
    new RegExp(`(^|\\s)${escapeRegex(name)}\\s*=\\s*(["'])(.*?)\\2`, "giu"),
    "$1",
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function decodeQueryComponent(value: string): string {
  return decodeURIComponent(value.replace(/\+/gu, " "));
}

function countUnresolvedNamespacePrefixes(html: string): number {
  return html.match(/\b(?:epub|xlink):[\w-]+/giu)?.length ?? 0;
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const replacements: Promise<string>[] = [];
  input.replace(pattern, (...args: string[]) => {
    replacements.push(replacer(...args));
    return "";
  });

  const resolved = await Promise.all(replacements);
  let index = 0;
  return input.replace(pattern, () => resolved[index++] ?? "");
}
