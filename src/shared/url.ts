export function normalizeKavitaBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Kavita URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid Kavita URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Kavita URL must use http or https.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = url.pathname.replace(/\/api$/iu, "");
  if (url.pathname === "/") {
    url.pathname = "";
  }

  return url.toString().replace(/\/$/u, "");
}

export function toKavitaApiUrl(
  baseUrl: string,
  apiPath: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalized = normalizeKavitaBaseUrl(baseUrl);
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const url = new URL(`${normalized}/api${path}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export function isSameOrigin(baseUrl: string, targetUrl: string): boolean {
  const base = new URL(normalizeKavitaBaseUrl(baseUrl));
  const target = new URL(targetUrl);
  return base.protocol === target.protocol && base.host === target.host;
}

export function assertSameOrigin(baseUrl: string, targetUrl: string): void {
  if (!isSameOrigin(baseUrl, targetUrl)) {
    throw new Error("Refusing to send Kavita credentials to another host.");
  }
}
