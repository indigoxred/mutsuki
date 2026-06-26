import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { createKavitaClient, createMalClient } from "./clients.js";
import { bridgeConfigFromEnv } from "./config.js";
import { runBridgeSyncOnce, type BridgeSyncResult } from "./sync.js";
import { SqliteBridgeStore } from "./storage.js";

export interface KavitaMalBridgeServerOptions {
  store: SqliteBridgeStore;
  dryRun: boolean;
  runSync: () => Promise<BridgeSyncResult>;
}

export function createKavitaMalBridgeServer(options: KavitaMalBridgeServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/") {
        await respondHtml(response, await renderHome(options));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        await respondJson(response, {
          dryRun: options.dryRun,
          mappings: (await options.store.listSeriesMappings()).length,
          unresolved: (await options.store.listReviews()).length,
          audit: (await options.store.listAuditLogs(25)).slice(0, 10),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/unresolved-matches") {
        await respondJson(response, { items: await options.store.listReviews() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/audit-log") {
        await respondJson(response, { items: await options.store.listAuditLogs(100) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sync/run") {
        await respondJson(response, await options.runSync());
        return;
      }
      await respondJson(response, { error: "Not found." }, 404);
    } catch (error) {
      await respondJson(
        response,
        { error: error instanceof Error ? sanitize(error.message) : "Unexpected bridge error." },
        500,
      );
    }
  });
}

async function renderHome(options: KavitaMalBridgeServerOptions): Promise<string> {
  const [mappings, reviews, audit] = await Promise.all([
    options.store.listSeriesMappings(),
    options.store.listReviews(),
    options.store.listAuditLogs(20),
  ]);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mutsuki Kavita MAL Bridge</title>
  <style>
    body { background: #111827; color: #f9fafb; font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }
    th, td { border-bottom: 1px solid #374151; padding: 0.6rem; text-align: left; vertical-align: top; }
    th { color: #bfdbfe; font-size: 0.85rem; text-transform: uppercase; }
    code { color: #fde68a; }
    .muted { color: #cbd5e1; }
  </style>
</head>
<body>
  <h1>Mutsuki Kavita MAL Bridge</h1>
  <p class="muted">Mode: <strong>${options.dryRun ? "dry-run" : "live MAL writes"}</strong></p>
  <h2>Mappings</h2>
  <p>${mappings.length} linked Kavita series.</p>
  <h2>Unresolved Matches</h2>
  <table>
    <thead><tr><th>Kavita Series</th><th>Title</th><th>Reason</th></tr></thead>
    <tbody>${reviews.map((review) => `<tr><td>${review.kavitaSeriesId}</td><td>${escapeHtml(review.title)}</td><td>${escapeHtml(review.reason)}</td></tr>`).join("")}</tbody>
  </table>
  <h2>Recent Audit</h2>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Series</th><th>Message</th></tr></thead>
    <tbody>${audit.map((entry) => `<tr><td>${escapeHtml(entry.createdAt)}</td><td>${escapeHtml(entry.type)}</td><td>${entry.kavitaSeriesId ?? ""}</td><td>${escapeHtml(entry.message)}</td></tr>`).join("")}</tbody>
  </table>
</body>
</html>`;
}

async function respondJson(response: ServerResponse, body: unknown, status = 200): Promise<void> {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function respondHtml(response: ServerResponse, html: string): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  response.end(html);
}

function sanitize(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer redacted")
    .replace(/x-api-key[:=]\s*[^&\s"')<>]+/giu, "x-api-key=redacted")
    .slice(0, 240);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

export async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startFromEnv(): Promise<void> {
  const config = bridgeConfigFromEnv(process.env);
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = new SqliteBridgeStore(config.databasePath);
  store.migrate();
  const kavita = createKavitaClient(config);
  const mal = createMalClient(config);
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: config.dryRun,
    runSync: () => runBridgeSyncOnce({ store, kavita, mal, dryRun: config.dryRun }),
  });
  server.listen(config.port, () => {
    console.log(`Mutsuki Kavita MAL Bridge listening on ${config.port}.`);
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  await startFromEnv();
}
