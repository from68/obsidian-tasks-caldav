### Requirement: Console output restricted to errors
The plugin SHALL write to the Obsidian developer console (`console.error`) only for `Logger.error()` calls. All other log levels (warn, info, debug) SHALL NOT produce any console output regardless of plugin settings.

#### Scenario: Info message does not appear in console
- **WHEN** `Logger.info("Sync started")` is called with `enableDebugLogging=false`
- **THEN** nothing is written to the browser/Obsidian developer console

#### Scenario: Info message does not appear in console even when debug enabled
- **WHEN** `Logger.info("Sync started")` is called with `enableDebugLogging=true`
- **THEN** nothing is written to the browser/Obsidian developer console

#### Scenario: Warning does not appear in console
- **WHEN** `Logger.warn("mapping not found")` is called
- **THEN** nothing is written to `console.warn`

#### Scenario: Error always appears in console
- **WHEN** `Logger.error("Sync failed", err)` is called
- **THEN** `console.error("[CalDAV Sync] Sync failed", err)` is written to the Obsidian console

### Requirement: File-based debug logging
When `enableDebugLogging` is `true`, the plugin SHALL write all log entries (error, warn, info, debug) to a persistent log file at `<vault>/.obsidian/plugins/obsidian-tasks-caldev/sync.log`.

#### Scenario: Debug log entry written to file
- **WHEN** `enableDebugLogging=true` and `Logger.debug("task parsed", ...)` is called
- **THEN** a timestamped line is appended to `sync.log` within 5 seconds

#### Scenario: No file written when debug disabled
- **WHEN** `enableDebugLogging=false` and any Logger method is called
- **THEN** `sync.log` is not created or modified

#### Scenario: Error also written to file when debug enabled
- **WHEN** `enableDebugLogging=true` and `Logger.error("Sync failed", err)` is called
- **THEN** the error is written both to `console.error` AND to `sync.log`

### Requirement: Log entry format
Each log entry written to the file SHALL follow the format: `[ISO8601 timestamp] [LEVEL] message` optionally followed by a serialized error or extra args on the same or next line.

#### Scenario: Timestamped entry
- **WHEN** a log entry is written to `sync.log`
- **THEN** each line begins with `[2026-04-19T10:23:01.123Z]` (ISO 8601 UTC)

#### Scenario: Level tag included
- **WHEN** `Logger.warn("retry attempt 2")` is written to the file
- **THEN** the line contains `[WARN]` between the timestamp and the message

### Requirement: Log file rotation by line count
The log file SHALL be trimmed to the most recent 10 000 lines when the file exceeds that threshold during a flush cycle.

#### Scenario: File trimmed when over limit
- **WHEN** `sync.log` contains 12 000 lines and a flush occurs
- **THEN** `sync.log` is rewritten to contain the last 10 000 lines

#### Scenario: File not trimmed under limit
- **WHEN** `sync.log` contains fewer than 10 000 lines and a flush occurs
- **THEN** no lines are removed from the file

### Requirement: Logger initialisation
The plugin SHALL call `initLogger(app)` during `onload` to provide the `App` reference needed for file I/O, and `shutdownLogger()` during `onunload` to flush any buffered entries before the plugin is unloaded.

#### Scenario: Buffer flushed on unload
- **WHEN** the plugin is unloaded with 50 buffered log entries not yet written to disk
- **THEN** all 50 entries are written to `sync.log` before the plugin finishes unloading

#### Scenario: Flush triggered periodically
- **WHEN** `enableDebugLogging=true` and log entries have accumulated for 5 seconds
- **THEN** entries are written to `sync.log` without requiring a plugin restart

### Requirement: Stray console calls replaced
All direct `console.warn`, `console.debug`, and `console.log` calls in plugin source files outside of `logger.ts` SHALL be replaced with the appropriate `Logger.*` method.

#### Scenario: No stray console calls at runtime
- **WHEN** the plugin runs a full sync cycle with `enableDebugLogging=false`
- **THEN** no messages appear in the Obsidian console except from `Logger.error()`
