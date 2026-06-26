import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  checkKavitaReadiness,
  checkMalReadiness,
  createExternalIdResolver,
  createKavitaClient,
  createMalClient,
  type KavitaReadinessResult,
  type MalReadinessResult,
} from "./clients.js";
import { bridgeConfigFromEnv } from "./config.js";
import {
  buildMalAuthorizationRequest,
  exchangeMalAuthorizationCode,
  type OAuthTransport,
} from "./oauth.js";
import type { BridgeTrackingMode } from "./policy.js";
import {
  assertBridgeSyncReady,
  effectiveBridgeConfig,
  refreshStoredMalTokenIfNeeded,
} from "./runtime.js";
import { BridgeScheduler, type BridgeSchedulerResult } from "./scheduler.js";
import { runBridgeSyncOnce, type BridgeSyncResult } from "./sync.js";
import { SqliteBridgeStore, type SeriesMappingRecord } from "./storage.js";

export interface KavitaMalBridgeServerOptions {
  store: SqliteBridgeStore;
  dryRun: boolean;
  runSync: () => Promise<BridgeSyncResult>;
  oauthTransport?: OAuthTransport;
  checkReadiness?: () => Promise<BridgeReadinessResult>;
  schedulerStatus?: () => { intervalMs: number; lastResult?: BridgeSchedulerResult };
  onSettingsSaved?: () => Promise<void> | void;
}

