# Mutsuki Kavita MAL Bridge

This is the Phase 2 production bridge foundation. It runs outside Paperback, polls Kavita as the
progress source of truth, automatically maps Kavita series to MyAnimeList when confidence is high,
receives normalized Paperback tracker events, and queues monotonic MAL progress updates through a
SQLite-backed outbox.

## Current Capabilities

- SQLite persistence for mappings, review queue, outbox, audit logs, Paperback read events, and
  per-source policies.
- Local setup UI for Kavita, MAL OAuth client settings, dry-run mode, and poll interval.
- `POST /api/progress-events` for events forwarded by Mutsuki Progress Bridge.
- Source policy controls for MAL enable/disable and optional Kavita mirroring.
- MAL OAuth callback handling with persisted access/refresh tokens.
- MAL OAuth disconnect/re-authorize support for stale or incorrect tokens.
- Token refresh before scheduled/manual sync runs.
- Deterministic MAL matching from existing Kavita MAL URLs/IDs and AniList IDs/links.
- Strict high-confidence title matching.
- Review queue and manual approval controls for ambiguous or low-confidence matches, including
  parsed candidate lists with confidence reasons.
- Manual ignore and restore controls for unresolved series which should not sync to MAL.
- Manual override controls for existing mappings, offsets, tracking policies, and persisted Kavita
  titles.
- Manual retry controls for failed MAL outbox rows after settings, authorization, or transient MAL
  issues are corrected.
- Lightweight Kavita readiness checks and MAL OAuth authorization checks.
- Manga defaults to chapter-and-volume tracking.
- Light novels default to volume-only tracking.
- Monotonic high-water MAL update planning with offsets.
- Dry-run mode enabled by default; dry-run previews leave MAL outbox rows pending so disabling
  dry-run later can still push the same updates.
- Scheduled polling with overlap prevention and live poll-interval rescheduling from the setup UI.
- Configurable MAL title-search cap per sync run, with existing review-queue entries skipped until
  resolved.
- Local Web/API status, setup, outbox, audit, unresolved-match, source-policy, and Paperback
  read-event views.

## Docker

```bash
cd apps/kavita-mal-bridge
docker compose -f docker-compose.example.yml up
```

Open:

```text
http://<docker-host-ip>:6768
```

Minimum environment:

```text
MUTSUKI_BRIDGE_DRY_RUN=true
```

The container can start without Kavita or MAL secrets so the setup UI is reachable. Save these in
the Web UI:

- Kavita URL and Kavita Auth/API key
- MAL OAuth client ID, optional client secret, and redirect URI
- poll interval
- max MAL searches per run
- dry-run mode

For MAL OAuth, create a MAL API client and use a redirect URI that points back to the bridge, for
example:

```text
http://192.168.50.138:6768/api/mal/oauth/callback
```

After saving the MAL client settings, use **Authorize MAL** on the bridge page. Keep dry-run enabled
until the UI shows the expected mappings and queued updates. Dry-run syncs preview pending MAL writes
without marking them succeeded, so the same outbox rows can be pushed after you disable dry-run. Use
**Check readiness** to verify the configured Kavita endpoint can be queried with a lightweight probe
and the stored MAL token is accepted before running a sync.
Manual and scheduled sync runs require both Kavita configuration and a stored MAL OAuth token; the
bridge will not poll the full library for mappings until MAL is authorized.
If the wrong MAL account is authorized or MAL rejects the stored token, use **Disconnect MAL** and
then run **Authorize MAL** again.
If MAL reports a permanent refresh failure for the stored OAuth token, the bridge clears that token
and asks you to authorize MAL again. Retryable MAL token endpoint failures keep the existing token so
the next scheduled/manual sync can try again.

To test Paperback tracker events, point the Mutsuki Progress Bridge tracker extension at this same
base URL. The bridge records those events under **Recent Paperback Read Events**. External sources
default to `Kavita mirror: disabled`, so reads from sources that are not in Kavita do not create
Kavita mismatch clutter. The MAL polling path remains Kavita-based until the external read-event
matching worker is enabled in a later pass.

## API

- `GET /api/status`
- `GET /api/readiness`
- `GET /api/mappings`
- `GET /api/unresolved-matches`
- `GET /api/outbox`
- `GET /api/audit-log`
- `GET /api/progress-events`
- `POST /api/progress-events`
- `GET /api/source-policies`
- `POST /api/source-policies/:readingSourceId`
- `POST /api/sync/run`
- `POST /api/settings`
- `POST /api/outbox/:outboxId/retry`
- `GET /api/mal/oauth/start`
- `GET /api/mal/oauth/callback`
- `POST /api/mal/oauth/disconnect`
- `POST /api/unresolved-matches/:kavitaSeriesId/approve`
- `POST /api/mappings/:kavitaSeriesId`

## Unraid Notes

Use container port `6768` and map it to host port `6768` or another free host port. Store
`/data` on persistent appdata storage so the SQLite database survives container upgrades.

The detailed Unraid template and first-run checklist lives in
`../../docs/unraid-docker.md`.
