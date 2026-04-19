## ADDED Requirements

### Requirement: Sync mapping records owning calendar
Every `SyncMapping` SHALL include a `calendarUrl` field identifying the calendar that owns the remote VTODO, so that subsequent syncs operate on the original calendar rather than the current default.

#### Scenario: New mapping captures default calendar
- **WHEN** a new Obsidian task is pushed to CalDAV for the first time
- **THEN** the resulting `SyncMapping` records `calendarUrl` equal to the `settings.defaultCalendar.url` used for the create call

#### Scenario: Existing mappings migrate on first load
- **WHEN** plugin data is loaded from a version that predates this feature (no `calendarUrl` on mappings)
- **THEN** each legacy mapping SHALL be back-filled with `calendarUrl` set to the resolved default calendar's URL, preserving behavior for users who only ever used one calendar

### Requirement: Fetch from every discovered calendar
During a sync cycle, the plugin SHALL fetch VTODOs from every calendar currently in its discovery cache — NOT just the default calendar or the set of calendars referenced by existing mappings — so that tasks moved between calendars by other CalDAV clients are still observed.

#### Scenario: Tasks in secondary calendar are reconciled
- **WHEN** a mapping references a calendar that is NOT the current default
- **THEN** that calendar's VTODOs are still fetched and matched against mappings so that updates flow bidirectionally regardless of where the task lives

#### Scenario: Task moved server-side into a previously unused calendar is found
- **WHEN** another CalDAV client moves a task from calendar A to calendar C, where C is in the plugin's discovery cache but has never previously hosted any mapped task
- **THEN** the task's UID is still found during sync because the fetch set is "all discovered calendars", not "mapped calendars only"

#### Scenario: Disappeared calendar logs and skips
- **WHEN** a calendar present in a prior discovery result is no longer returned (e.g. deleted server-side)
- **THEN** the sync engine SHALL log a warning, skip that fetch without aborting the sync cycle, leave any mappings pointing at it intact, and flag the mappings as stale in the settings UI

#### Scenario: Unknown calendar triggers re-discovery suggestion
- **WHEN** a mapping's expected task (by UID) is not found in ANY discovered calendar during a sync cycle
- **THEN** the plugin SHALL emit a single user-visible notice suggesting the user click "Discover calendars" (the task may have been moved to a calendar created after the last discovery), and SHALL preserve the mapping as-is rather than deleting it

### Requirement: Remote move between calendars updates the mapping
When a task's VTODO is observed in a different calendar than the one recorded on its mapping, the plugin SHALL treat this as a remote move: it updates the mapping's `calendarUrl` and `caldavHref` to the new location, preserves the mapping's `blockId` and `caldavUid`, and continues syncing to the new calendar on subsequent cycles.

#### Scenario: Task moved remotely keeps its Obsidian link
- **WHEN** a user moves a task from calendar A to calendar B in another CalDAV client (e.g. Thunderbird, Apple Reminders, a web UI)
- **AND** the next sync cycle fetches both calendars
- **THEN** the plugin detects the same `caldavUid` now living at a `caldavHref` under calendar B, updates `mapping.calendarUrl` and `mapping.caldavHref` accordingly, and the Obsidian task continues to sync bidirectionally without the user re-linking it

#### Scenario: Same UID appears in multiple calendars
- **WHEN** a single `caldavUid` is found in more than one discovered calendar during the same sync cycle (e.g. an incomplete server-side move left a duplicate)
- **THEN** the plugin SHALL pick the copy with the most recent `LAST-MODIFIED` timestamp, point the mapping at that copy, log a warning listing the other calendar(s), and NOT attempt to delete the duplicates automatically

#### Scenario: Remote move does not lose local changes
- **WHEN** a remote move is detected in the same sync cycle as an un-pushed local edit on the same task
- **THEN** conflict resolution runs against the remote copy at its new location using the existing conflict resolver (local change vs remote change), and the final write goes to the new calendar — never the old one

### Requirement: Writes target the mapping's calendar
Update and delete operations SHALL target the calendar URL recorded on the mapping; they MUST NOT silently re-home a task to the default calendar.

#### Scenario: Update routes to original calendar
- **WHEN** an Obsidian-side change is pushed for a task whose mapping points to calendar B while the current default is calendar A
- **THEN** the update PUT is sent to calendar B's VTODO resource using the stored `caldavHref`

#### Scenario: Delete respects original calendar
- **WHEN** a task is deleted locally
- **THEN** the DELETE is issued against the `calendarUrl` from the mapping, and the mapping is removed only after the server acknowledges the delete (or returns 404)

### Requirement: Explicit move command re-hosts a task
The plugin SHALL expose a "Move task to calendar" action (command palette + right-click on a task line) that migrates an existing VTODO from one calendar to another while preserving the task's UID and Obsidian block ID.

#### Scenario: Move preserves mapping identity
- **WHEN** the user moves a task from calendar A to calendar B
- **THEN** the plugin creates the VTODO on B (reusing the existing `caldavUid`), deletes it from A, and updates the mapping's `calendarUrl` and `caldavHref` atomically — the mapping's `blockId` and `caldavUid` MUST remain unchanged

#### Scenario: Move failure is transactional
- **WHEN** the create-on-B step succeeds but the delete-on-A step fails
- **THEN** the plugin SHALL retain both copies, surface a user-facing warning listing both calendars, and defer mapping update until the user manually resolves the duplicate

#### Scenario: Move is unavailable without discovery
- **WHEN** no discovery has ever succeeded (only a default calendar exists, with no full inventory)
- **THEN** the Move command SHALL be hidden from the palette / return a notice instructing the user to run Discover calendars first
