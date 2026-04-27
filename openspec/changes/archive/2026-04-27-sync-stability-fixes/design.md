## Context

The sync engine (`src/sync/engine.ts`) has three interrelated bugs that produce log spam and a Notice popup on every auto-sync cycle:

1. **`needsReconciliation` ignores `syncDescriptionFromCalDAV`**: When that setting is `false`, the plugin intentionally never pulls CalDAV descriptions into Obsidian. Yet `needsReconciliation` still compares summaries, so a 1-char divergence between Obsidian and CalDAV registers as a mismatch every cycle, triggers a "pull from CalDAV" path that immediately writes the Obsidian description back unchanged (because `descriptionToApply = task.description` when the setting is off), and then fires again next cycle.

2. **Stale hash after `updateObsidianTask`**: Even when the CalDAV pull path is correct, `mapping.lastKnownContentHash` is set from the stale in-memory `task` object (pre-update values). If the vault write succeeds, the next scan reads the new vault content, finds a hash mismatch, and detects "Obsidian changed" — which is technically true but spurious. The mapping should reflect what was actually written.

3. **"Not found in calendar" Notice on every auto-sync**: When one or more mapped UIDs are absent from all discovered calendars, a Notice is shown. Since auto-sync runs every minute and the condition is persistent (those UIDs don't self-heal), the popup fires continuously.

## Goals / Non-Goals

**Goals:**
- Silence the `needsReconciliation` description comparison loop when `syncDescriptionFromCalDAV = false`
- Make `lastKnownContentHash` reflect the values actually written to the vault after a CalDAV pull
- Rate-limit the "tasks not found in calendar" Notice to at most once per hour during auto-sync

**Non-Goals:**
- Resolving the orphaned UID mappings themselves (Thread A, deferred)
- Changing any user-visible behavior beyond Notice frequency
- Modifying data persistence format or migration

## Decisions

### D1: Gate description comparison on `syncDescriptionFromCalDAV`

`needsReconciliation` currently compares all three fields (summary, status, due date). When `syncDescriptionFromCalDAV = false`, description divergence is by design — the CalDAV summary drifts from Obsidian over time (e.g., due to CalDAV character limits or normalization). Comparing it produces false positives.

**Decision**: Skip the summary comparison in `needsReconciliation` when `this.config.syncDescriptionFromCalDAV` is falsy. Status and due-date comparisons are unaffected.

**Alternative considered**: Add a separate "ignore description in reconciliation" flag. Rejected — the existing `syncDescriptionFromCalDAV` setting already encodes the intent precisely.

### D2: Hash the written values, not the stale task object

`updateObsidianTask` writes `descriptionToApply`, `updatedData.dueDate`, and `updatedData.status` to the vault, but then records `hashTaskContent(task)` where `task` still holds the pre-update values. This creates a guaranteed hash mismatch on the next scan.

**Decision**: Construct a synthetic `Task`-like snapshot from the values that were written (`descriptionToApply`, resolved dueDate, resolved status) and hash that instead. Since `hashTaskContent` only uses `description`, `dueDate`, and `status`, we can build a minimal object without touching any other `Task` fields.

```typescript
const writtenSnapshot = { ...task, description: descriptionToApply, dueDate: updatedData.dueDate ?? task.dueDate, status: updatedData.status };
mapping.lastKnownContentHash = hashTaskContent(writtenSnapshot);
```

**Alternative considered**: Re-read the file after writing and scan for the task. Rejected — unnecessary I/O, and it adds async complexity for a case already known at the call site.

### D3: In-memory cooldown for the missing-UID Notice

The "not found in calendar" Notice is triggered inside `fetchAllTasks` which runs on every auto-sync cycle. The condition (orphaned mappings) is persistent and won't self-resolve.

**Decision**: Add a private `lastMissingUidNoticeShownAt: number` field (unix ms) to `SyncEngine`, initialized to `0`. Before showing the Notice, check `Date.now() - lastMissingUidNoticeShownAt > COOLDOWN_MS` (1 hour). On first show, record the timestamp. The cooldown resets automatically when Obsidian restarts (field is in-memory only), which is acceptable — a plugin reload is a user action that warrants fresh feedback.

The WARN log entries are unaffected; only the UI popup is rate-limited.

**Alternative considered**: Persist the timestamp to `data.json`. Rejected — the field is informational only and not worth adding to the serialized format.

## Risks / Trade-offs

- **D1**: If a user upgrades from a version where description divergence was "corrected" by the engine, they may now see CalDAV descriptions drift further over time. This is acceptable — the `syncDescriptionFromCalDAV = false` setting already communicates "Obsidian description is authoritative."

- **D2**: The hash now reflects intent (what we wrote) rather than actual vault state. If `updateTaskInVault` writes something different from `descriptionToApply` (e.g., Tasks Plugin normalizes the text), there will still be a hash mismatch next cycle. This is correct behavior — it means a real change occurred that needs to propagate. The bug we're fixing is only the case where the values written match the intent.

- **D3**: For 1 hour after the first Notice, additional orphaned UIDs that appear mid-session won't trigger a Notice. Acceptable — the WARN log remains, and the condition is inherently stable within a session.
