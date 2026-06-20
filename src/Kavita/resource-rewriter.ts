import type { ResourceFetchResult } from "./models.js";

export interface ResourceRewriteInput {
  html: string;
  basePath: string;
  maxResourceBytes: number;
  maxChapterBytes: number;
  fetchResource: (path: string) => Promise<ResourceFetchResult | undefined>;
}

export interface ResourceRewriteResult {
  html: string;
  warnings: string[];
}

export async function rewriteHtmlResources(
  input: ResourceRewriteInput,
): Promise<ResourceRewriteResult> {
  const warnings: string[] = [];
  let html = input.html;

  html = await rewriteStylesheets(html, input, warnings);
  html = await rewriteImageAttributes(html, input, warnings);

  if (utf8ByteLength(html) > input.maxChapterBytes) {
    warnings.push("Generated chapter HTML exceeded the configured size limit.");
    html = `<p data-mutsuki-missing-resource="chapter-size-limit">Chapter exceeded configured HTML size limit.</p>`;
  }

  return { html, warnings };
}

async function rewriteStylesheets(
  html: string,
  input: ResourceRewriteInput,
  warnings: string[],
): Promise<string> {
  const stylesheetPattern = /<link\b([^>]*?)href=(["'])([^"']+)\2([^>]*?)>/giu;
  return replaceAsync(
    html,
    stylesheetPattern,
    async (_match, before: string, _quote: string, href: string, after: string) => {
      if (!/\brel=(["'])stylesheet\1/iu.test(`${before} ${after}`)) return _match;
      const path = resolveEpubPath(input.basePath, href);
      const resource = await fetchBounded(path, input, warnings);
      if (!resource) return missingResourcePlaceholder(path, "Stylesheet unavailable");
      const css = new TextDecoder().decode(resource.bytes);
      const inlined = await rewriteCssUrls(css, path, input, warnings);
      return `<style>${inlined}</style>`;
    },
  );
}

async function rewriteImageAttributes(
  html: string,
  input: ResourceRewriteInput,
  warnings: string[],
): Promise<string> {
  const imagePattern = /<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/giu;
  return replaceAsync(
    html,
    imagePattern,
    async (_match, before: string, _quote: string, src: string, after: string) => {
      const path = resolveEpubPath(input.basePath, src);
      const alt = extractAttribute(`${before} ${after}`, "alt") ?? "Image unavailable";
      const resource = await fetchBounded(path, input, warnings);
      if (!resource) return missingResourcePlaceholder(path, alt);
      const dataUrl = toDataUrl(resource);
      return `<img${before}src="${dataUrl}"${after}>`;
    },
  );
}

async function rewriteCssUrls(
  css: string,
  stylesheetPath: string,
  input: ResourceRewriteInput,
  warnings: string[],
): Promise<string> {
  const urlPattern = /url\(\s*(["']?)(?!data:|https?:|#)([^"')]+)\1\s*\)/giu;
  return replaceAsync(css, urlPattern, async (_match, _quote: string, href: string) => {
    const path = resolveEpubPath(stylesheetPath, href.trim());
    const resource = await fetchBounded(path, input, warnings);
    return resource ? `url("${toDataUrl(resource)}")` : "none";
  });
}

async function fetchBounded(
  path: string,
  input: ResourceRewriteInput,
  warnings: string[],
): Promise<ResourceFetchResult | undefined> {
  const resource = await input.fetchResource(path);
  if (!resource) {
    warnings.push(`Missing EPUB resource: ${path}`);
    return undefined;
  }

  if (resource.bytes.byteLength > input.maxResourceBytes) {
    warnings.push(`EPUB resource exceeded size limit: ${path}`);
    return undefined;
  }

  return resource;
}

function missingResourcePlaceholder(path: string, label: string): string {
  return `<span data-mutsuki-missing-resource="${escapeHtml(path)}">${escapeHtml(label)}</span>`;
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
  const match = new RegExp(`\\b${name}=(["'])(.*?)\\1`, "iu").exec(html);
  return match?.[2];
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
