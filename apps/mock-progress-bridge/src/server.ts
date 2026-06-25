import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { parseMockProgressEvent, type MockProgressEvent } from "./events.js";
import {
  createJsonlProgressEventStore,
  createMemoryProgressEventStore,
  type ProgressEventStore,
} from "./storage.js";

export { createMemoryProgressEventStore, createJsonlProgressEventStore };

export interface MockProgressBridgeOptions {
  store: ProgressEventStore;
  token?: string;
}

export function createMockProgressBridgeServer(options: MockProgressBridgeOptions): Server {
  return createServer(async (request, response) => {
    try {
      await routeRequest(request, response, options);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unexpected server error.",
      });
    }
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: MockProgressBridgeOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/progress-events") {
    sendJson(response, 200, { events: await options.store.list() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/progress-events") {
    if (!isAuthorized(request, options.token)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }
    const payload = JSON.parse(await readBody(request)) as unknown;
    const event = parseMockProgressEvent(payload);
    await options.store.append(event);
    sendJson(response, 202, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, await renderHome(options.store));
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function isAuthorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

async function renderHome(store: ProgressEventStore): Promise<string> {
  const events = await store.list(50);
  const rows = events.map(eventRow).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mutsuki Progress Bridge</title>
  <style>
    :root { color-scheme: dark light; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #111827; color: #f9fafb; }
    main { max-width: 1200px; margin: 0 auto; }
    table { width: 100%; border-collapse: collapse; background: #1f2937; }
    th, td { padding: 10px; border-bottom: 1px solid #374151; text-align: left; }
    th { color: #c7d2fe; font-size: 0.85rem; text-transform: uppercase; }
    code { color: #fbbf24; }
  </style>
</head>
<body>
  <main>
    <h1>Mutsuki Progress Bridge</h1>
    <p>Received ${events.length} recent Paperback read event${events.length === 1 ? "" : "s"}.</p>
    <table>
      <thead>
        <tr>
          <th>Received</th>
          <th>Source</th>
          <th>Series</th>
          <th>Chapter</th>
          <th>Kind</th>
          <th>Marked Kavita</th>
          <th>Paperback ID</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="7">No read events yet.</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function eventRow(event: MockProgressEvent): string {
  const source = event.chapterSourceId ?? (event.kavitaSeriesId ? "Kavita" : event.source);
  const series = displaySeries(event);
  const chapter = displayChapter(event);
  return `<tr>
    <td>${escapeHtml(event.receivedAt)}</td>
    <td>${escapeHtml(source)}</td>
    <td>${escapeHtml(series)}</td>
    <td>${escapeHtml(chapter)}</td>
    <td>${escapeHtml(event.chapterKind)}</td>
    <td>${event.kavitaMarkedRead ? "yes" : "no"}</td>
    <td><code>${escapeHtml(event.paperbackChapterId)}</code></td>
  </tr>`;
}

function displaySeries(event: MockProgressEvent): string {
  if (event.sourceTitle?.trim()) return event.sourceTitle.trim();
  if (event.trackedTitle?.trim()) return event.trackedTitle.trim();
  if (event.kavitaSeriesId !== undefined) return `Kavita series ${event.kavitaSeriesId}`;
  return event.chapterMangaId ?? event.mangaId;
}

function displayChapter(event: MockProgressEvent): string {
  const number = displayChapterNumber(event);
  const title = event.title.trim();
  if (!title) return number;
  if (isRedundantChapterTitle(title, event.chapterNum)) return number;
  return `${number} - ${title}`;
}

function displayChapterNumber(event: MockProgressEvent): string {
  const chapter = `Ch. ${formatProgressNumber(event.chapterNum)}`;
  if (event.chapterVolume !== undefined && event.chapterVolume > 0) {
    return `Vol. ${formatProgressNumber(event.chapterVolume)}, ${chapter}`;
  }
  return chapter;
}

function formatProgressNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/u, "");
}

function isRedundantChapterTitle(title: string, chapterNum: number): boolean {
  const number = formatProgressNumber(chapterNum).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^(?:ch\\.?|chapter)\\s*${number}$`, "iu").test(title.trim());
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

if (process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 8080);
  const dataPath = process.env.MUTSUKI_BRIDGE_DATA ?? "/data/events.jsonl";
  const token = process.env.MUTSUKI_BRIDGE_TOKEN || undefined;
  const store =
    process.env.MUTSUKI_BRIDGE_MEMORY === "true"
      ? createMemoryProgressEventStore()
      : createJsonlProgressEventStore(dataPath);
  createMockProgressBridgeServer({ store, token }).listen(port, () => {
    console.log(`Mutsuki mock progress bridge listening on http://0.0.0.0:${port}`);
  });
}
