## Context

The plugin currently couples its sync pipeline to a single calendar identified by a free-text path string. `CalDAVClient.connect()` caches exactly one `DAVCalendar` by calling `cal.url.includes(this.config.calendarPath)` with a "first calendar wins" fallback (`src/caldav/client.ts:113-136`) — so typos or renamed collections silently route syncs to an unrelated calendar. Every subsequent read/write uses `this.calendar` directly, meaning the single-calendar assumption is pervasive in `client.ts`, `engine.ts`, and the settings UI.

Two requests converge in this change:

1. **Immediate**: get rid of the Calendar Path text field; discover calendars from the server and offer a dropdown, in line with how Planify (the referenced Linux task app) handles account setup.
2. **Foreseeable**: allow the same Obsidian vault to sync tasks across multiple calendars on the same server, and guarantee that a task never jumps between calendars on its own. This is the "link should be kept" part of the user's request.

The upstream library, tsdav, already supports discovery via `DAVClient.fetchCalendars()` and operates on an explicit `DAVCalendar` per call (see the `MinimalDAVClient` interface at `src/caldav/client.ts:44-61`). The barrier has been data-model and UX, not protocol.

Existing `SyncMapping` stores `caldavHref` (the full VTODO URL) but not the owning calendar URL. Because `caldavHref` is the object URL, we can derive a calendar URL by stripping the final path segment — but that's fragile against server URL rewriting (Nextcloud uses `/remote.php/dav/calendars/...`, Radicale uses `/<user>/<uuid>/`, iCloud uses opaque IDs). Storing `calendarUrl` explicitly is cheaper and more reliable.

## Goals / Non-Goals

**Goals:**

- Replace manual `calendarPath` entry with server-driven discovery and a dropdown populated from the user's principal home-set.
- Identify calendars by exact URL, not substring matches, to eliminate the silent "first calendar" fallback.
- Let `SyncMapping` encode which calendar owns a VTODO, so sync operations stay routed to the correct collection for the life of the task.
- Provide a seamless upgrade path for users who already have `calendarPath` configured and active mappings.
- Keep the feature surface compatible with tsdav's existing API — no new dependencies.

**Non-Goals:**

- Automatic calendar creation, renaming, or deletion from within Obsidian. Users continue to manage calendars in their CalDAV provider's UI.
- Per-folder / per-tag calendar routing rules (e.g. "tasks in `work/` sync to calendar X"). This may come later; the data model in this change will not block it.
- Read-only / shared-calendar support. Discovery filters to writable VTODO calendars.
- Multi-account / multi-server configuration in a single plugin instance.
- Background periodic re-discovery. Users trigger discovery explicitly; a stored ctag is recorded only to give a later "something changed" hint — it is not wired into a polling loop in this change.

## Decisions

### D1: Discovery uses `tsdav.DAVClient.fetchCalendars()` with VTODO filtering in-memory

`tsdav` already does the heavy lifting (principal lookup, calendar-home-set, PROPFIND, parsing `supported-calendar-component-set`). We extend `CalDAVClient` with a public `discoverCalendars()` method that:

1. Logs in with the current credentials (reuse of the existing `connect()` auth path).
2. Calls `fetchCalendars()`.
3. Filters client-side to calendars whose `components` array includes `"VTODO"`. The tsdav `DAVCalendar` type exposes this via `components`; if a server omits the property, we include the calendar (false positive is better than hiding a usable one — the user can always skip it in the dropdown).
4. Returns `DiscoveredCalendar[]`: `{ url: string, displayName: string, ctag?: string, color?: string }`. Display name falls back to the last URL segment if absent.

Alternative considered: write our own PROPFIND via `requestUrl`. Rejected — duplicates tsdav logic and doesn't buy us anything for the supported providers we care about (Nextcloud, Radicale, Fastmail, iCloud, SOGo).

### D2: Persisted default calendar is a structured record, not a path

New shape on `CalDAVConfiguration`:

```ts
defaultCalendar: { url: string; displayName: string; ctag?: string } | null;
// calendarPath is removed after migration (see D6).
```

The URL is authoritative. `displayName` is cached so the dropdown can render a stored selection before re-discovery completes. `ctag` is optional and used only as a hint — it is not load-bearing in this change.

Alternative considered: store just the URL and re-resolve `displayName` lazily. Rejected — users opening the settings tab offline should still see a recognizable name.

### D3: Every mapping carries `calendarUrl`

Extend both `SyncMapping` and `SerializedSyncMapping` with `calendarUrl: string`. All sync code paths (create, update, delete, read) must consult the mapping rather than a single cached `this.calendar`.

The existing `caldavHref` is a per-object URL. We could in principle compute `calendarUrl = dirname(caldavHref)` on demand, but:

- Server URL rewriting means "dirname" isn't always the true calendar URL (Nextcloud's rewriting, provider proxies).
- We need the calendar URL independently of ever having seen the object (e.g. to fetch from a calendar even when the mapping's `caldavHref` points at a now-deleted VTODO).

So explicit storage wins on correctness and costs ~50 bytes per mapping.

### D4: Sync engine fetches from every discovered calendar

Per cycle:

1. Resolve the fetch set `S` = the full set of calendars in the current discovery cache. This is a deliberate widening over the more conservative "default ∪ mapped" set: it is the only way to detect tasks that were moved server-side from calendar A to calendar C when C has no mappings yet (see D5).
2. For each URL in `S`, look up the cached `DAVCalendar`. Calendars that were previously discovered but are now gone (deleted server-side) are dropped with a warning — the cycle continues.
3. Fan out `fetchCalendarObjects` calls (`Promise.all`, bounded concurrency of 4 to avoid overloading smaller CalDAV servers like Radicale).
4. Merge the results, keyed by UID, into the existing reconciliation pipeline. The rest of the engine is UID-driven already.

Writes and deletes look up the mapping by `blockId`, grab its `calendarUrl`, and use the corresponding cached `DAVCalendar` instance — **after** the reconcile step in D5 has had a chance to update `calendarUrl` for remote moves. Ordering matters: detect the move, then write.

Alternative considered: keep the narrower "default ∪ mapped" fetch set and only do a broader search on cache miss. Rejected — more complex for no real benefit in the common case (most users have 1–3 calendars), and it fails outright for users whose calendar inventory grew after the last mapping was created.

Alternative considered: a single combined REPORT across calendars. Rejected — not supported uniformly by CalDAV servers; per-calendar REPORTs are the portable path.

### D5: Remote-move detection during reconcile

Primary user scenario: create task in Obsidian → syncs to default calendar → user moves it to a different list in another CalDAV client → next sync must still work, mapping must follow the move, no Obsidian-side re-linking required.

Detection runs inside the reconcile step, right after the D4 fetch:

1. For every mapping with a remote counterpart observed in the fetch results, derive `observed.calendarUrl` by resolving the object URL against the discovery cache (prefix-match against known calendar URLs), and compare against `mapping.calendarUrl`.
2. If they differ → it's a remote move. Update `mapping.calendarUrl` and `mapping.caldavHref` in-memory **before** any outbound write in this cycle, so updates in the same cycle land on the new calendar.
3. If the same `caldavUid` is observed in more than one calendar (partial move left a duplicate) → pick the copy with the most recent `LAST-MODIFIED`, point the mapping at it, log a warning listing the other calendars. Do not auto-delete duplicates — we never saw the user create them and can't infer intent.
4. If a mapping's `caldavUid` is not observed in any discovered calendar → preserve the mapping untouched and emit a single per-cycle notice suggesting the user run Discover calendars (the task may have been moved to a calendar created after the last discovery). Do not delete the mapping.

Why in-memory update before persistence: conflict resolution may still run against the moved remote copy in this same cycle. Local edit vs remote-at-new-location is compared with the existing conflict resolver, and the winning write is sent to the new calendar — never the old one. Persistence of the updated mapping happens at the end of the cycle alongside every other mapping update.

Identity anchor is the CalDAV `UID`, which is stable across calendar moves on all major providers (Nextcloud, Radicale, Fastmail, iCloud, SOGo). This is why silent re-linking is safe: the UID match proves it's the same task.

Alternative considered: require users to trigger a manual "re-link" when a move is detected. Rejected — contradicts the stated goal that the link is kept automatically.

Alternative considered: track moves via server-side `sync-collection` / ctag reports. Rejected for this change — works on Nextcloud and Radicale but isn't uniformly supported elsewhere; the UID-based reconcile is portable and piggybacks on work we're already doing.

### D6: Migration is best-effort on first load post-upgrade

On plugin load, if `settings.calendarPath` is non-empty and `settings.defaultCalendar` is null:

1. Attempt discovery using existing credentials.
2. If exactly one calendar URL contains `calendarPath` as a substring → adopt it as `defaultCalendar`, clear `calendarPath`, back-fill every existing mapping's `calendarUrl` to the adopted URL, bump plugin data version, save.
3. If zero matches or more than one match → show a persistent (but non-modal) `Notice` directing the user to settings. Keep `calendarPath` as a legacy hint. Disable auto-sync (`enableAutoSync = false`) until the user picks one manually; this prevents silently syncing to the wrong calendar.
4. If discovery fails (offline, 401, network) → defer migration. Retry opportunistically on the next successful Test Connection or Discover Calendars action.

The back-fill in step 2 is the critical piece. Users with existing mappings upgrading in-place must not have their tasks "orphaned" by the new fetch-per-calendar logic.

Alternative considered: block startup on migration. Rejected — offline/intermittent users would lose access to their settings entirely.

### D7: "Move task to calendar" is COPY + DELETE, not MOVE

CalDAV has no portable MOVE semantics between calendars. We implement it as:

1. Fetch the source VTODO's raw data.
2. `createCalendarObject` on the destination calendar with the **same UID** (servers permit this because the resource URL is different, and UID conflict within a calendar is the only hard rule).
3. On success, `deleteCalendarObject` on the source.
4. Update the mapping's `calendarUrl` and `caldavHref`; keep `caldavUid` and `blockId`.

Failure between 2 and 3 leaves duplicates — handled by the "Move failure is transactional" scenario in the spec: surface a warning and let the user decide. We don't try to auto-rollback because a partial network failure might mean the delete actually succeeded but we didn't see the response.

### D8: Settings UI keeps connection fields ungated by discovery

The `serverUrl` / `username` / `password` inputs continue to accept free-text input. Discovery is a separate explicit button. This matters because:

- Users often enter credentials before the server is reachable (plane, VPN down).
- Changing the server URL should not blow away a working default-calendar selection until discovery successfully runs against the new URL.

State machine for the dropdown:

```
no-default + no-cache          → disabled, placeholder "Click Discover calendars"
no-default + cached discovery  → enabled, no selection
has-default + no-cache         → enabled, shows stored displayName, single option
has-default + cached discovery → enabled, stored calendar pre-selected among real options
discovering                    → disabled, spinner on Discover button
```

## Risks / Trade-offs

- **[Risk] Silent mapping back-fill targets the wrong calendar for multi-calendar existing users.** → Mitigation: only auto-migrate when exactly one discovered calendar matches the legacy path substring; otherwise prompt. In practice pre-feature users only ever had one calendar (the setting only supports one), so the ambiguous-match case is rare.
- **[Risk] Servers that omit `supported-calendar-component-set` get shown as VTODO calendars even if they're event-only.** → Mitigation: include-on-missing is safer than exclude-on-missing; show a "This calendar may not support tasks" hint in the dropdown when the property is absent.
- **[Risk] Calendar deleted server-side leaves orphan mappings.** → Mitigation: log-and-skip (never abort sync), surface an "N mappings reference unknown calendar X" message in settings with a "Clear" action. Do not auto-delete mappings — user may have deleted the calendar accidentally.
- **[Risk] iCloud / Fastmail rate-limit discovery.** → Mitigation: discovery is user-triggered, not on every sync; cache results in memory for the session; don't re-discover on every settings tab open.
- **[Risk] The union-fetch logic (D4) can balloon request count for users with many one-off calendars.** → Mitigation: bounded concurrency of 4; most users have 1-3 calendars; document that per-task calendar routing increases network traffic linearly.
- **[Trade-off] `calendarUrl` duplicated across mappings.** → Accepted. Simpler than normalizing into a separate map; negligible storage cost.
- **[Trade-off] Move is not transactional.** → Accepted and documented. The alternative (server-side atomic move) is not portable across CalDAV implementations.

## Migration Plan

1. **Schema bump**: plugin data `version` increments (pick next integer above current). Load-time migration runs before sync engine boot.
2. **Forward migration** (see D6):
   - Attempt discovery with stored credentials.
   - Resolve `calendarPath` → `defaultCalendar`.
   - Back-fill `calendarUrl` on every `SerializedSyncMapping`.
   - Persist. Never mutate `data.json` in place; write to temp + rename via Obsidian's `saveData()`.
3. **Rollback**: if the user downgrades to a pre-feature plugin version, the new `defaultCalendar` and `calendarUrl` fields are ignored by older code; `calendarPath` was removed on successful migration but can be restored by manual edit. We will not provide an automatic downgrade path — users who downgrade must re-enter the calendar path. This is an acceptable cost because the feature is a settings UX change, not a protocol change.
4. **Docs**: update README connection-setup section and add a short migration note referencing this change.

## Open Questions

- Should the "Move task to calendar" command be exposed from day one, or gated behind an experimental flag until multi-calendar sync has run in the wild? Leaning toward "ship it" since the COPY+DELETE logic is small and reviewable — but flagging for explicit call-out during implementation.
- When discovery returns a calendar with a user-chosen display name containing characters the Obsidian dropdown can't render cleanly (RTL text, emojis), do we sanitize or pass through? Proposal: pass through; Obsidian's native UI handles arbitrary strings.
- Do we need to record the server's principal URL alongside `defaultCalendar` for users who change `serverUrl` to a different tenant? Out of scope; single-account assumption holds.