export interface BridgeReadinessResult {
  kavita: KavitaReadinessResult;
  mal: MalReadinessResult;
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
        const settings = await options.store.listSettings();
        const tokens = await options.store.getOAuthTokens();
        const outbox = await options.store.outboxCounts();
        await respondJson(response, {
          dryRun: settingBoolean(settings.dryRun, options.dryRun),
          kavitaConfigured: Boolean(settings.kavitaBaseUrl && settings.kavitaApiKey),
          malOAuthConfigured: Boolean(settings.malClientId && settings.malRedirectUri),
          malAuthorized: Boolean(tokens),
          pollIntervalSeconds: settingNumber(settings.pollIntervalSeconds),
          mappings: (await options.store.listSeriesMappings()).length,
          unresolved: (await options.store.listReviews()).length,
          ignored: (await options.store.listIgnoredSeries()).length,
          outbox,
          scheduler: schedulerStatus(options),
          audit: (await options.store.listAuditLogs(25)).slice(0, 10),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/outbox") {
        await respondJson(response, { items: await options.store.listOutbox(100) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/unresolved-matches") {
        await respondJson(response, { items: await options.store.listReviews() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/ignored-series") {
        await respondJson(response, { items: await options.store.listIgnoredSeries() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/audit-log") {
        await respondJson(response, { items: await options.store.listAuditLogs(100) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/readiness") {
        await respondJson(response, await readiness(options));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/sync/run") {
        try {
          await respondJson(response, await options.runSync());
        } catch (error) {
          await respondJson(response, safeErrorBody(error), syncErrorStatus(error));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/mal/oauth/start") {
        const settings = await options.store.listSettings();
        const clientId = settings.malClientId?.trim();
        const redirectUri = settings.malRedirectUri?.trim();
        if (!clientId || !redirectUri) throw new Error("MAL OAuth settings are not configured.");
        const auth = buildMalAuthorizationRequest({
          clientId,
          redirectUri,
        });
        await options.store.saveOAuthState(auth.stateRecord);
        response.writeHead(302, { Location: auth.authorizationUrl });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/mal/oauth/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (!state || !code) throw new Error("MAL OAuth callback is missing state or code.");
        const storedState = await options.store.getOAuthState(state);
        if (!storedState) throw new Error("MAL OAuth state was not found.");
        const settings = await options.store.listSettings();
        const clientId = settings.malClientId?.trim();
        const redirectUri = settings.malRedirectUri?.trim();
        if (!clientId || !redirectUri) throw new Error("MAL OAuth settings are not configured.");
        const tokens = await exchangeMalAuthorizationCode({
          clientId,
          clientSecret: settings.malClientSecret ?? "",
          redirectUri,
          code,
          codeVerifier: storedState.codeVerifier,
          transport: options.oauthTransport,
        });
        await options.store.saveOAuthTokens(tokens);
        await options.store.deleteOAuthState(state);
        await options.store.audit({
          type: "system",
          message: "MAL OAuth authorization completed.",
        });
        await respondHtml(
          response,
          "<!doctype html><html><body><h1>MAL authorization complete</h1><p>You can close this tab.</p></body></html>",
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const body = parseJsonRecord(await readRequestBody(request));
        await saveSettings(options.store, body);
        await options.store.audit({
          type: "system",
          message: "Bridge settings updated.",
        });
        await options.onSettingsSaved?.();
        await respondJson(response, { ok: true });
        return;
      }
      const mappingOverride = /^\/api\/mappings\/(\d+)$/u.exec(url.pathname);
      if (request.method === "POST" && mappingOverride?.[1]) {
        const kavitaSeriesId = Number(mappingOverride[1]);
        const existing = await options.store.getSeriesMapping(kavitaSeriesId);
        if (!existing) {
          await respondJson(response, { error: "Mapping not found." }, 404);
          return;
        }
        const body = parseJsonRecord(await readRequestBody(request));
        const mapping = mappingFromOverride(existing, body);
        await options.store.upsertSeriesMapping(mapping);
        await options.store.audit({
          type: "match",
          kavitaSeriesId,
          message: `Manual MAL mapping override saved for ${mapping.malId}.`,
        });
        await respondJson(response, { ok: true, mapping });
        return;
      }
      const approveMatch = /^\/api\/unresolved-matches\/(\d+)\/approve$/u.exec(url.pathname);
      if (request.method === "POST" && approveMatch?.[1]) {
        const kavitaSeriesId = Number(approveMatch[1]);
        const body = parseJsonRecord(await readRequestBody(request));
        const mapping = mappingFromApproval(kavitaSeriesId, body);
        await options.store.upsertSeriesMapping(mapping);
        await options.store.deleteReview(kavitaSeriesId);
        await options.store.audit({
          type: "match",
          kavitaSeriesId,
          message: `Manual MAL mapping approved for ${mapping.malId}.`,
        });
        await respondJson(response, { ok: true, mapping });
        return;
      }
      const ignoreMatch = /^\/api\/unresolved-matches\/(\d+)\/ignore$/u.exec(url.pathname);
      if (request.method === "POST" && ignoreMatch?.[1]) {
        const kavitaSeriesId = Number(ignoreMatch[1]);
        const review = (await options.store.listReviews()).find(
          (item) => item.kavitaSeriesId === kavitaSeriesId,
        );
        await options.store.ignoreSeries({
          kavitaSeriesId,
          title: review?.title ?? `Kavita series ${kavitaSeriesId}`,
          reason: "manual-ignore",
        });
        await options.store.deleteReview(kavitaSeriesId);
        await options.store.audit({
          type: "review",
          kavitaSeriesId,
          message: "Manual review ignored; series will not be synced to MAL.",
        });
        await respondJson(response, { ok: true });
        return;
      }
      const restoreIgnored = /^\/api\/ignored-series\/(\d+)\/restore$/u.exec(url.pathname);
      if (request.method === "POST" && restoreIgnored?.[1]) {
        const kavitaSeriesId = Number(restoreIgnored[1]);
        await options.store.restoreIgnoredSeries(kavitaSeriesId);
        await options.store.audit({
          type: "review",
          kavitaSeriesId,
          message: "Manually ignored series restored to sync eligibility.",
        });
        await respondJson(response, { ok: true });
        return;
      }
      await respondJson(response, { error: "Not found." }, 404);
    } catch (error) {
      await respondJson(response, safeErrorBody(error), 500);
    }
  });
}

function safeErrorBody(error: unknown): { error: string } {
  return { error: error instanceof Error ? sanitize(error.message) : "Unexpected bridge error." };
}

function syncErrorStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  return /not configured|before running sync|settings are not configured/iu.test(error.message)
    ? 409
    : 500;
}

function schedulerStatus(
  options: KavitaMalBridgeServerOptions,
): { intervalSeconds: number; lastResult?: BridgeSchedulerResult } | undefined {
  const status = options.schedulerStatus?.();
  return status
    ? {
        intervalSeconds: Math.floor(status.intervalMs / 1000),
        lastResult: status.lastResult,
      }
    : undefined;
}

async function readiness(options: KavitaMalBridgeServerOptions): Promise<BridgeReadinessResult> {
  if (options.checkReadiness) return options.checkReadiness();
  const baseConfig = bridgeConfigFromEnv(process.env);
  const config = await effectiveBridgeConfig(baseConfig, options.store);
  const [kavita, mal] = await Promise.all([
    checkKavitaReadiness(config),
    checkMalReadiness(config),
  ]);
  return { kavita, mal };
}

async function saveSettings(
  store: SqliteBridgeStore,
  body: Record<string, unknown>,
): Promise<void> {
  const allowedStringKeys = [
    "kavitaBaseUrl",
    "kavitaApiKey",
    "malClientId",
    "malClientSecret",
    "malRedirectUri",
  ];
  for (const key of allowedStringKeys) {
    const value = body[key];
    if (typeof value === "string") await store.saveSetting(key, value.trim());
  }
  if (typeof body.dryRun === "boolean") await store.saveSetting("dryRun", String(body.dryRun));
  const pollInterval = numberBodyField(body, "pollIntervalSeconds");
  if (pollInterval !== undefined) {
    await store.saveSetting("pollIntervalSeconds", String(Math.max(60, Math.floor(pollInterval))));
  }
}

function mappingFromApproval(
  kavitaSeriesId: number,
  body: Record<string, unknown>,
): SeriesMappingRecord {
  const malId = numberBodyField(body, "malId");
  if (!Number.isSafeInteger(kavitaSeriesId) || kavitaSeriesId <= 0) {
    throw new Error("Invalid Kavita series id.");
  }
  if (malId === undefined || !Number.isSafeInteger(malId) || malId <= 0) {
    throw new Error("Invalid MAL id.");
  }
  return {
    kavitaSeriesId,
    malId,
    matchMethod: "manual",
    confidence: 1,
    locked: true,
    chapterOffset: Math.floor(numberBodyField(body, "chapterOffset") ?? 0),
    volumeOffset: Math.floor(numberBodyField(body, "volumeOffset") ?? 0),
    trackingMode: trackingModeBodyField(body.trackingMode),
    lastObservedChapter: 0,
    lastObservedVolume: 0,
    lastPushedChapter: 0,
    lastPushedVolume: 0,
  };
}

function mappingFromOverride(
  existing: SeriesMappingRecord,
  body: Record<string, unknown>,
): SeriesMappingRecord {
  const malId = numberBodyField(body, "malId");
  if (malId === undefined || !Number.isSafeInteger(malId) || malId <= 0) {
    throw new Error("Invalid MAL id.");
  }
  return {
    ...existing,
    malId,
    matchMethod: "manual-override",
    confidence: 1,
    locked: typeof body.locked === "boolean" ? body.locked : true,
    chapterOffset: Math.floor(numberBodyField(body, "chapterOffset") ?? existing.chapterOffset),
    volumeOffset: Math.floor(numberBodyField(body, "volumeOffset") ?? existing.volumeOffset),
    trackingMode: trackingModeBodyField(body.trackingMode),
  };
}

function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function numberBodyField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function trackingModeBodyField(value: unknown): BridgeTrackingMode {
  return value === "chapter-and-volume" ||
    value === "chapter-only" ||
    value === "volume-only" ||
    value === "disabled"
    ? value
    : "chapter-and-volume";
}

function settingBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function settingNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function renderHome(options: KavitaMalBridgeServerOptions): Promise<string> {
  const [mappings, reviews, audit, settings, tokens, outboxItems, outboxCounts] = await Promise.all(
    [
      options.store.listSeriesMappings(),
      options.store.listReviews(),
      options.store.listAuditLogs(20),
      options.store.listSettings(),
      options.store.getOAuthTokens(),
      options.store.listOutbox(25),
      options.store.outboxCounts(),
    ],
  );
  const ignored = await options.store.listIgnoredSeries();
  const effectiveDryRun = settingBoolean(settings.dryRun, options.dryRun);
  const schedule = schedulerStatus(options);
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
    input, select, button { font: inherit; margin: 0.25rem 0; padding: 0.45rem; }
    input, select { background: #1f2937; border: 1px solid #4b5563; color: #f9fafb; width: min(38rem, 100%); }
    button, .button { background: #2563eb; border: 0; color: #fff; cursor: pointer; display: inline-block; padding: 0.55rem 0.8rem; text-decoration: none; }
    label { display: block; margin: 0.45rem 0; }
    .row { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
    .panel { border: 1px solid #374151; margin: 1rem 0 2rem; padding: 1rem; }
    code { color: #fde68a; }
    .muted { color: #cbd5e1; }
  </style>
</head>
<body>
  <h1>Mutsuki Kavita MAL Bridge</h1>
  <p class="muted">Mode: <strong>${effectiveDryRun ? "dry-run" : "live MAL writes"}</strong> - MAL: <strong>${tokens ? "authorized" : "not authorized"}</strong>${schedule ? ` - Poll: <strong>${schedule.intervalSeconds}s</strong>` : ""}</p>
  <h2>Setup</h2>
  <form class="panel" id="settings-form" data-endpoint="/api/settings">
    <div class="row">
      <label>Kavita URL
        <input name="kavitaBaseUrl" value="${escapeHtml(settings.kavitaBaseUrl ?? "")}" autocomplete="off" />
      </label>
      <label>Kavita API key
        <input name="kavitaApiKey" type="password" placeholder="${settings.kavitaApiKey ? "Saved; enter a new key to replace" : ""}" autocomplete="off" />
      </label>
      <label>Poll interval seconds
        <input name="pollIntervalSeconds" type="number" min="60" step="60" value="${escapeHtml(settings.pollIntervalSeconds ?? "")}" />
      </label>
      <label>Dry run
        <select name="dryRun">
          <option value="true"${effectiveDryRun ? " selected" : ""}>true</option>
          <option value="false"${!effectiveDryRun ? " selected" : ""}>false</option>
        </select>
      </label>
      <label>MAL client ID
        <input name="malClientId" value="${escapeHtml(settings.malClientId ?? "")}" autocomplete="off" />
      </label>
      <label>MAL client secret
        <input name="malClientSecret" type="password" placeholder="${settings.malClientSecret ? "Saved; enter a new secret to replace" : ""}" autocomplete="off" />
      </label>
      <label>MAL redirect URI
        <input name="malRedirectUri" value="${escapeHtml(settings.malRedirectUri ?? "")}" autocomplete="off" />
      </label>
    </div>
    <button type="submit">Save settings</button>
    <a class="button" href="/api/mal/oauth/start">Authorize MAL</a>
    <button type="button" id="run-sync">Run sync now</button>
    <button type="button" id="check-readiness">Check readiness</button>
    <p class="muted" id="form-status"></p>
  </form>
  <h2>Mappings</h2>
  <p>${mappings.length} linked Kavita series.</p>
  <table>
    <thead><tr><th>Kavita Series</th><th>MAL ID</th><th>Policy</th><th>Offsets</th><th>Override</th></tr></thead>
    <tbody>${mappings.map((mapping) => renderMappingRow(mapping)).join("")}</tbody>
  </table>
  <h2>Recent MAL Outbox</h2>
  <p>${outboxCounts.pending} pending, ${outboxCounts.succeeded} succeeded, ${outboxCounts.failed} failed.</p>
  <table>
    <thead><tr><th>Created</th><th>Status</th><th>Kavita Series</th><th>MAL ID</th><th>Update</th><th>Attempts</th><th>Error</th></tr></thead>
    <tbody>${outboxItems.map(renderOutboxRow).join("")}</tbody>
  </table>
  <h2>Unresolved Matches</h2>
  <table>
    <thead><tr><th>Kavita Series</th><th>Title</th><th>Reason</th><th>Approve</th></tr></thead>
    <tbody>${reviews.map((review) => renderReviewRow(review)).join("")}</tbody>
  </table>
  <h2>Ignored Series</h2>
  <p>${ignored.length} Kavita series are manually excluded from MAL sync.</p>
  <table>
    <thead><tr><th>Kavita Series</th><th>Title</th><th>Reason</th><th>Created</th><th>Restore</th></tr></thead>
    <tbody>${ignored.map(renderIgnoredRow).join("")}</tbody>
  </table>
  <h2>Recent Audit</h2>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Series</th><th>Message</th></tr></thead>
    <tbody>${audit.map((entry) => `<tr><td>${escapeHtml(entry.createdAt)}</td><td>${escapeHtml(entry.type)}</td><td>${entry.kavitaSeriesId ?? ""}</td><td>${escapeHtml(entry.message)}</td></tr>`).join("")}</tbody>
  </table>
  <script>
    const status = document.querySelector("#form-status");
    function formJson(form) {
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.kavitaApiKey) delete data.kavitaApiKey;
      if (!data.malClientSecret) delete data.malClientSecret;
      if (data.pollIntervalSeconds) data.pollIntervalSeconds = Number(data.pollIntervalSeconds);
      if (data.dryRun) data.dryRun = data.dryRun === "true";
      if (data.malId) data.malId = Number(data.malId);
      if (data.chapterOffset) data.chapterOffset = Number(data.chapterOffset);
      if (data.volumeOffset) data.volumeOffset = Number(data.volumeOffset);
      if (data.locked) data.locked = data.locked === "true";
      return data;
    }
    document.querySelector("#settings-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const response = await fetch(event.currentTarget.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formJson(event.currentTarget)),
      });
      status.textContent = response.ok ? "Saved." : "Save failed.";
    });
    document.querySelector("#run-sync").addEventListener("click", async () => {
      const response = await fetch("/api/sync/run", { method: "POST" });
      status.textContent = response.ok ? "Sync requested." : "Sync failed.";
    });
    document.querySelector("#check-readiness").addEventListener("click", async () => {
      const response = await fetch("/api/readiness");
      const result = response.ok ? await response.json() : undefined;
      status.textContent = result
        ? "Kavita: " + (result.kavita.ok ? "ok" : "not ready") + ", MAL: " + (result.mal.ok ? "ok" : "not ready")
        : "Readiness check failed.";
    });
    for (const form of document.querySelectorAll(".approval-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formJson(event.currentTarget)),
        });
        status.textContent = response.ok ? "Mapping approved." : "Approval failed.";
      });
    }
    for (const form of document.querySelectorAll(".ignore-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        status.textContent = response.ok ? "Series ignored." : "Ignore failed.";
      });
    }
    for (const form of document.querySelectorAll(".restore-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        status.textContent = response.ok ? "Series restored." : "Restore failed.";
      });
    }
    for (const form of document.querySelectorAll(".mapping-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formJson(event.currentTarget)),
        });
        status.textContent = response.ok ? "Mapping override saved." : "Mapping override failed.";
      });
    }
  </script>
</body>
</html>`;
}

function renderMappingRow(mapping: SeriesMappingRecord): string {
  return `<tr><td>${mapping.kavitaSeriesId}</td><td>${mapping.malId}</td><td>${escapeHtml(mapping.trackingMode)}</td><td>chapter ${mapping.chapterOffset}, volume ${mapping.volumeOffset}</td><td>
    <form class="mapping-form" data-endpoint="/api/mappings/${mapping.kavitaSeriesId}">
      <input name="malId" type="number" min="1" value="${mapping.malId}" />
      <select name="trackingMode">
        ${trackingModeOption("chapter-and-volume", mapping.trackingMode, "chapter and volume")}
        ${trackingModeOption("chapter-only", mapping.trackingMode, "chapter only")}
        ${trackingModeOption("volume-only", mapping.trackingMode, "volume only")}
        ${trackingModeOption("disabled", mapping.trackingMode, "disabled")}
      </select>
      <input name="chapterOffset" type="number" step="1" value="${mapping.chapterOffset}" />
      <input name="volumeOffset" type="number" step="1" value="${mapping.volumeOffset}" />
      <select name="locked">
        <option value="true"${mapping.locked ? " selected" : ""}>locked</option>
        <option value="false"${!mapping.locked ? " selected" : ""}>auto</option>
      </select>
      <button type="submit">Save</button>
    </form>
  </td></tr>`;
}

function renderOutboxRow(
  item: Awaited<ReturnType<SqliteBridgeStore["listOutbox"]>>[number],
): string {
  return `<tr><td>${escapeHtml(item.createdAt)}</td><td>${escapeHtml(item.status)}</td><td>${item.kavitaSeriesId}</td><td>${item.malId}</td><td>${escapeHtml(JSON.stringify(item.update))}</td><td>${item.attempts}</td><td>${escapeHtml(item.lastError ?? "")}</td></tr>`;
}

function trackingModeOption(
  value: BridgeTrackingMode,
  current: BridgeTrackingMode,
  label: string,
): string {
  return `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`;
}

function renderReviewRow(
  review: Awaited<ReturnType<SqliteBridgeStore["listReviews"]>>[number],
): string {
  const candidate = firstReviewCandidate(review.candidatesJson);
  return `<tr><td>${review.kavitaSeriesId}</td><td>${escapeHtml(review.title)}</td><td>${escapeHtml(review.reason)}</td><td>
    <form class="approval-form" data-endpoint="/api/unresolved-matches/${review.kavitaSeriesId}/approve">
      <input name="malId" type="number" min="1" placeholder="MAL ID" value="${candidate?.malId ?? ""}" />
      <select name="trackingMode">
        <option value="chapter-and-volume">chapter and volume</option>
        <option value="chapter-only">chapter only</option>
        <option value="volume-only">volume only</option>
        <option value="disabled">disabled</option>
      </select>
      <input name="chapterOffset" type="number" step="1" value="0" />
      <input name="volumeOffset" type="number" step="1" value="0" />
      <button type="submit">Approve</button>
      ${candidate ? `<p class="muted">Top candidate: ${escapeHtml(candidate.title ?? String(candidate.malId))}</p>` : ""}
    </form>
    <form class="ignore-form" data-endpoint="/api/unresolved-matches/${review.kavitaSeriesId}/ignore">
      <button type="submit">Ignore</button>
    </form>
  </td></tr>`;
}

function renderIgnoredRow(
  ignored: Awaited<ReturnType<SqliteBridgeStore["listIgnoredSeries"]>>[number],
): string {
  return `<tr><td>${ignored.kavitaSeriesId}</td><td>${escapeHtml(ignored.title)}</td><td>${escapeHtml(ignored.reason)}</td><td>${escapeHtml(ignored.createdAt)}</td><td>
    <form class="restore-form" data-endpoint="/api/ignored-series/${ignored.kavitaSeriesId}/restore">
      <button type="submit">Restore</button>
    </form>
  </td></tr>`;
}

function firstReviewCandidate(
  candidatesJson: string,
): { malId?: number; title?: string } | undefined {
  try {
    const parsed = JSON.parse(candidatesJson) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const candidate = parsed.find(
      (item): item is { malId?: number; title?: string } =>
        typeof item === "object" && item !== null && "malId" in item,
    );
    return candidate;
  } catch {
    return undefined;
  }
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
  const baseConfig = bridgeConfigFromEnv(process.env);
  mkdirSync(dirname(baseConfig.databasePath), { recursive: true });
  const store = new SqliteBridgeStore(baseConfig.databasePath);
  store.migrate();
  const runSync = async (): Promise<BridgeSyncResult> => {
    await refreshStoredMalTokenIfNeeded({ baseConfig, store });
    const config = await effectiveBridgeConfig(baseConfig, store);
    assertBridgeSyncReady(config);
    const kavita = createKavitaClient(config);
    const mal = createMalClient(config);
    return runBridgeSyncOnce({
      store,
      kavita,
      mal,
      externalIdResolver: createExternalIdResolver(),
      dryRun: config.dryRun,
    });
  };
  const initialConfig = await effectiveBridgeConfig(baseConfig, store);
  const scheduler = new BridgeScheduler({
    intervalMs: initialConfig.pollIntervalSeconds * 1000,
    runSync,
  });
  scheduler.start();
  const server = createKavitaMalBridgeServer({
    store,
    dryRun: baseConfig.dryRun,
    runSync,
    schedulerStatus: () => ({
      intervalMs: scheduler.currentIntervalMs,
      lastResult: scheduler.lastResult,
    }),
    onSettingsSaved: async () => {
      const config = await effectiveBridgeConfig(baseConfig, store);
      scheduler.updateIntervalMs(config.pollIntervalSeconds * 1000);
    },
  });
  server.listen(baseConfig.port, () => {
    console.log(`Mutsuki Kavita MAL Bridge listening on ${baseConfig.port}.`);
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  await startFromEnv();
}
