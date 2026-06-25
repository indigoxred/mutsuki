import type { KavitaProgressBridgeEvent } from "./progress.js";
import {
  sendProgressBridgeEvent as sendSharedProgressBridgeEvent,
  type ProgressBridgeTransport,
} from "../shared/progress-bridge.js";

export {
  progressEventsEndpoint,
  type ProgressBridgeRequest,
  type ProgressBridgeResponse,
} from "../shared/progress-bridge.js";

export async function sendProgressBridgeEvent(input: {
  bridgeUrl: string;
  token?: string;
  event: KavitaProgressBridgeEvent;
  transport: ProgressBridgeTransport;
}): Promise<void> {
  await sendSharedProgressBridgeEvent(input);
}

export type { ProgressBridgeTransport };
