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
import {
  processExternalReadEvent,
  type ExternalReadEventProcessResult,
} from "./external-events.js";
import { createAnilistResolver } from "./resolvers/anilist-resolver.js";
import { createJikanResolver } from "./resolvers/jikan-resolver.js";
import { createMangaDexResolver } from "./resolvers/mangadex-resolver.js";
import { composeTitleResolvers } from "./resolvers/title-resolver.js";
import { createWeebCentralResolver } from "./resolvers/weebcentral-resolver.js";
import type { BridgeTrackingMode } from "./policy.js";
import {
  assertBridgeSyncReady,
  effectiveBridgeConfig,
  refreshStoredMalTokenIfNeeded,
} from "./runtime.js";
import {
  defaultSourcePolicyForEvent,
  parseBridgeReadEvent,
  sourcePolicyFromInput,
  type BridgeReadEventRecord,
  type SourcePolicyRecord,
} from "./progress-events.js";
import { BridgeScheduler, type BridgeSchedulerResult } from "./scheduler.js";
import {
  processBridgeOutboxOnce,
  runBridgeSyncOnce,
  type BridgeObservedSeries,
  type BridgeOutboxProcessResult,
  type BridgeSyncResult,
} from "./sync.js";
import {
  SqliteBridgeStore,
  type ExternalReviewRecord,
  type ExternalSeriesMappingRecord,
  type SeriesMappingRecord,
  type WeebCentralMetricsRecord,
} from "./storage.js";
import type { ScoredMalCandidate } from "./matching.js";

