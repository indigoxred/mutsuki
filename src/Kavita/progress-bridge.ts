import type { KavitaProgressBridgeEvent } from "./progress.js";

export interface ProgressBridgeRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface ProgressBridgeResponse {
  status: number;
}

export type ProgressBridgeTransport = (
  request: ProgressBridgeRequest,
) => Promise<ProgressBridgeResponse>;

export async function sendProgressBridgeEvent(input: {
  bridgeUrl: string;
  token?: string;
  event: KavitaProgressBridgeEvent;
  transport: ProgressBridgeTransport;
}): Promise<void> {
  const url = progressEventsEndpoint(input.bridgeUrl);
  const response = await input.transport({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify(input.event),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Progress bridge rejected read event with status ${response.status}.`);
  }
}

export function progressEventsEndpoint(bridgeUrl: string): string {
  const url = parseBridgeUrl(bridgeUrl);
  const path = url.path.replace(/\/+$/u, "");
  return `${url.protocol}://${url.host}${path}/api/progress-events`;
}

interface ParsedBridgeUrl {
  protocol: "http" | "https";
  host: string;
  path: string;
}

function parseBridgeUrl(input: string): ParsedBridgeUrl {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Missing progress bridge URL.");
  const match =
    /^(?<protocol>https?):\/\/(?<host>[^/?#\s]+)(?<path>\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#[^\s]*)?$/iu.exec(
      trimmed,
    );
  const groups = match?.groups;
  if (!groups?.protocol || !groups.host) {
    throw new Error("Invalid progress bridge URL.");
  }
  return {
    protocol: groups.protocol.toLowerCase() as "http" | "https",
    host: groups.host.toLowerCase(),
    path: groups.path ?? "",
  };
}
