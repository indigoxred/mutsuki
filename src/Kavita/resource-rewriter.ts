import type { ResourceFetchResult } from "./models.js";

export type ResourceFetchCache = Map<string, Promise<ResourceFetchResult | undefined>>;

export interface ResourceRewriteInput {
  html: string;
  basePath: string;
  maxResourceBytes: number;
  maxChapterBytes: number;
  fetchResource: (path: string) => Promise<ResourceFetchResult | undefined>;
  resourceCache?: ResourceFetchCache;
  resourceBudget?: ChapterResourceBudget;
}

export interface ChapterResourceBudget {
  limitBytes: number;
  baseDocumentBytes: number;
  reservedResourceBytes: number;
  inlinedResourceCount: number;
  inlinedResourceBytes: number;
  omittedImageCount: number;
  omittedCssAssetCount: number;
  sizeLimitHit: boolean;
}

export interface ResourceRewriteStats {
  missingResourceCount: number;
  missingStylesheetCount: number;
  rewrittenHtmlImageCount: number;
  rewrittenSvgImageCount: number;
  unresolvedNamespacePrefixCount: number;
  sizeLimitHit: boolean;
  inlinedResourceCount: number;
  inlinedResourceBytes: number;
  omittedImageCount: number;
  omittedCssAssetCount: number;
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
  budget: ChapterResourceBudget;
}

const MAX_CSS_IMPORT_DEPTH = 8;
const DATA_URL_PREFIX_BYTES = "data:;base64,".length;
const DEFAULT_BUDGET_SAFETY_MARGIN_BYTES = 16_384;

export async function rewriteHtmlResources(
  input: ResourceRewriteInput,
): Promise<ResourceRewriteResult> {
  const context: RewriteContext = {
    input,
    warnings: [],
    stats: emptyStats(),
    resourceCache: input.resourceCache ?? new Map(),
    missingStylesheetPaths: new Set(),
    budget:
      input.resourceBudget ??
      createChapterResourceBudget(input.maxChapterBytes, utf8ByteLength(input.html)),
  };
  let html = input.html;

  html = await rewriteHtmlImageElements(html, context);
  html = await rewriteSvgImageWrappers(html, context);
  html = await rewriteStylesheets(html, context);
  html = await rewriteInlineStyleBlocks(html, context);

  context.stats.unresolvedNamespacePrefixCount = countUnresolvedNamespacePrefixes(html);
  return { html, warnings: context.warnings, stats: context.stats };
}

export function createChapterResourceBudget(
  limitBytes: number,
  baseDocumentBytes: number,
): ChapterResourceBudget {
  const safeLimit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 8_000_000;
  const safeBase = Math.max(0, Number.isFinite(baseDocumentBytes) ? baseDocumentBytes : 0);
  return {
    limitBytes: safeLimit,
    baseDocumentBytes: safeBase,
    reservedResourceBytes: Math.min(
      safeLimit,
      safeBase + Math.min(DEFAULT_BUDGET_SAFETY_MARGIN_BYTES, Math.floor(safeLimit * 0.05)),
    ),
    inlinedResourceCount: 0,
    inlinedResourceBytes: 0,
    omittedImageCount: 0,
    omittedCssAssetCount: 0,
    sizeLimitHit: false,
  };
}

function emptyStats(): ResourceRewriteStats {
  return {
    missingResourceCount: 0,
    missingStylesheetCount: 0,
    rewrittenHtmlImageCount: 0,
    rewrittenSvgImageCount: 0,
    unresolvedNamespacePrefixCount: 0,
    sizeLimitHit: false,
    inlinedResourceCount: 0,
    inlinedResourceBytes: 0,
    omittedImageCount: 0,
    omittedCssAssetCount: 0,
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
    if (isFontResourcePath(path)) {
      context.stats.omittedCssAssetCount += 1;
      context.budget.omittedCssAssetCount += 1;
      return "none";
    }
    const resource = await fetchBounded(path, context);
    if (!resource || isFontResource(resource, path)) return "none";
    const dataUrl = reserveDataUrl(resource, context, "css", 'url("")'.length);
    return dataUrl ? `url("${dataUrl}")` : "none";
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

      const dataUrl = reserveDataUrl(resource, context, "image", svgImageMarkupOverheadBytes());
      if (!dataUrl) {
        return omittedIllustrationPlaceholder(imageAltText(svgAttributes, imageAttributes));
      }

      context.stats.rewrittenSvgImageCount += 1;
      return svgImageToXhtmlImage(dataUrl, svgAttributes, imageAttributes);
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
        const dataUrl = reserveDataUrl(resource, context, "image", attributes.length + 32);
        if (!dataUrl) {
          return omittedIllustrationPlaceholder(extractAttribute(attributes, "alt") ?? "");
        }
        attributes = setAttribute(attributes, "src", dataUrl);
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
    if (resource) {
      const dataUrl = reserveDataUrl(resource, context, "image", candidate.length + 16);
      if (dataUrl) {
        candidates.push(`${dataUrl}${match[2] ?? ""}`);
      }
    }
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

export function omittedIllustrationPlaceholder(label: string): string {
  const suffix = label.trim() ? ` ${escapeHtml(label.trim())}` : "";
  return `<span class="mutsuki-omitted-illustration" data-mutsuki-omitted-resource="size-limit">Illustration omitted because the chapter size limit was reached.${suffix}</span>`;
}

function svgImageToXhtmlImage(
  dataUrl: string,
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
    `<img src="${escapeAttribute(dataUrl)}"`,
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

function reserveDataUrl(
  resource: ResourceFetchResult,
  context: RewriteContext,
  kind: "image" | "css",
  outputMarkupOverheadBytes: number,
): string | undefined {
  const projectedBytes = projectedDataUrlByteLength(resource) + outputMarkupOverheadBytes;
  if (context.budget.reservedResourceBytes + projectedBytes > context.budget.limitBytes) {
    context.budget.sizeLimitHit = true;
    context.stats.sizeLimitHit = true;
    if (kind === "image") {
      context.stats.omittedImageCount += 1;
      context.budget.omittedImageCount += 1;
    } else {
      context.stats.omittedCssAssetCount += 1;
      context.budget.omittedCssAssetCount += 1;
    }
    return undefined;
  }

  context.budget.reservedResourceBytes += projectedBytes;
  context.budget.inlinedResourceCount += 1;
  context.budget.inlinedResourceBytes += projectedBytes;
  context.stats.inlinedResourceCount += 1;
  context.stats.inlinedResourceBytes += projectedBytes;
  return toDataUrl(resource);
}

function projectedDataUrlByteLength(resource: ResourceFetchResult): number {
  return (
    DATA_URL_PREFIX_BYTES +
    (resource.mimeType || "application/octet-stream").length +
    4 * Math.ceil(resource.bytes.byteLength / 3)
  );
}

function svgImageMarkupOverheadBytes(): number {
  return '<img src="" alt="" class="kavita-scale-width" />'.length + 48;
}

function isFontResource(resource: ResourceFetchResult, path: string): boolean {
  return resource.mimeType.toLowerCase().startsWith("font/") || isFontResourcePath(path);
}

function isFontResourcePath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?)$/iu.test(path);
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
