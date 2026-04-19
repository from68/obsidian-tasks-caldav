## Why

Today, users must manually type the full CalDAV calendar URL path (e.g. `/dav/calendars/user/tasks/`) into settings. That value is brittle: it varies by server (Nextcloud, Radicale, Fastmail, iCloud all use different layouts), is typically buried in the provider's web UI, and silently falls back to "first calendar found" when wrong (`src/caldav/client.ts:120-136`) — so users don't even learn their path is incorrect.

Reference todo apps (e.g. [Planify](https://github.com/alainm23/planify)) instead let the user enter only a base URL, discover the available calendars (aka "lists" / "projects"), and pick one from a dropdown. This is both easier to set up and future-proof for syncing tasks to multiple calendars, since per-task routing only becomes possible once the plugin understands the calendar inventory.

## What Changes

- Add a **Discover calendars** action in settings that calls CalDAV discovery against `serverUrl` + credentials and lists every writable VTODO-supporting calendar with display name, color, and URL.
- Add a **Default calendar** dropdown populated from discovery results. Newly created tasks sync to this calendar by default.
- **BREAKING (soft)**: deprecate the free-text `calendarPath` setting. Existing configured paths are migrated by matching against discovered calendars on first run after upgrade; if no match is found the user is prompted to pick one.
- Persist the chosen calendar as a structured record (display name + URL + ctag) rather than a substring path, so downstream code stops guessing via `cal.url.includes(...)`.
- Extend `SyncMapping` with a `calendarUrl` field so each task remembers which calendar holds its VTODO. Sync operations target that per-task calendar, not the default one.
- Update the sync engine to fetch VTODOs from every calendar that holds at least one mapped task, merge the results, and continue to write new tasks to the default calendar.
- Add a lightweight "Move task to calendar" command (palette + context menu) that re-hosts a VTODO from one calendar to another while preserving its UID-based mapping.

Out of scope for this change: per-folder or per-tag calendar routing rules, calendar creation from within Obsidian, read-only calendar support, CalDAV collection-set discovery beyond the user's principal.

## Capabilities

### New Capabilities
- `calendar-discovery`: Discover writable VTODO calendars from a CalDAV server given base URL + credentials, surface them in settings UI, and persist the selected default calendar.
- `multi-calendar-sync`: Route sync operations per-task based on a stored calendar mapping, allowing the same vault to sync tasks across multiple calendars on the same server while preserving each task's original calendar link.

### Modified Capabilities
<!-- None. No existing capability specs exist yet in openspec/specs/. -->

## Impact

- **Settings schema** (`src/types.ts`, `src/settings.ts`): `calendarPath: string` replaced by `defaultCalendar: { url, displayName, ctag } | null`; `SyncMapping` gains `calendarUrl: string`; plugin data version bumped with a migration path.
- **CalDAV client** (`src/caldav/client.ts`): add `discoverCalendars()` returning structured metadata; `connect()` selects calendar by exact URL match (not substring); new helpers to operate on an arbitrary calendar rather than the single cached one.
- **Sync engine** (`src/sync/engine.ts`): fetch loop iterates mapped calendars ∪ default; writes and deletes target the mapping's `calendarUrl`.
- **Settings UI** (`src/ui/settingsTab.ts`): replace the Calendar Path text field with a dropdown + Discover button; surface discovery/migration errors inline.
- **Plugin data migration**: one-time migration on upgrade that resolves the old `calendarPath` against a fresh discovery call.
- **Dependencies**: no new dependencies — `tsdav` already exposes `fetchCalendars()` (see `src/caldav/client.ts:113`).
- **Docs**: README connection-setup section needs updating to reflect the new flow.
