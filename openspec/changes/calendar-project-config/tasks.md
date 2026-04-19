## 1. Types and settings schema

- [x] 1.1 Define `DiscoveredCalendar` interface in `src/types.ts` — `{ url: string; displayName: string; ctag?: string; color?: string; supportsVTODO: boolean }`
- [x] 1.2 Add `defaultCalendar: { url: string; displayName: string; ctag?: string } | null` to `CalDAVConfiguration` in `src/types.ts`
- [x] 1.3 Add `calendarUrl: string` to `SyncMapping` and `SerializedSyncMapping` in `src/types.ts`
- [x] 1.4 Mark `calendarPath` in `CalDAVConfiguration` as deprecated (doc-comment only) and remove from `DEFAULT_SETTINGS`; add `defaultCalendar: null` to `src/settings.ts`
- [x] 1.5 Bump `PluginData.version` to the next integer; document the bump in a code comment with a pointer to this change name

## 2. CalDAV client — discovery and per-calendar operations

- [x] 2.1 Add `discoverCalendars(): Promise<DiscoveredCalendar[]>` to `CalDAVClient` (`src/caldav/client.ts`). Perform login, call `fetchCalendars()`, filter to VTODO-supporting calendars (include when `components` is missing), map to `DiscoveredCalendar`
- [x] 2.2 Refactor internal calendar state: replace the single `this.calendar: DAVCalendar | null` with a `Map<string, DAVCalendar>` keyed by exact URL; add a private `getCalendar(url: string): DAVCalendar` helper that throws a typed `CalDAVError` when the URL is unknown
- [x] 2.3 Change `connect()` to populate the calendar map from discovery and resolve the default calendar by **exact URL equality** against `settings.defaultCalendar.url` (no more `cal.url.includes(...)` fallback)
- [x] 2.4 Update `fetchAllTasks()`, `fetchTaskByUid()`, and `fetchTaskRawData()` to accept an explicit `calendarUrl: string` parameter instead of using `this.calendar`
- [x] 2.5 Update `createTask()`, `updateTask()`, `updateTaskWithPreservation()`, and `deleteTask()` to accept an explicit `calendarUrl: string` (resolve internally via `getCalendar`)
- [x] 2.6 Add `copyTaskToCalendar(sourceHref, sourceEtag, destinationCalendarUrl): Promise<CalDAVTask>` implementing the COPY step of the move operation (see design D7)
- [x] 2.7 Update all error-handling branches in `handleConnectionError` / `handleNetworkError` to recognize discovery-specific failures (401/403 from PROPFIND on calendar-home-set)
- [x] 2.8 Remove the "first calendar wins" fallback branch in `connect()` — fail fast with a typed error if `defaultCalendar.url` doesn't match any discovered calendar

## 3. Sync engine — multi-calendar fetch and routing

- [x] 3.1 At the start of a sync cycle, build the fetch set `S = {every calendar URL in the in-memory discovery cache}` (not just mapped/default — see design D4 and D5)
- [x] 3.2 Replace the single `fetchAllTasks()` call with parallel per-calendar fetches (bounded concurrency of 4, `Promise.all` with a simple semaphore or chunked loop)
- [x] 3.3 For previously discovered calendars now missing from a fresh discovery, log a warning via `Logger.warn` and skip that calendar; do not abort the cycle
- [x] 3.4 Route writes by looking up `mapping.calendarUrl` for existing tasks; route writes for brand-new tasks to `settings.defaultCalendar.url`
- [x] 3.5 On mapping creation (first push), set `calendarUrl` on the new `SyncMapping`
- [x] 3.6 Surface a user-visible summary in the sync completion notice when ≥1 calendar was skipped due to "unknown calendar"

### Remote-move detection (design D5)

- [x] 3.7 After fetching, build a `uid → { observedCalendarUrl, observedHref, lastModified, data }[]` map spanning all fetched calendars
- [x] 3.8 For each mapping whose `caldavUid` is observed, resolve the observed calendar URL by matching the object href against cached calendar URLs (longest-prefix match); if `observedCalendarUrl !== mapping.calendarUrl`, update `mapping.calendarUrl` and `mapping.caldavHref` **in-memory before reconcile runs any writes**
- [x] 3.9 When a single `caldavUid` is observed in more than one calendar, pick the entry with the most recent `LAST-MODIFIED`, point the mapping at it, and log a warning listing every calendar the UID appeared in (no auto-delete of duplicates)
- [x] 3.10 When a mapping's `caldavUid` is not observed in any discovered calendar, preserve the mapping untouched and emit a single per-cycle notice suggesting the user click "Discover calendars" (a new calendar may have been created server-side)
- [x] 3.11 Persist the updated mappings at the end of the cycle through the existing `saveMappings()` path — remote-move updates go out alongside normal sync-metadata updates

## 4. Mapping storage — migration and persistence

