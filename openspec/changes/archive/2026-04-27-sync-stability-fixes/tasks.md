## 1. Fix `needsReconciliation` description gating (Thread B)

- [x] 1.1 In `src/sync/engine.ts`, update `needsReconciliation` to skip the summary comparison when `this.config.syncDescriptionFromCalDAV` is falsy
- [x] 1.2 Verify that status and due-date comparisons are unchanged and still fire correctly
- [ ] 1.3 Write or update a unit test confirming that `needsReconciliation` returns `false` when only the description differs and `syncDescriptionFromCalDAV = false`

## 2. Fix stale hash after CalDAV pull (Thread C)

- [x] 2.1 In `updateObsidianTask`, replace `hashTaskContent(task)` with a hash of the written snapshot: construct `{ ...task, description: descriptionToApply, dueDate: updatedData.dueDate ?? task.dueDate, status: updatedData.status }` and hash that
- [x] 2.2 Confirm the fix applies before `setMapping` is called so the persisted mapping reflects written values
- [ ] 2.3 Write or update a unit test verifying the stored hash matches the written description/status/dueDate, not the pre-update task values

## 3. Rate-limit the missing-UID Notice (Thread D)

- [x] 3.1 Add a private `lastMissingUidNoticeShownAt = 0` field and a `MISSING_UID_NOTICE_COOLDOWN_MS = 60 * 60 * 1000` constant to `SyncEngine`
- [x] 3.2 In `fetchAllTasks`, guard the `new Notice(...)` call with `Date.now() - this.lastMissingUidNoticeShownAt > this.MISSING_UID_NOTICE_COOLDOWN_MS`; on show, update `lastMissingUidNoticeShownAt = Date.now()`
- [x] 3.3 Confirm the WARN log entries for missing UIDs are unaffected by the cooldown guard
- [ ] 3.4 Write or update a unit test confirming the Notice is not shown on the second call within the cooldown window

## 4. Verify and test

- [ ] 4.1 Run `npm test && npm run lint` — all tests pass, no lint errors
- [ ] 4.2 Manually verify with a running Obsidian instance: confirm no repeat Notice popup appears on successive auto-syncs when orphaned UIDs are present
- [ ] 4.3 Manually confirm the `bords`/`bord` style data-mismatch loop no longer fires when `syncDescriptionFromCalDAV = false`
