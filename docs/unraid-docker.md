# Unraid Docker Deployment

This guide deploys the production Kavita-to-MyAnimeList bridge.

The bridge polls Kavita as the progress source of truth, maps Kavita series to MAL, receives
Paperback tracker read events, and queues monotonic MAL updates through SQLite. Keep dry-run enabled
until mappings, review queue entries, source policies, and outbox rows look correct.

## Container

Recommended image:

```text
ghcr.io/indigoxred/mutsuki/kavita-mal-bridge:latest
```

Suggested container name:

```text
mutsuki-kavita-mal-bridge
```

The Unraid dockerMan template lives in:

```text
templates/unraid/mutsuki-kavita-mal-bridge.xml
```

Install it as:

```text
/boot/config/plugins/dockerMan/templates-user/my-mutsuki-kavita-mal-bridge.xml
```

That template supplies the WebUI right-click action and editable fields for all supported bridge
environment variables.

Use Unraid's **Add Container** form with these values:

| Setting        | Value                                                 |
| -------------- | ----------------------------------------------------- |
| Repository     | `ghcr.io/indigoxred/mutsuki/kavita-mal-bridge:latest` |
| Network Type   | `bridge`                                              |
| WebUI          | `http://[IP]:[PORT:6768]/`                            |
| Container Port | `6768`                                                |
| Host Port      | `6768` or another free host port                      |
| Appdata Path   | `/mnt/user/appdata/mutsuki-kavita-mal-bridge:/data`   |

Port `8080` is not required. If another app such as qBittorrent already uses `8080`, leave it alone
and map the bridge to `6768`.

## Environment

Set these environment variables in the Unraid template:

```text
PORT=6768
MUTSUKI_BRIDGE_DB=/data/mutsuki-bridge.sqlite
MUTSUKI_BRIDGE_DRY_RUN=true
MUTSUKI_BRIDGE_POLL_INTERVAL_SECONDS=1800
MUTSUKI_BRIDGE_MAX_MAL_SEARCHES_PER_RUN=50
ENABLE_JIKAN_RESOLVER=true
ENABLE_ANILIST_RESOLVER=true
RESOLVER_TIMEOUT_MS=5000
RESOLVER_CACHE_TTL_HOURS=168
RESOLVER_MAX_CANDIDATES_PER_QUERY=8
```

The container can start without Kavita or MAL secrets. Use the Web UI to save credentials after the
container is reachable.

## First Run

1. Open the Web UI:

   ```text
   http://192.168.50.138:6768
   ```

   Replace the IP and port if your Unraid host or host-port mapping differs.

2. In **Settings**, save:

   - Kavita URL, for example `http://192.168.50.138:5000`
   - Kavita API/Auth key
   - MAL OAuth client ID
   - optional MAL OAuth client secret
   - MAL redirect URI
   - poll interval
   - max MAL searches per run
   - dry-run mode

3. Use this redirect URI in both MAL's developer app settings and the bridge UI:

   ```text
   http://192.168.50.138:6768/api/mal/oauth/callback
   ```

4. Click **Authorize MAL** from the bridge UI and complete the MAL OAuth prompt.

5. Click **Check readiness**. MAL should report authorized. Kavita readiness is only required for
   optional Kavita polling; external Paperback read events can still be matched and sent through the
   MAL outbox if Kavita is unreachable.

6. Click **Process MAL outbox now** while dry-run is still enabled to preview already-captured MAL
   work. Use **Run Kavita sync now** only when you specifically want to poll Kavita progress.

7. Review:

   - **Unresolved Matches**
   - **External Unresolved Matches**
   - **External Source Mappings**
   - **Source Policies**
   - **Recent MAL Outbox**
   - **Audit Log**
   - existing mappings and manual overrides

8. Disable dry-run only after the planned MAL updates match what you expect. Dry-run leaves outbox
   rows pending, so the same queued updates can be pushed with **Process MAL outbox now** after you
   switch to live writes.

## Safe Operating Rules

- Do not use the existing Paperback `Mutsuki MyAnimeList` tracker for the same MAL titles while the
  bridge is writing to MAL. Pick one writer so progress updates do not race.
- Low-confidence or conflicting matches stay in the review queue and are not pushed to MAL.
- Official MAL text search is not the only discovery source. Jikan and AniList may discover MAL IDs
  for English or alternate titles, but the bridge validates those IDs through official MAL direct
  lookup before scoring or writing.
- Weak suggestions are not prefilled as approvals. Manual MAL ID entry is a last resort for true
  ambiguity.
- External Paperback source events use a separate mapping/review queue and do not require a Kavita
  match. Disable MAL for a source in **Source Policies** if you only want to observe its read events.
- Kavita mirroring for external sources defaults to disabled so titles that are not in Kavita do not
  clutter Kavita matching/review state.
- New MAL title-search requests are capped per sync run. Existing review-queue entries are skipped
  until you approve, ignore, or override them, so scheduled syncs can advance through large Kavita
  libraries without repeatedly querying MAL for the same unresolved titles.
- If a Kavita series should never sync to MAL, use the review queue's ignore action instead of
  approving a guessed MAL ID. Ignored series can be restored later from the bridge UI.
- MAL progress is monotonic by default. The bridge does not automatically reduce MAL chapter or
  volume counts.
- Light novels default to volume-only tracking unless a mapping policy says otherwise.
- Decimal Kavita volumes are handled conservatively for MAL's integer volume progress field.
- Keep `/data` on persistent appdata storage so OAuth tokens, mappings, outbox rows, and audit logs
  survive container upgrades.
- Do not expose the bridge directly to the public internet without an authenticated reverse proxy or
  equivalent network protection.

## Updating

1. Pull the latest image in Unraid.
2. Restart the container.
3. Confirm the Web UI still shows the expected Kavita configuration, MAL authorization state, dry-run
   setting, mappings, and outbox.
4. Run **Check readiness** before the next write-enabled sync.

The SQLite database is stored under `/data`, so normal image updates should not erase bridge state.

## Troubleshooting

- If the Web UI is unreachable, confirm the host port maps to container port `6768` and no other
  container already owns the host port.
- If sync returns `MAL OAuth token is not configured`, complete **Authorize MAL** again.
- If the wrong MAL account was authorized or MAL keeps rejecting a stored token, use
  **Disconnect MAL**, then complete **Authorize MAL** again.
- If Kavita readiness fails, verify the Kavita URL is reachable from the Unraid host and that the
  stored key is a general API/Auth key rather than an image-only key.
- If mappings are missing, leave dry-run enabled and inspect **Unresolved Matches** before approving
  anything manually.
- If MAL authorization unexpectedly disappears, check **Audit Log**. A permanent OAuth refresh
  failure means MAL rejected the stored refresh token and the bridge cleared it; use **Authorize
  MAL** again.
- If the outbox has failed rows, keep dry-run or write mode unchanged, inspect the sanitized error
  messages, fix the underlying authorization/settings issue, then use the row's **Retry** action to
  place it back in the pending queue.
