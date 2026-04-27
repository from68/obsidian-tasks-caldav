## Why

Every sync cycle produces spurious warnings and a popup Notice due to three bugs: `needsReconciliation` ignores the `syncDescriptionFromCalDAV` setting and endlessly "detects" intentional description divergence; the hash recorded after pulling CalDAV changes is computed from the stale in-memory task rather than what was written; and the "tasks not found in calendar" Notice fires on every auto-sync instead of once.

## What Changes

- **`needsReconciliation` gating**: Skip description comparison when `syncDescriptionFromCalDAV = false`, because description divergence is intentional in that mode and not a mismatch to fix.
- **Hash correctness after CalDAV pull**: In `updateObsidianTask`, compute `lastKnownContentHash` from the data actually written (the CalDAV-derived values) rather than the stale `task` object still holding pre-update content.
- **Notice rate-limiting**: The "some synced tasks not found in calendar" Notice is suppressed for auto-sync runs after the first occurrence within a cooldown window (e.g., 1 hour), so it doesn't fire on every minute-interval auto-sync.

## Capabilities

### New Capabilities

- `sync-notice-rate-limit`: Rate-limiting mechanism that prevents the "tasks not found in calendar" Notice from appearing more than once per cooldown window during auto-sync.

### Modified Capabilities

- `file-logger`: No requirement changes — the underlying log WARNs remain; only the user-facing Notice frequency changes.

## Impact

- `src/sync/engine.ts`: `needsReconciliation`, `updateObsidianTask`, `fetchAllTasks` (Notice logic)
- No new dependencies
- No breaking changes to public API or data format
