## Why

The current logging implementation emits `warn`-level messages unconditionally to the Obsidian developer console regardless of debug settings, causing excessive noise. There is no file-based logging, so enabling debug mode pollutes the live console rather than writing to a persistent log that can be analyzed after days of operation.

## What Changes

- `Logger.warn()` no longer routes to `console.warn` unconditionally — warnings are suppressed from the Obsidian console unless they are also errors
- `Logger.error()` remains the only category that always writes to the Obsidian console (`console.error`)
- All `info`, `warn`, and `debug` calls are silenced from the console when debug mode is off
- A new `FileLogger` writes timestamped, structured log entries to a rotating log file inside the plugin's data directory when `enableDebugLogging` is true
- Raw `console.log/warn/debug` calls scattered across the codebase are replaced by Logger calls
- The settings UI clarifies that "debug logging" writes to a file, not to the console
- Log file rotation keeps the file from growing unbounded (configurable max size / line count)

## Capabilities

### New Capabilities
- `file-logger`: Persistent file-based debug logger that appends structured entries to a log file in the plugin data directory, with rotation support

### Modified Capabilities
- None — the `Logger` API surface stays the same; only routing and sink behavior change

## Impact

- `src/sync/logger.ts`: Core rewrite — add `FileLogger`, change routing logic
- `src/main.ts`: Pass Obsidian `app` to logger init so FileLogger can write to the vault adapter
- `src/settings.ts`: No schema change; description text update for `enableDebugLogging`
- `src/ui/settingsTab.ts`: Update description shown for the debug logging toggle
- All files with stray `console.warn/debug/log` calls: replace with `Logger.*` calls
- No new npm dependencies — uses Obsidian's `app.vault.adapter` for file I/O