export interface KavitaMalBridgeServerOptions {
  store: SqliteBridgeStore;
  dryRun: boolean;
  runSync: () => Promise<BridgeSyncResult>;
  processOutbox?: () => Promise<BridgeOutboxProcessResult>;
  oauthTransport?: OAuthTransport;
  checkReadiness?: () => Promise<BridgeReadinessResult>;
  previewKavitaProgress?: (limit: number) => Promise<BridgeObservedSeries[]>;
  processReadEvent?: (
    event: BridgeReadEventRecord,
    policy: SourcePolicyRecord,
    options?: {
      forceRefreshReview?: boolean;
    },
  ) => Promise<ExternalReadEventProcessResult | undefined>;
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
        const externalReviews = await options.store.listExternalReviews();
        const externalIgnored = await options.store.listExternalIgnoredSeries();
        const weebCentral = await options.store.weebCentralMetrics();
        await respondJson(response, {
          dryRun: settingBoolean(settings.dryRun, options.dryRun),
          showKavitaSyncPanels: settingBoolean(settings.showKavitaSyncPanels, false),
          kavitaConfigured: Boolean(settings.kavitaBaseUrl && settings.kavitaApiKey),
          malOAuthConfigured: Boolean(settings.malClientId && settings.malRedirectUri),
          malAuthorized: Boolean(tokens),
          pollIntervalSeconds: settingNumber(settings.pollIntervalSeconds),
          maxMalSearchesPerRun: positiveIntegerSetting(settings.maxMalSearchesPerRun),
          mappings: (await options.store.listSeriesMappings()).length,
          unresolved: (await options.store.listReviews()).length,
          externalMappings: (await options.store.listExternalSeriesMappings()).length,
          externalUnresolved: externalReviews.length,
          externalIgnored: externalIgnored.length,
          ignored: (await options.store.listIgnoredSeries()).length,
          readEvents: await options.store.readEventCount(),
          sourcePolicies: (await options.store.listSourcePolicies()).length,
          outbox,
          weebCentral,
          scheduler: schedulerStatus(options),
          audit: (await options.store.listAuditLogs(25)).slice(0, 10),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/progress-events") {
        const limit = queryLimit(url, 50, 250);
        await respondJson(response, { events: await options.store.listReadEvents(limit) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/progress-events") {
        const event = parseBridgeReadEvent(parseJsonRecord(await readRequestBody(request)));
        await options.store.appendReadEvent(event);
        const policy = await options.store.ensureSourcePolicy(defaultSourcePolicyForEvent(event));
        await options.store.audit({
          type: "progress",
          kavitaSeriesId: event.kavitaSeriesId,
          message: `Received Paperback read event from ${event.readingSourceId}.`,
          dataJson: JSON.stringify({
            actionId: event.actionId,
            readingSourceId: event.readingSourceId,
            readingSourceKind: event.readingSourceKind,
            sourceMangaId: event.sourceMangaId,
            sourceChapterId: event.sourceChapterId,
          }),
        });
        const processing = await processReadEventSafely(options, event, policy);
        await respondJson(response, { ok: true, event, processing }, 202);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/source-policies") {
        await respondJson(response, { items: await options.store.listSourcePolicies() });
        return;
      }
      const sourcePolicy = /^\/api\/source-policies\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "POST" && sourcePolicy?.[1]) {
        const readingSourceId = decodeURIComponent(sourcePolicy[1]);
        const existing = await options.store.getSourcePolicy(readingSourceId);
        const body = parseJsonRecord(await readRequestBody(request));
        const policy = sourcePolicyFromInput(readingSourceId, body, existing);
        await options.store.upsertSourcePolicy(policy);
        await options.store.audit({
          type: "system",
          message: `Source policy updated for ${policy.readingSourceId}.`,
          dataJson: JSON.stringify({
            readingSourceId: policy.readingSourceId,
            malEnabled: policy.malEnabled,
            kavitaMirrorMode: policy.kavitaMirrorMode,
          }),
        });
        await respondJson(response, { ok: true, policy });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/outbox") {
        await respondJson(response, { items: await options.store.listOutbox(100) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/outbox/process") {
        if (!options.processOutbox) {
          await respondJson(response, { error: "MAL outbox processing is not configured." }, 501);
          return;
        }
        try {
          await respondJson(response, await options.processOutbox());
        } catch (error) {
          await respondJson(response, safeErrorBody(error), syncErrorStatus(error));
        }
        return;
      }
      const retryOutbox = /^\/api\/outbox\/([^/]+)\/retry$/u.exec(url.pathname);
      if (request.method === "POST" && retryOutbox?.[1]) {
        const id = decodeURIComponent(retryOutbox[1]);
        const item = await options.store.getOutboxItem(id);
        if (!item) {
          await respondJson(response, { error: "Outbox item not found." }, 404);
          return;
        }
        if (item.status !== "failed") {
          await respondJson(response, { error: "Only failed outbox items can be retried." }, 409);
          return;
        }
        const updated = {
          ...item,
          status: "pending" as const,
          lastError: undefined,
          updatedAt: new Date().toISOString(),
        };
        await options.store.update(updated);
        await options.store.audit({
          type: "outbox",
          kavitaSeriesId: updated.kavitaSeriesId,
          message: `Manual outbox retry queued for MAL ${updated.malId}.`,
          dataJson: JSON.stringify({
            outboxId: updated.id,
            malId: updated.malId,
            attempts: updated.attempts,
            reason: updated.reason,
          }),
        });
        await respondJson(response, { ok: true, item: updated });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/mappings") {
        await respondJson(response, { items: await options.store.listSeriesMappings() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/external-mappings") {
        await respondJson(response, { items: await options.store.listExternalSeriesMappings() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/unresolved-matches") {
        const items = (await options.store.listReviews()).map(reviewResponseItem);
        await respondJson(response, { items });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/external-unresolved-matches") {
        const items = await Promise.all(
          (await options.store.listExternalReviews()).map(async (review) =>
            externalReviewResponseItem(
              review,
              await options.store.listResolverDiagnostics({
                readingSourceId: review.readingSourceId,
                sourceMangaId: review.sourceMangaId,
                limit: 20,
              }),
            ),
          ),
        );
        await respondJson(response, { items });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/ignored-series") {
        await respondJson(response, {
          items: await options.store.listIgnoredSeries(),
          externalItems: await options.store.listExternalIgnoredSeries(),
        });
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
      if (request.method === "GET" && url.pathname === "/api/kavita/observed-progress") {
        const limit = queryLimit(url, 25, 100);
        const items = (await kavitaProgressPreview(options, limit))
          .slice(0, limit)
          .map(observedProgressResponseItem);
        await respondJson(response, { limit, count: items.length, items });
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
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          if (state) await options.store.deleteOAuthState(state);
          const message = `MAL authorization failed: ${sanitize(oauthError)}`;
          await options.store.audit({
            type: "system",
            message,
          });
          await respondHtml(response, oauthFailureHtml(message), 400);
          return;
        }
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
      if (request.method === "POST" && url.pathname === "/api/mal/oauth/disconnect") {
        await options.store.clearOAuthTokens();
        await options.store.audit({
          type: "system",
          message: "MAL OAuth disconnected.",
        });
        await respondJson(response, { ok: true });
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
        const review = (await options.store.listReviews()).find(
          (item) => item.kavitaSeriesId === kavitaSeriesId,
        );
        const mapping = mappingFromApproval(kavitaSeriesId, body, review?.title);
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
      const approveExternalMatch =
        /^\/api\/external-unresolved-matches\/([^/]+)\/([^/]+)\/approve$/u.exec(url.pathname);
      if (request.method === "POST" && approveExternalMatch?.[1] && approveExternalMatch[2]) {
        const readingSourceId = decodeURIComponent(approveExternalMatch[1]);
        const sourceMangaId = decodeURIComponent(approveExternalMatch[2]);
        const body = parseJsonRecord(await readRequestBody(request));
        const review = await options.store.getExternalReview(readingSourceId, sourceMangaId);
        const mapping = externalMappingFromApproval(readingSourceId, sourceMangaId, body, review);
        await options.store.upsertExternalSeriesMapping(mapping);
        await options.store.deleteExternalReview(readingSourceId, sourceMangaId);
        await options.store.audit({
          type: "match",
          message: `Manual external MAL mapping approved for ${mapping.malId}.`,
          dataJson: JSON.stringify({
            readingSourceId,
            sourceMangaId,
            malId: mapping.malId,
          }),
        });
        await respondJson(response, { ok: true, mapping });
        return;
      }
      const ignoreExternalMatch =
        /^\/api\/external-unresolved-matches\/([^/]+)\/([^/]+)\/ignore$/u.exec(url.pathname);
      if (request.method === "POST" && ignoreExternalMatch?.[1] && ignoreExternalMatch[2]) {
        const readingSourceId = decodeURIComponent(ignoreExternalMatch[1]);
        const sourceMangaId = decodeURIComponent(ignoreExternalMatch[2]);
        const review = await options.store.getExternalReview(readingSourceId, sourceMangaId);
        await options.store.ignoreExternalSeries({
          readingSourceId,
          sourceMangaId,
          readingSourceName: review?.readingSourceName ?? readingSourceId,
          title: review?.title ?? `${readingSourceId} ${sourceMangaId}`,
          reason: "manual-ignore",
        });
        await options.store.deleteExternalReview(readingSourceId, sourceMangaId);
        await options.store.audit({
          type: "review",
          message: "Manual external review ignored; title will not be synced to MAL.",
          dataJson: JSON.stringify({
            readingSourceId,
            sourceMangaId,
          }),
        });
        await respondJson(response, { ok: true });
        return;
      }
      const noMalEntryExternalMatch =
        /^\/api\/external-unresolved-matches\/([^/]+)\/([^/]+)\/no-mal-entry$/u.exec(url.pathname);
      if (request.method === "POST" && noMalEntryExternalMatch?.[1] && noMalEntryExternalMatch[2]) {
        const readingSourceId = decodeURIComponent(noMalEntryExternalMatch[1]);
        const sourceMangaId = decodeURIComponent(noMalEntryExternalMatch[2]);
        const review = await options.store.getExternalReview(readingSourceId, sourceMangaId);
        await options.store.ignoreExternalSeries({
          readingSourceId,
          sourceMangaId,
          readingSourceName: review?.readingSourceName ?? readingSourceId,
          title: review?.title ?? `${readingSourceId} ${sourceMangaId}`,
          reason: "no-mal-entry",
        });
        await options.store.deleteExternalReview(readingSourceId, sourceMangaId);
        await options.store.audit({
          type: "review",
          message: "External source title marked as having no MAL entry.",
          dataJson: JSON.stringify({
            readingSourceId,
            sourceMangaId,
          }),
        });
        await respondJson(response, { ok: true });
        return;
      }
      const retryExternalMatch =
        /^\/api\/external-unresolved-matches\/([^/]+)\/([^/]+)\/retry-resolution$/u.exec(
          url.pathname,
        );
      if (request.method === "POST" && retryExternalMatch?.[1] && retryExternalMatch[2]) {
        const readingSourceId = decodeURIComponent(retryExternalMatch[1]);
        const sourceMangaId = decodeURIComponent(retryExternalMatch[2]);
        const event = await options.store.getLatestReadEvent(readingSourceId, sourceMangaId);
        if (!event) {
          await respondJson(
            response,
            { error: "No read event exists for this external title." },
            404,
          );
          return;
        }
        if (!options.processReadEvent) {
          await respondJson(response, { error: "Read-event processing is not configured." }, 409);
          return;
        }
        await options.store.clearResolverCache();
        const policy = await options.store.ensureSourcePolicy(defaultSourcePolicyForEvent(event));
        const processing = await processReadEventSafely(options, event, policy, {
          forceRefreshReview: true,
        });
        await options.store.audit({
          type: "review",
          message: "Manual retry resolution requested for external source title.",
          dataJson: JSON.stringify({
            readingSourceId,
            sourceMangaId,
            processing,
          }),
        });
        await respondJson(response, { ok: true, processing });
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
      const restoreExternalIgnored =
        /^\/api\/external-ignored-series\/([^/]+)\/([^/]+)\/restore$/u.exec(url.pathname);
      if (request.method === "POST" && restoreExternalIgnored?.[1] && restoreExternalIgnored[2]) {
        const readingSourceId = decodeURIComponent(restoreExternalIgnored[1]);
        const sourceMangaId = decodeURIComponent(restoreExternalIgnored[2]);
        await options.store.restoreExternalIgnoredSeries(readingSourceId, sourceMangaId);
        await options.store.audit({
          type: "review",
          message: "Manually ignored external source title restored to sync eligibility.",
          dataJson: JSON.stringify({ readingSourceId, sourceMangaId }),
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
  return /not configured|before running sync|settings are not configured|re-authorize MAL/iu.test(
    error.message,
  )
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

async function kavitaProgressPreview(
  options: KavitaMalBridgeServerOptions,
  limit: number,
): Promise<BridgeObservedSeries[]> {
  if (options.previewKavitaProgress) return options.previewKavitaProgress(limit);
  const baseConfig = bridgeConfigFromEnv(process.env);
  const config = await effectiveBridgeConfig(baseConfig, options.store);
  if (!config.kavitaBaseUrl || !config.kavitaApiKey) {
    throw new Error("Kavita URL or API key is not configured.");
  }
  return createKavitaClient(config).listSeries({ limit });
}

async function processReadEventSafely(
  options: KavitaMalBridgeServerOptions,
  event: BridgeReadEventRecord,
  policy: SourcePolicyRecord,
  processOptions?: {
    forceRefreshReview?: boolean;
  },
): Promise<ExternalReadEventProcessResult | undefined> {
  if (!options.processReadEvent) return undefined;
  try {
    return await options.processReadEvent(event, policy, processOptions);
  } catch (error) {
    await options.store.audit({
      type: "progress",
      kavitaSeriesId: event.kavitaSeriesId,
      message: "Paperback read event was stored but downstream processing failed.",
      dataJson: JSON.stringify({
        actionId: event.actionId,
        readingSourceId: event.readingSourceId,
        readingSourceKind: event.readingSourceKind,
        sourceMangaId: event.sourceMangaId,
        sourceChapterId: event.sourceChapterId,
        error: safeErrorBody(error).error,
      }),
    });
    return { status: "skipped", reason: "no-progress-update" };
  }
}

function observedProgressResponseItem(item: BridgeObservedSeries): Record<string, unknown> {
  return {
    kavitaSeriesId: item.kavitaSeriesId,
    kavitaLibraryId: item.kavitaLibraryId,
    title: item.title,
    contentType: item.contentType,
    mediaType: item.mediaType,
    completedChapter: item.completedChapter,
    completedVolume: item.completedVolume,
    isSpecial: item.isSpecial,
  };
}

function queryLimit(url: URL, fallback: number, max: number): number {
  const parsed = Number(url.searchParams.get("limit") ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
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
    "resolverUserAgent",
  ];
  for (const key of allowedStringKeys) {
    const value = body[key];
    if (typeof value === "string") await store.saveSetting(key, value.trim());
  }
  if (typeof body.dryRun === "boolean") await store.saveSetting("dryRun", String(body.dryRun));
  if (typeof body.showKavitaSyncPanels === "boolean") {
    await store.saveSetting("showKavitaSyncPanels", String(body.showKavitaSyncPanels));
  }
  if (typeof body.enableJikanResolver === "boolean") {
    await store.saveSetting("enableJikanResolver", String(body.enableJikanResolver));
  }
  if (typeof body.enableAnilistResolver === "boolean") {
    await store.saveSetting("enableAnilistResolver", String(body.enableAnilistResolver));
  }
  const pollInterval = numberBodyField(body, "pollIntervalSeconds");
  if (pollInterval !== undefined) {
    await store.saveSetting("pollIntervalSeconds", String(Math.max(60, Math.floor(pollInterval))));
  }
  const maxMalSearches = numberBodyField(body, "maxMalSearchesPerRun");
  if (maxMalSearches !== undefined) {
    await store.saveSetting(
      "maxMalSearchesPerRun",
      String(Math.max(1, Math.min(500, Math.floor(maxMalSearches)))),
    );
  }
  const resolverTimeout = numberBodyField(body, "resolverTimeoutMs");
  if (resolverTimeout !== undefined) {
    await store.saveSetting(
      "resolverTimeoutMs",
      String(Math.max(1000, Math.min(30_000, Math.floor(resolverTimeout)))),
    );
  }
  const resolverCacheTtl = numberBodyField(body, "resolverCacheTtlHours");
  if (resolverCacheTtl !== undefined) {
    await store.saveSetting(
      "resolverCacheTtlHours",
      String(Math.max(1, Math.min(24 * 30, Math.floor(resolverCacheTtl)))),
    );
  }
  const resolverMaxCandidates = numberBodyField(body, "resolverMaxCandidatesPerQuery");
  if (resolverMaxCandidates !== undefined) {
    await store.saveSetting(
      "resolverMaxCandidatesPerQuery",
      String(Math.max(1, Math.min(25, Math.floor(resolverMaxCandidates)))),
    );
  }
}

function mappingFromApproval(
  kavitaSeriesId: number,
  body: Record<string, unknown>,
  title: string | undefined,
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
    title,
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

function externalMappingFromApproval(
  readingSourceId: string,
  sourceMangaId: string,
  body: Record<string, unknown>,
  review: Required<ExternalReviewRecord> | undefined,
): ExternalSeriesMappingRecord {
  const malId = numberBodyField(body, "malId");
  if (!readingSourceId || !sourceMangaId) throw new Error("Invalid external source key.");
  if (malId === undefined || !Number.isSafeInteger(malId) || malId <= 0) {
    throw new Error("Invalid MAL id.");
  }
  return {
    readingSourceId,
    sourceMangaId,
    readingSourceName: review?.readingSourceName ?? readingSourceId,
    title: review?.title ?? `${readingSourceId} ${sourceMangaId}`,
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

function positiveIntegerSetting(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, 500) : undefined;
}

async function renderHome(options: KavitaMalBridgeServerOptions): Promise<string> {
  const [
    mappings,
    reviews,
    audit,
    settings,
    tokens,
    outboxItems,
    outboxCounts,
    readEvents,
    sourcePolicies,
    externalMappings,
    externalReviews,
    externalIgnored,
    weebCentral,
  ] = await Promise.all([
    options.store.listSeriesMappings(),
    options.store.listReviews(),
    options.store.listAuditLogs(20),
    options.store.listSettings(),
    options.store.getOAuthTokens(),
    options.store.listOutbox(25),
    options.store.outboxCounts(),
    options.store.listReadEvents(25),
    options.store.listSourcePolicies(),
    options.store.listExternalSeriesMappings(),
    options.store.listExternalReviews(),
    options.store.listExternalIgnoredSeries(),
    options.store.weebCentralMetrics(),
  ]);
  const ignored = await options.store.listIgnoredSeries();
  const effectiveDryRun = settingBoolean(settings.dryRun, options.dryRun);
  const showKavitaSyncPanels = settingBoolean(settings.showKavitaSyncPanels, false);
  const enableJikanResolver = settingBoolean(settings.enableJikanResolver, true);
  const enableAnilistResolver = settingBoolean(settings.enableAnilistResolver, true);
  const schedule = schedulerStatus(options);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mutsuki Kavita MAL Bridge</title>
  <style>
    body { background: #111827; color: #f9fafb; font-family: system-ui, sans-serif; margin: 2rem; }
    h1, h2 { margin-bottom: 0.35rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; }
    th, td { border-bottom: 1px solid #374151; padding: 0.6rem; text-align: left; vertical-align: top; }
    th { color: #bfdbfe; font-size: 0.85rem; text-transform: uppercase; }
    input, select, button { font: inherit; margin: 0.25rem 0; padding: 0.45rem; }
    input, select { background: #1f2937; border: 1px solid #4b5563; color: #f9fafb; width: min(38rem, 100%); }
    button, .button { background: #2563eb; border: 0; color: #fff; cursor: pointer; display: inline-block; padding: 0.55rem 0.8rem; text-decoration: none; }
    label { display: block; margin: 0.45rem 0; }
    .row { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
    .panel { border: 1px solid #374151; margin: 1rem 0 2rem; padding: 1rem; }
    .section-head { align-items: center; display: flex; flex-wrap: wrap; gap: 0.45rem; }
    .help { color: #cbd5e1; display: block; font-size: 0.88rem; margin-top: 0.2rem; }
    .info-icon { align-items: center; border: 1px solid #64748b; border-radius: 999px; color: #bfdbfe; display: inline-flex; font-size: 0.75rem; font-weight: 700; height: 1.15rem; justify-content: center; width: 1.15rem; }
    .metric-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
    .metric { background: #172033; border: 1px solid #334155; padding: 0.75rem; }
    .metric strong { display: block; font-size: 1.4rem; }
    .metric span { color: #cbd5e1; display: block; font-size: 0.86rem; }
    .quick-guide { background: #172033; border-color: #334155; }
    .kavita-hidden { background: #172033; }
    code { color: #fde68a; }
    .muted { color: #cbd5e1; }
  </style>
</head>
<body>
  <h1>Mutsuki Kavita MAL Bridge</h1>
  <p class="muted">MAL write mode: <strong>${effectiveDryRun ? "Preview only (dry run)" : "Send to MAL (live writes)"}</strong> - MAL: <strong>${tokens ? "authorized" : "not authorized"}</strong>${schedule ? ` - Poll: <strong>${schedule.intervalSeconds}s</strong>` : ""}</p>
  <section class="panel quick-guide">
    <div class="section-head">
      <h2>Quick guide</h2>
      ${infoIcon("The normal flow is Paperback read event -> bridge matching -> MAL outbox -> preview or send to MAL depending on write mode. Kavita sync panels are optional and hidden until enabled.")}
    </div>
    <p class="muted">Start here: confirm read events arrive, check unresolved external matches, then review the MAL outbox. Change MAL write mode to Send to MAL only when the pending outbox looks correct.</p>
  </section>
  ${renderWeebCentralMetricsPanel(weebCentral)}
  <div class="section-head">
    <h2>Setup</h2>
    ${infoIcon("Connect MAL, choose whether pending outbox updates are previews or live writes, and decide whether advanced Kavita sync tables are shown.")}
  </div>
  <form class="panel" id="settings-form" data-endpoint="/api/settings">
    <div class="row">
      <label><span class="field-title">Kavita URL ${infoIcon("Only required for Kavita polling or Kavita mirroring. External source reads can still be tested without it.")}</span>
        <input name="kavitaBaseUrl" value="${escapeHtml(settings.kavitaBaseUrl ?? "")}" autocomplete="off" />
      </label>
      <label><span class="field-title">Kavita API key ${infoIcon("Stored locally in the bridge database. It is never shown back on this page after saving.")}</span>
        <input name="kavitaApiKey" type="password" placeholder="${settings.kavitaApiKey ? "Saved; enter a new key to replace" : ""}" autocomplete="off" />
      </label>
      <label><span class="field-title">Poll interval seconds ${infoIcon("How often the bridge checks Kavita progress in the background. Minimum is 60 seconds.")}</span>
        <input name="pollIntervalSeconds" type="number" min="60" step="60" value="${escapeHtml(settings.pollIntervalSeconds ?? "")}" />
      </label>
      <label><span class="field-title">Max MAL searches per run ${infoIcon("Safety limit for fuzzy MAL searches. Deterministic IDs still link without using this search budget.")}</span>
        <input name="maxMalSearchesPerRun" type="number" min="1" max="500" step="1" value="${escapeHtml(settings.maxMalSearchesPerRun ?? "")}" />
      </label>
      <label><span class="field-title">MAL write mode ${infoIcon("Preview only stores pending outbox work without changing MAL. Send to MAL lets the outbox processor write monotonic progress to MAL.")}</span>
        <select name="dryRun">
          <option value="true"${effectiveDryRun ? " selected" : ""}>Preview only (dry run)</option>
          <option value="false"${!effectiveDryRun ? " selected" : ""}>Send to MAL (live writes)</option>
        </select>
        <span class="help">Saving this setting does not send old pending outbox items by itself. Use Process MAL outbox now, or wait for the scheduled poll.</span>
      </label>
      <label><span class="field-title">Show Kavita sync panels ${infoIcon("Shows the long Kavita mapping and review tables. Keep this off when you are mainly testing Paperback read events from source extensions.")}</span>
        <select name="showKavitaSyncPanels">
          <option value="false"${!showKavitaSyncPanels ? " selected" : ""}>hide unless needed</option>
          <option value="true"${showKavitaSyncPanels ? " selected" : ""}>show advanced Kavita panels</option>
        </select>
        <span class="help">This only changes the page layout. It does not disable Kavita polling or read-event processing.</span>
      </label>
      <label><span class="field-title">MAL client ID ${infoIcon("The client ID from your MyAnimeList API application.")}</span>
        <input name="malClientId" value="${escapeHtml(settings.malClientId ?? "")}" autocomplete="off" />
      </label>
      <label><span class="field-title">MAL client secret ${infoIcon("Optional for some MAL app setups. Stored locally and hidden after saving.")}</span>
        <input name="malClientSecret" type="password" placeholder="${settings.malClientSecret ? "Saved; enter a new secret to replace" : ""}" autocomplete="off" />
      </label>
      <label><span class="field-title">MAL redirect URI ${infoIcon("Must exactly match the redirect URI configured in the MAL API client.")}</span>
        <input name="malRedirectUri" value="${escapeHtml(settings.malRedirectUri ?? "")}" autocomplete="off" />
      </label>
      <label><span class="field-title">Jikan discovery ${infoIcon("Uses the public Jikan API only to discover MAL candidate IDs when official MAL search misses an English title.")}</span>
        <select name="enableJikanResolver">
          <option value="true"${enableJikanResolver ? " selected" : ""}>enabled</option>
          <option value="false"${!enableJikanResolver ? " selected" : ""}>disabled</option>
        </select>
      </label>
      <label><span class="field-title">AniList discovery ${infoIcon("Uses public AniList GraphQL search to discover MAL IDs through idMal, then validates them with the official MAL API.")}</span>
        <select name="enableAnilistResolver">
          <option value="true"${enableAnilistResolver ? " selected" : ""}>enabled</option>
          <option value="false"${!enableAnilistResolver ? " selected" : ""}>disabled</option>
        </select>
      </label>
      <label><span class="field-title">Resolver timeout ms ${infoIcon("Timeout for discovery helpers. Failed discovery never bypasses deterministic IDs or existing mappings.")}</span>
        <input name="resolverTimeoutMs" type="number" min="1000" max="30000" step="500" value="${escapeHtml(settings.resolverTimeoutMs ?? "")}" placeholder="5000" />
      </label>
      <label><span class="field-title">Resolver cache hours ${infoIcon("How long Jikan/AniList discovery responses stay cached in SQLite to respect public API rate limits.")}</span>
        <input name="resolverCacheTtlHours" type="number" min="1" max="720" step="1" value="${escapeHtml(settings.resolverCacheTtlHours ?? "")}" placeholder="168" />
      </label>
      <label><span class="field-title">Resolver candidate limit ${infoIcon("Maximum discovery candidates per title variant before official MAL direct-ID validation.")}</span>
        <input name="resolverMaxCandidatesPerQuery" type="number" min="1" max="25" step="1" value="${escapeHtml(settings.resolverMaxCandidatesPerQuery ?? "")}" placeholder="8" />
      </label>
    </div>
    <button type="submit">Save settings</button>
    <a class="button" href="/api/mal/oauth/start">Connect MAL</a>
    <button type="button" id="disconnect-mal">Disconnect MAL</button>
    <button type="button" id="process-outbox">Process MAL outbox now</button>
    <button type="button" id="run-sync">Run Kavita sync now</button>
    <button type="button" id="check-readiness">Check readiness</button>
    <button type="button" id="preview-kavita">Preview Kavita progress</button>
    <p class="muted" id="form-status"></p>
    <pre class="muted" id="preview-output"></pre>
  </form>
  <div class="section-head">
    <h2>Recent Paperback Read Events</h2>
    ${infoIcon("These are the read-complete events received from Paperback tracker/provider queues. If a title was read and is missing here, the bridge did not receive it.")}
  </div>
  <table>
    <thead><tr><th>Received</th><th>Source</th><th>Kind</th><th>Series</th><th>Chapter</th><th>Kavita</th></tr></thead>
    <tbody>${readEvents.map(renderReadEventRow).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>Source Policies</h2>
    ${infoIcon("Controls what the bridge may do for each Paperback source. MAL can be enabled while Kavita mirroring stays disabled.")}
  </div>
  <p>${sourcePolicies.length} Paperback reading source${sourcePolicies.length === 1 ? "" : "s"} observed.</p>
  <table>
    <thead><tr><th>Source</th><th>MAL</th><th>Kavita Mirror</th><th>Save</th></tr></thead>
    <tbody>${sourcePolicies.map(renderSourcePolicyRow).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>External Source Mappings</h2>
    ${infoIcon("Matches from non-Kavita Paperback sources, such as MangaDex or WeebCentral, to MAL titles.")}
  </div>
  <p>${externalMappings.length} linked Paperback source title${externalMappings.length === 1 ? "" : "s"}.</p>
  <table>
    <thead><tr><th>Source</th><th>Title</th><th>MAL ID</th><th>Policy</th><th>Observed</th><th>Pushed</th></tr></thead>
    <tbody>${externalMappings.map(renderExternalMappingRow).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>External Unresolved Matches</h2>
    ${infoIcon("External source titles that still need resolution. Retry resolution refreshes source enrichment and resolver caches; manual MAL ID is the last-resort path.")}
  </div>
  <table>
    <thead><tr><th>Source</th><th>Title</th><th>Reason</th><th>Approve</th></tr></thead>
    <tbody>${externalReviews.map(renderExternalReviewRow).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>Ignored External Titles</h2>
    ${infoIcon("External source titles you manually excluded from MAL sync.")}
  </div>
  <p>${externalIgnored.length} external Paperback source title${externalIgnored.length === 1 ? "" : "s"} are manually excluded from MAL sync.</p>
  <table>
    <thead><tr><th>Source</th><th>Title</th><th>Reason</th><th>Created</th><th>Restore</th></tr></thead>
    <tbody>${externalIgnored.map(renderExternalIgnoredRow).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>MAL Outbox</h2>
    ${infoIcon("Pending MAL updates are written only when this outbox is processed. In Preview only mode, processing records a preview and does not change MAL. In Send to MAL mode, processing writes to MAL.")}
  </div>
  <p>${outboxCounts.pending} pending, ${outboxCounts.succeeded} succeeded, ${outboxCounts.failed} failed. Current mode: <strong>${effectiveDryRun ? "preview only" : "send to MAL"}</strong>.</p>
  <table>
    <thead><tr><th>Created</th><th>Status</th><th>Target</th><th>MAL ID</th><th>Update</th><th>Attempts</th><th>Error</th><th>Action</th></tr></thead>
    <tbody>${outboxItems.map(renderOutboxRow).join("")}</tbody>
  </table>
  ${showKavitaSyncPanels ? renderKavitaSyncPanels({ mappings, reviews, ignored }) : renderKavitaSyncHiddenNotice({ mappingCount: mappings.length, reviewCount: reviews.length, ignoredCount: ignored.length })}
  <div class="section-head">
    <h2>Recent Audit</h2>
    ${infoIcon("Short bridge history for troubleshooting matching, settings, and outbox actions.")}
  </div>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Series</th><th>Message</th></tr></thead>
    <tbody>${audit.map((entry) => `<tr><td>${escapeHtml(entry.createdAt)}</td><td>${escapeHtml(entry.type)}</td><td>${entry.kavitaSeriesId ?? ""}</td><td>${escapeHtml(entry.message)}</td></tr>`).join("")}</tbody>
  </table>
  <script>
    const status = document.querySelector("#form-status");
    const previewOutput = document.querySelector("#preview-output");
    function formJson(form) {
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.kavitaApiKey) delete data.kavitaApiKey;
      if (!data.malClientSecret) delete data.malClientSecret;
      if (data.pollIntervalSeconds) data.pollIntervalSeconds = Number(data.pollIntervalSeconds);
      if (data.maxMalSearchesPerRun) data.maxMalSearchesPerRun = Number(data.maxMalSearchesPerRun);
      if (data.resolverTimeoutMs) data.resolverTimeoutMs = Number(data.resolverTimeoutMs);
      if (data.resolverCacheTtlHours) data.resolverCacheTtlHours = Number(data.resolverCacheTtlHours);
      if (data.resolverMaxCandidatesPerQuery) data.resolverMaxCandidatesPerQuery = Number(data.resolverMaxCandidatesPerQuery);
      if (data.dryRun) data.dryRun = data.dryRun === "true";
      if (data.showKavitaSyncPanels) data.showKavitaSyncPanels = data.showKavitaSyncPanels === "true";
      if (data.enableJikanResolver) data.enableJikanResolver = data.enableJikanResolver === "true";
      if (data.enableAnilistResolver) data.enableAnilistResolver = data.enableAnilistResolver === "true";
      if (data.malEnabled) data.malEnabled = data.malEnabled === "true";
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
      const result = response.ok ? await response.json() : undefined;
      status.textContent = result ? syncResultMessage(result) : await responseErrorMessage(response, "Kavita sync failed.");
    });
    document.querySelector("#process-outbox").addEventListener("click", async () => {
      const response = await fetch("/api/outbox/process", { method: "POST" });
      const result = response.ok ? await response.json() : undefined;
      status.textContent = result ? outboxResultMessage(result) : await responseErrorMessage(response, "MAL outbox processing failed.");
    });
    document.querySelector("#disconnect-mal").addEventListener("click", async () => {
      const response = await fetch("/api/mal/oauth/disconnect", { method: "POST" });
      status.textContent = response.ok ? "MAL authorization disconnected." : await responseErrorMessage(response, "Disconnect failed.");
    });
    document.querySelector("#check-readiness").addEventListener("click", async () => {
      const response = await fetch("/api/readiness");
      const result = response.ok ? await response.json() : undefined;
      status.textContent = result
        ? "Kavita: " + (result.kavita.ok ? "ok" : "not ready") + ", MAL: " + (result.mal.ok ? "ok" : "not ready")
        : "Readiness check failed.";
    });
    document.querySelector("#preview-kavita").addEventListener("click", async () => {
      const response = await fetch("/api/kavita/observed-progress?limit=25");
      const result = response.ok ? await response.json() : undefined;
      if (!result) {
        status.textContent = "Kavita preview failed.";
        return;
      }
      status.textContent = "Loaded " + result.count + " observed Kavita progress rows.";
      previewOutput.textContent = result.items.map((item) =>
        item.kavitaSeriesId + " - " + item.title + " - chapter " + (item.completedChapter ?? "-") + ", volume " + (item.completedVolume ?? "-")
      ).join("\\n");
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
    for (const form of document.querySelectorAll(".retry-resolution-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        status.textContent = response.ok ? "Resolution retried." : await responseErrorMessage(response, "Retry failed.");
        if (response.ok) {
          const result = await response.json().catch(() => undefined);
          const processing = result && result.processing ? result.processing : undefined;
          if (processing?.status === "queued") {
            status.textContent = "Resolved to MAL " + processing.malId + " and queued an outbox update. Refreshing...";
            window.setTimeout(() => window.location.reload(), 600);
          } else if (processing?.status === "mapped") {
            status.textContent = "Resolved to MAL " + processing.malId + ". Refreshing...";
            window.setTimeout(() => window.location.reload(), 600);
          } else if (processing?.status === "review") {
            status.textContent = "Still unresolved after retry: " + (processing.reason ?? "needs review") + ".";
          } else if (processing?.status === "skipped") {
            status.textContent = "Retry skipped: " + (processing.reason ?? "not eligible") + ".";
          }
        }
      });
    }
    for (const form of document.querySelectorAll(".no-mal-entry-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        status.textContent = response.ok ? "Marked as no MAL entry." : await responseErrorMessage(response, "No-MAL marker failed.");
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
    for (const form of document.querySelectorAll(".outbox-retry-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        status.textContent = response.ok ? "Outbox retry queued." : await responseErrorMessage(response, "Outbox retry failed.");
      });
    }
    for (const form of document.querySelectorAll(".source-policy-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch(event.currentTarget.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formJson(event.currentTarget)),
        });
        status.textContent = response.ok ? "Source policy saved." : await responseErrorMessage(response, "Source policy save failed.");
      });
    }
    async function responseErrorMessage(response, fallback) {
      try {
        const body = await response.json();
        return body && body.error ? body.error : fallback;
      } catch {
        return fallback;
      }
    }
    function syncResultMessage(result) {
      return "Sync: "
        + result.seriesSeen + " series, "
        + result.autoMatched + " auto-matched, "
        + result.reviewQueued + " review, "
        + (result.reviewSkipped ?? 0) + " skipped, "
        + (result.searchDeferred ?? 0) + " deferred, "
        + (result.searchBudgetSkipped ?? 0) + " budget-skipped, "
        + result.updatesQueued + " queued, "
        + (result.outboxPreviewed ?? 0) + " previewed, "
        + result.outboxSucceeded + " pushed, "
        + result.outboxFailed + " failed.";
    }
    function outboxResultMessage(result) {
      return "MAL outbox: "
        + result.outboxProcessed + " pending item(s) checked, "
        + (result.outboxPreviewed ?? 0) + " previewed, "
        + result.outboxSucceeded + " pushed, "
        + result.outboxFailed + " failed.";
    }
  </script>
</body>
</html>`;
}

function infoIcon(text: string): string {
  const label = escapeHtml(text);
  return `<span class="info-icon" role="img" aria-label="${label}" title="${label}">i</span>`;
}

function renderWeebCentralMetricsPanel(metrics: WeebCentralMetricsRecord): string {
  return `<section class="panel">
    <div class="section-head">
      <h2>WeebCentral Matching Health</h2>
      ${infoIcon("WeebCentral is treated as a first-class source. These counters show whether events are being auto-linked through deterministic IDs/enrichment or still falling into review.")} 
    </div>
    <div class="metric-grid">
      ${renderMetric("Events received", metrics.eventsReceived, "Paperback read events from WeebCentral seen by the bridge.")}
      ${renderMetric("Auto-linked", metrics.autoMapped, "WeebCentral titles already mapped to MAL without manual approval.")}
      ${renderMetric("Unresolved", metrics.unresolved, "WeebCentral titles still needing resolver improvement, retry, or a true no-MAL classification.")}
      ${renderMetric("Ignored / no MAL", metrics.ignored, `${metrics.noMalEntry} marked as no MAL entry; these stop repeated review clutter without writing to MAL.`)}
      ${renderMetric("Deterministic ID", metrics.deterministicIdMatches, "Mappings made from source MAL/AniList IDs after official MAL direct-ID validation.")}
      ${renderMetric("Enrichment ID", metrics.enrichmentMatches, "Mappings found by enriching the WeebCentral public series page, then validating the resulting MAL ID.")}
      ${renderMetric("Resolver search", metrics.resolverMatches, "Mappings made by conservative title search after deterministic paths were unavailable.")}
      ${renderMetric("Unresolved rate", `${Math.round(metrics.weakUnresolvedRate * 100)}%`, "Share of WeebCentral titles still unresolved among linked, unresolved, and ignored states.")}
    </div>
  </section>`;
}

function renderMetric(label: string, value: number | string, help: string): string {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)} ${infoIcon(help)}</span></div>`;
}

function renderKavitaSyncHiddenNotice(counts: {
  mappingCount: number;
  reviewCount: number;
  ignoredCount: number;
}): string {
  return `<section class="panel kavita-hidden" data-section="kavita-sync-hidden">
    <div class="section-head">
      <h2>Kavita sync panels hidden</h2>
      ${infoIcon("Enable Show Kavita sync panels in Setup when you need to review Kavita-to-MAL mappings or Kavita polling results.")}
    </div>
    <p class="muted">Hidden right now: ${counts.mappingCount} Kavita mapping${counts.mappingCount === 1 ? "" : "s"}, ${counts.reviewCount} Kavita review item${counts.reviewCount === 1 ? "" : "s"}, and ${counts.ignoredCount} ignored Kavita series.</p>
  </section>`;
}

function renderKavitaSyncPanels(input: {
  mappings: SeriesMappingRecord[];
  reviews: Awaited<ReturnType<SqliteBridgeStore["listReviews"]>>;
  ignored: Awaited<ReturnType<SqliteBridgeStore["listIgnoredSeries"]>>;
}): string {
  return `<div class="section-head">
    <h2>Kavita Series Mappings</h2>
    ${infoIcon("Kavita library series that the bridge matched to MAL. This is separate from external Paperback source tracking.")}
  </div>
  <p>${input.mappings.length} linked Kavita series.</p>
  <table data-section="kavita-mappings">
    <thead><tr><th>Kavita Series</th><th>Title</th><th>MAL ID</th><th>Policy</th><th>Offsets</th><th>Override</th></tr></thead>
    <tbody>${input.mappings.map((mapping) => renderMappingRow(mapping)).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>Kavita Unresolved Matches</h2>
    ${infoIcon("Kavita series needing manual MAL review. These are hidden by default so external read-event testing stays uncluttered.")}
  </div>
  <table data-section="kavita-unresolved">
    <thead><tr><th>Kavita Series</th><th>Title</th><th>Reason</th><th>Approve</th></tr></thead>
    <tbody>${input.reviews.map((review) => renderReviewRow(review)).join("")}</tbody>
  </table>
  <div class="section-head">
    <h2>Ignored Kavita Series</h2>
    ${infoIcon("Kavita series you manually excluded from MAL sync.")}
  </div>
  <p>${input.ignored.length} Kavita series are manually excluded from MAL sync.</p>
  <table data-section="kavita-ignored">
    <thead><tr><th>Kavita Series</th><th>Title</th><th>Reason</th><th>Created</th><th>Restore</th></tr></thead>
    <tbody>${input.ignored.map(renderIgnoredRow).join("")}</tbody>
  </table>`;
}

function renderMappingRow(mapping: SeriesMappingRecord): string {
  const title = mapping.title ?? `Kavita series ${mapping.kavitaSeriesId}`;
  return `<tr><td>${mapping.kavitaSeriesId}</td><td>${escapeHtml(title)}</td><td>${mapping.malId}</td><td>${escapeHtml(mapping.trackingMode)}</td><td>chapter ${mapping.chapterOffset}, volume ${mapping.volumeOffset}</td><td>
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

function renderExternalMappingRow(mapping: ExternalSeriesMappingRecord): string {
  return `<tr><td>${escapeHtml(mapping.readingSourceName)}<br /><code>${escapeHtml(mapping.sourceMangaId)}</code></td><td>${escapeHtml(mapping.title)}</td><td>${mapping.malId}</td><td>${escapeHtml(mapping.trackingMode)}</td><td>chapter ${formatBridgeNumber(mapping.lastObservedChapter)}, volume ${formatBridgeNumber(mapping.lastObservedVolume)}</td><td>chapter ${mapping.lastPushedChapter}, volume ${mapping.lastPushedVolume}</td></tr>`;
}

function renderOutboxRow(
  item: Awaited<ReturnType<SqliteBridgeStore["listOutbox"]>>[number],
): string {
  const action =
    item.status === "failed"
      ? `<form class="outbox-retry-form" data-endpoint="/api/outbox/${encodeURIComponent(item.id)}/retry"><button type="submit">Retry</button></form>`
      : "";
  const target =
    item.targetType === "external"
      ? `${item.targetTitle ? `${escapeHtml(item.targetTitle)}<br />` : ""}<code>${escapeHtml(item.targetKey)}</code>`
      : `Kavita series ${item.kavitaSeriesId}`;
  return `<tr><td>${escapeHtml(item.createdAt)}</td><td>${escapeHtml(item.status)}</td><td>${target}</td><td>${item.malId}</td><td>${escapeHtml(JSON.stringify(item.update))}</td><td>${item.attempts}</td><td>${escapeHtml(item.lastError ?? "")}</td><td>${action}</td></tr>`;
}

function renderSourcePolicyRow(
  policy: Awaited<ReturnType<SqliteBridgeStore["listSourcePolicies"]>>[number],
): string {
  return `<tr><td>${escapeHtml(policy.readingSourceName)}<br /><code>${escapeHtml(policy.readingSourceId)}</code></td><td>
    <form class="source-policy-form" data-endpoint="/api/source-policies/${encodeURIComponent(policy.readingSourceId)}">
      <input name="readingSourceName" value="${escapeHtml(policy.readingSourceName)}" />
      <select name="malEnabled">
        <option value="true"${policy.malEnabled ? " selected" : ""}>enabled</option>
        <option value="false"${!policy.malEnabled ? " selected" : ""}>disabled</option>
      </select>
    </td><td>
      <select name="kavitaMirrorMode">
        <option value="disabled"${policy.kavitaMirrorMode === "disabled" ? " selected" : ""}>disabled</option>
        <option value="kavita-source-only"${policy.kavitaMirrorMode === "kavita-source-only" ? " selected" : ""}>kavita-source-only</option>
        <option value="approved-external-mappings"${policy.kavitaMirrorMode === "approved-external-mappings" ? " selected" : ""}>approved-external-mappings</option>
      </select>
    </td><td><button type="submit">Save</button></form></td></tr>`;
}

function renderReadEventRow(
  event: Awaited<ReturnType<SqliteBridgeStore["listReadEvents"]>>[number],
): string {
  const chapter = event.sourceChapterVolume
    ? `Vol. ${formatBridgeNumber(event.sourceChapterVolume)}, Ch. ${formatBridgeNumber(event.sourceChapterNumber)}`
    : `Ch. ${formatBridgeNumber(event.sourceChapterNumber)}`;
  const kavita =
    event.kavitaSeriesId === undefined
      ? ""
      : `series ${event.kavitaSeriesId}${event.kavitaChapterId === undefined ? "" : `, chapter ${event.kavitaChapterId}`}`;
  return `<tr><td>${escapeHtml(event.receivedAt)}</td><td>${escapeHtml(event.readingSourceName)}<br /><code>${escapeHtml(event.sourceChapterId)}</code></td><td>${escapeHtml(event.readingSourceKind)}</td><td>${escapeHtml(event.sourceTitle || event.sourceMangaId)}</td><td>${escapeHtml(chapter)}</td><td>${escapeHtml(kavita)}</td></tr>`;
}

function formatBridgeNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/u, "");
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
  const candidates = parseReviewCandidates(review.candidatesJson);
  const candidate = firstReviewCandidate(candidates);
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
      ${renderReviewCandidates(candidates)}
    </form>
    <form class="ignore-form" data-endpoint="/api/unresolved-matches/${review.kavitaSeriesId}/ignore">
      <button type="submit">Ignore</button>
    </form>
  </td></tr>`;
}

function renderExternalReviewRow(review: Required<ExternalReviewRecord>): string {
  const candidates = parseReviewCandidates(review.candidatesJson);
  const candidate = firstReviewCandidate(candidates);
  const endpoint = `/api/external-unresolved-matches/${encodeURIComponent(review.readingSourceId)}/${encodeURIComponent(review.sourceMangaId)}/approve`;
  const ignoreEndpoint = `/api/external-unresolved-matches/${encodeURIComponent(review.readingSourceId)}/${encodeURIComponent(review.sourceMangaId)}/ignore`;
  const retryEndpoint = `/api/external-unresolved-matches/${encodeURIComponent(review.readingSourceId)}/${encodeURIComponent(review.sourceMangaId)}/retry-resolution`;
  const noMalEndpoint = `/api/external-unresolved-matches/${encodeURIComponent(review.readingSourceId)}/${encodeURIComponent(review.sourceMangaId)}/no-mal-entry`;
  return `<tr><td>${escapeHtml(review.readingSourceName)}<br /><code>${escapeHtml(review.sourceMangaId)}</code></td><td>${escapeHtml(review.title)}</td><td>${escapeHtml(review.reason)}</td><td>
    <form class="approval-form" data-endpoint="${endpoint}">
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
      ${renderReviewCandidates(candidates)}
    </form>
    <form class="ignore-form" data-endpoint="${ignoreEndpoint}">
      <button type="submit">Ignore</button>
    </form>
    <form class="retry-resolution-form" data-endpoint="${retryEndpoint}">
      <button type="submit">Retry resolution</button>
    </form>
    <form class="no-mal-entry-form" data-endpoint="${noMalEndpoint}">
      <button type="submit">Mark as no MAL entry</button>
    </form>
  </td></tr>`;
}

function reviewResponseItem(
  review: Awaited<ReturnType<SqliteBridgeStore["listReviews"]>>[number],
): Record<string, unknown> {
  return {
    kavitaSeriesId: review.kavitaSeriesId,
    title: review.title,
    reason: review.reason,
    createdAt: review.createdAt,
    candidates: parseReviewCandidates(review.candidatesJson),
  };
}

function externalReviewResponseItem(
  review: Required<ExternalReviewRecord>,
  diagnostics: Awaited<ReturnType<SqliteBridgeStore["listResolverDiagnostics"]>> = [],
): Record<string, unknown> {
  return {
    readingSourceId: review.readingSourceId,
    sourceMangaId: review.sourceMangaId,
    readingSourceName: review.readingSourceName,
    title: review.title,
    reason: review.reason,
    createdAt: review.createdAt,
    candidates: parseReviewCandidates(review.candidatesJson),
    diagnostics: diagnostics.map((entry) => ({
      resolver: entry.resolver,
      outcome: entry.outcome,
      cacheHit: entry.cacheHit,
      cacheKey: entry.cacheKey,
      httpStatus: entry.httpStatus || undefined,
      candidateCount: entry.candidateCount,
      candidateIds: parseJsonArray(entry.candidateIdsJson),
      cached: entry.cached,
      cacheable: entry.cacheable,
      createdAt: entry.createdAt,
      message: entry.message,
    })),
  };
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseReviewCandidates(candidatesJson: string): ScoredMalCandidate[] {
  try {
    const parsed = JSON.parse(candidatesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => reviewCandidateFromUnknown(item));
  } catch {
    return [];
  }
}

function reviewCandidateFromUnknown(item: unknown): ScoredMalCandidate[] {
  if (typeof item !== "object" || item === null) return [];
  const record = item as Record<string, unknown>;
  const malId = Number(record.malId);
  if (!Number.isSafeInteger(malId) || malId <= 0) return [];
  const title = typeof record.title === "string" ? record.title : `MAL ${malId}`;
  const confidence = Number(record.confidence);
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const provenance = Array.isArray(record.provenance)
    ? record.provenance.filter((source): source is string => typeof source === "string")
    : undefined;
  const strength =
    record.strength === "strong" || record.strength === "moderate" || record.strength === "weak"
      ? record.strength
      : confidence >= 0.7
        ? "moderate"
        : "weak";
  return [
    {
      malId,
      title,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      reasons,
      provenance,
      reviewPrefill:
        typeof record.reviewPrefill === "boolean"
          ? record.reviewPrefill
          : confidence >= 0.7 ||
            reasons.includes("exact-title") ||
            reasons.includes("exact-alt-title"),
      strength,
      altTitles: Array.isArray(record.altTitles)
        ? record.altTitles.filter((title): title is string => typeof title === "string")
        : undefined,
      authors: Array.isArray(record.authors)
        ? record.authors.filter((author): author is string => typeof author === "string")
        : undefined,
      mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
      startYear: typeof record.startYear === "number" ? record.startYear : undefined,
      volumes: typeof record.volumes === "number" ? record.volumes : undefined,
      chapters: typeof record.chapters === "number" ? record.chapters : undefined,
    },
  ];
}

function firstReviewCandidate(candidates: ScoredMalCandidate[]): ScoredMalCandidate | undefined {
  return candidates.find((candidate) => candidate.reviewPrefill);
}

function renderReviewCandidates(candidates: ScoredMalCandidate[]): string {
  if (candidates.length === 0) return `<p class="muted">No MAL candidates found.</p>`;
  const actionable = candidates.filter(
    (candidate) => candidate.strength !== "weak" || candidate.reviewPrefill,
  );
  const weak = candidates.filter(
    (candidate) => candidate.strength === "weak" && !candidate.reviewPrefill,
  );
  const safeCandidates =
    actionable.length > 0
      ? renderCandidateList(actionable)
      : `<p class="muted">No safe MAL recommendation. Enter a MAL ID manually only after checking MAL yourself.</p>`;
  const weakDetails =
    weak.length > 0
      ? `<details class="muted"><summary>Show weak search noise</summary>${renderCandidateList(weak)}</details>`
      : "";
  return `${safeCandidates}${weakDetails}`;
}

function renderCandidateList(candidates: ScoredMalCandidate[]): string {
  return `<ul class="muted">${candidates
    .map((candidate) => {
      const confidence = candidate.confidence.toFixed(2);
      const reasons = candidate.reasons.length > 0 ? ` - ${candidate.reasons.join(", ")}` : "";
      const provenance =
        candidate.provenance && candidate.provenance.length > 0
          ? `; sources: ${candidate.provenance.join(", ")}`
          : "";
      const label =
        candidate.strength === "weak"
          ? "Weak suggestion"
          : candidate.strength === "moderate"
            ? "Review suggestion"
            : "Strong suggestion";
      return `<li><strong>${label}</strong>: <code>${candidate.malId}</code> ${escapeHtml(candidate.title)} (${confidence}${escapeHtml(reasons)}${escapeHtml(provenance)})</li>`;
    })
    .join("")}</ul>`;
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

function renderExternalIgnoredRow(
  ignored: Awaited<ReturnType<SqliteBridgeStore["listExternalIgnoredSeries"]>>[number],
): string {
  const restoreEndpoint = `/api/external-ignored-series/${encodeURIComponent(ignored.readingSourceId)}/${encodeURIComponent(ignored.sourceMangaId)}/restore`;
  return `<tr><td>${escapeHtml(ignored.readingSourceName)}<br /><code>${escapeHtml(ignored.sourceMangaId)}</code></td><td>${escapeHtml(ignored.title)}</td><td>${escapeHtml(ignored.reason)}</td><td>${escapeHtml(ignored.createdAt)}</td><td>
    <form class="restore-form" data-endpoint="${restoreEndpoint}">
      <button type="submit">Restore</button>
    </form>
  </td></tr>`;
}

async function respondJson(response: ServerResponse, body: unknown, status = 200): Promise<void> {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function respondHtml(response: ServerResponse, html: string, status = 200): Promise<void> {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  response.end(html);
}

function oauthFailureHtml(message: string): string {
  return `<!doctype html><html><body><h1>MAL authorization failed</h1><p>${escapeHtml(message)}</p><p>Return to the Mutsuki bridge and start authorization again.</p></body></html>`;
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
      maxMalSearchesPerRun: config.maxMalSearchesPerRun,
    });
  };
  const processOutbox = async (): Promise<BridgeOutboxProcessResult> => {
    await refreshStoredMalTokenIfNeeded({ baseConfig, store });
    const config = await effectiveBridgeConfig(baseConfig, store);
    if (!config.malAccessToken) {
      throw new Error("MAL OAuth token is not configured. Authorize MAL before processing outbox.");
    }
    const mal = createMalClient(config);
    return processBridgeOutboxOnce({
      store,
      mal,
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
    processOutbox,
    processReadEvent: async (event, policy, processOptions) => {
      await refreshStoredMalTokenIfNeeded({ baseConfig, store });
      const config = await effectiveBridgeConfig(baseConfig, store);
      const mal = createMalClient(config);
      const resolvers = [
        createMangaDexResolver({ config, store }),
        createWeebCentralResolver({ config, store }),
        ...(config.enableJikanResolver ? [createJikanResolver({ config, store })] : []),
        ...(config.enableAnilistResolver ? [createAnilistResolver({ config, store })] : []),
      ];
      return processExternalReadEvent({
        store,
        mal,
        resolver: composeTitleResolvers(resolvers),
        event,
        policy,
        forceRefreshReview: processOptions?.forceRefreshReview,
      });
    },
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