- [x] 4.1 Update `loadMappings()` in `src/sync/mapping.ts` to read `calendarUrl` from serialized data, defaulting to empty string for legacy records
- [x] 4.2 Update `saveMappings()` to write `calendarUrl` on every serialized mapping
- [x] 4.3 Add a one-shot `backfillCalendarUrlForLegacyMappings(url: string)` helper that sets `calendarUrl = url` on every in-memory mapping missing it, then persists — called only during migration

## 5. Plugin data migration

- [x] 5.1 In `src/main.ts` (or wherever `PluginData` is loaded), detect old-version data by checking `version < newVersion` OR `settings.defaultCalendar == null && settings.calendarPath != ""`
- [x] 5.2 Implement `migrateCalendarPath()`: attempt discovery, match `calendarPath` against discovered calendars (single-substring-match rule), and either (a) adopt + back-fill mappings + clear `calendarPath` + save, (b) show a persistent Notice and disable auto-sync, or (c) defer on network failure
- [x] 5.3 Call migration before sync scheduler start; if migration defers, register a one-time "retry on next successful discovery/test-connection" hook
- [ ] 5.4 Unit-test migration with fixtures: exact match, multi-match, no-match, discovery-failure

## 6. Settings UI

- [x] 6.1 In `src/ui/settingsTab.ts`, remove the "Calendar path" `Setting` text row (`addConnectionSection`, ~line 96)
- [x] 6.2 Add a "Default calendar" `Setting` with a dropdown (`addDropdown`) plus a "Discover calendars" button (`addButton`) on the same row
- [x] 6.3 Implement the dropdown state machine from design D8 (no-default+no-cache → disabled, has-default+no-cache → stored-only, etc.)
- [x] 6.4 Wire the Discover button to call `CalDAVClient.discoverCalendars()`, cache the result on the settings tab instance (not in `data.json`), repopulate the dropdown, and surface auth / network errors inline via `setDesc()` or a transient status element
- [x] 6.5 Persist selection on change: update `settings.defaultCalendar` with `{ url, displayName, ctag }` and call `saveSettings()`; re-initialize the sync engine's client with the new default
- [x] 6.6 If `settings.defaultCalendar` is null when the user clicks "Test connection", keep the test call working (login only, no calendar-level ops) but display a reminder that a default calendar must be picked before sync can run
- [x] 6.7 Show a banner row when mappings reference an "unknown calendar" (resolved from the per-cycle warning in 3.3), with a "Clear stale mappings" affordance

## 7. Move task command

- [x] 7.1 Add a palette command "CalDAV: Move task to calendar…" in `src/main.ts` that opens a destination-calendar picker modal listing calendars from the last discovery
- [x] 7.2 Add a file-menu / task context-menu entry for the same command, enabled only on lines that resolve to a known `SyncMapping`
- [x] 7.3 Implement `moveTask(blockId, destinationCalendarUrl)` in `src/sync/engine.ts`: call `CalDAVClient.copyTaskToCalendar`, then `deleteTask`, then update the mapping's `calendarUrl` + `caldavHref`; persist
- [x] 7.4 Handle the "copy succeeded but delete failed" case: emit a warning notice listing both calendars, keep the mapping pointing at the original, require manual resolution
- [x] 7.5 Hide / disable the command if no discovery has ever succeeded (empty calendar cache)

## 8. Tests

- [ ] 8.1 Unit tests for `CalDAVClient.discoverCalendars()` with mocked tsdav responses: pure-VTODO, mixed VEVENT+VTODO, VEVENT-only, missing `components`, auth failure, network failure
- [ ] 8.2 Unit tests for migration logic in 5.2 covering all four branches in design D5
- [ ] 8.3 Integration-style test for sync engine fan-out across two calendars using a fake client — verify fetch, write, and delete each route to the expected calendar
- [ ] 8.4 Remote-move detection test: UID `X` starts in calendar A, fake client returns it in calendar B on the next fetch → mapping's `calendarUrl` and `caldavHref` update, subsequent write goes to B, no duplicate VTODO created
- [ ] 8.5 Remote-move with concurrent local edit: UID `X` moves A → B, Obsidian-side summary also changed → conflict resolver runs, winning write lands on B
- [ ] 8.6 Duplicate-UID test: UID observed in both A and B → mapping points at the most-recently-modified copy, warning logged, neither copy deleted
- [ ] 8.7 Unknown-calendar test: UID mapped but not found anywhere in the discovery cache → mapping preserved, single notice emitted, sync does not error
- [ ] 8.8 Unit tests for `moveTask` happy path plus the copy-ok/delete-fail branch
- [ ] 8.9 Mapping round-trip test: save → load → save preserves `calendarUrl`; legacy data (no `calendarUrl`) round-trips cleanly after back-fill

## 9. Docs and cleanup

- [ ] 9.1 Update README connection-setup section: remove instructions for finding the calendar path, replace with Discover-calendars walkthrough
- [ ] 9.2 Add a short "Migrating from the old Calendar Path field" note in README or the settings-tab help callout
- [ ] 9.3 Run `npm run lint` and `npm test` locally; fix any errors surfaced by the new types / settings fields
- [ ] 9.4 Remove any dead code paths referencing `calendarPath` once migration is proven (search: `calendarPath`, `cal.url.includes`)
