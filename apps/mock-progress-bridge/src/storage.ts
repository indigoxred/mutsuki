import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { MockProgressEvent } from "./events.js";

export interface ProgressEventStore {
  append(event: MockProgressEvent): Promise<void>;
  list(limit?: number): Promise<MockProgressEvent[]>;
}

export function createMemoryProgressEventStore(): ProgressEventStore {
  const events: MockProgressEvent[] = [];
  return {
    async append(event) {
      events.push(event);
    },
    async list(limit = 100) {
      return events.slice(-limit).reverse();
    },
  };
}

export function createJsonlProgressEventStore(filePath: string): ProgressEventStore {
  return {
    async append(event) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    },
    async list(limit = 100) {
      const text = await readFile(filePath, "utf8").catch(() => "");
      return text
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(-limit)
        .reverse()
        .map((line) => JSON.parse(line) as MockProgressEvent);
    },
  };
}
