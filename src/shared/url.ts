export function normalizeKavitaBaseUrl(input: string): string {
  const url = parseHttpUrl(input);
  if (url.protocol !== "http" && url.protocol !== "https") {
    throw new Error("Kavita URL must use http or https.");
  }

  const path = normalizeBasePath(url.path);

  return `${url.protocol}://${url.host}${path}`;
}

export function toKavitaApiUrl(
  baseUrl: string,
  apiPath: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalized = normalizeKavitaBaseUrl(baseUrl);
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const queryString = toQueryString(query);
  return `${normalized}/api${path}${queryString}`;
}

export function isSameOrigin(baseUrl: string, targetUrl: string): boolean {
  const base = parseHttpUrl(normalizeKavitaBaseUrl(baseUrl));
  const target = parseHttpUrl(targetUrl);
  return base.protocol === target.protocol && base.host === target.host;
}

export function assertSameOrigin(baseUrl: string, targetUrl: string): void {
  if (!isSameOrigin(baseUrl, targetUrl)) {
    throw new Error("Refusing to send Kavita credentials to another host.");
  }
}

interface ParsedHttpUrl {
  protocol: string;
  host: string;
  path: string;
}

function parseHttpUrl(input: string): ParsedHttpUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Kavita URL is required.");
  }

  const match =
    /^(?<protocol>[a-z][a-z0-9+.-]*):\/\/(?<host>[^/?#\s]+)(?<path>\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#[^\s]*)?$/iu.exec(
      trimmed,
    );
  const groups = match?.groups;
  if (!groups?.protocol || !groups.host) {
    throw new Error("Invalid Kavita URL.");
  }

  return {
    protocol: groups.protocol.toLowerCase(),
    host: groups.host.toLowerCase(),
    path: groups.path ?? "",
  };
}

function normalizeBasePath(path: string): string {
  let normalized = path.replace(/\/+$/u, "");
  normalized = normalized.replace(/\/api$/iu, "");
  return normalized === "/" ? "" : normalized;
}

function toQueryString(query?: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    },
  );
  if (entries.length === 0) return "";
  return `?${entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&")}`;
}
