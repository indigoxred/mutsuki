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
  const trimmed = bridgeUrl.trim();
  if (!trimmed) throw new Error("Missing progress bridge URL.");
  const url = new URL(trimmed);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/api/progress-events`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
