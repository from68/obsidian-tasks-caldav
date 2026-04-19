## Context

The plugin uses a central `Logger` class (`src/sync/logger.ts`) with four levels: `error`, `warn`, `info`, `debug`. Currently:

- `warn` always writes to `console.warn` regardless of the `DEBUG` flag — this is the primary source of console noise
- `info` and `debug` write to `console.debug` only when `DEBUG=true` — still pollutes the Obsidian developer console
- Several files bypass `Logger` entirely with raw `console.warn/debug` calls
- There is no file-based sink; enabling debug logs floods the live console

The user wants to run debug logging for days at a time, which makes a file sink essential and console output for non-errors unacceptable.

## Goals / Non-Goals

**Goals:**
- Only `Logger.error()` writes to the Obsidian console — nothing else, ever
- When `enableDebugLogging=true`, all levels (error, warn, info, debug) are written to a persistent log file
- Log file is human-readable, timestamped, and bounded in size (rotation)
- All stray `console.*` calls in non-logger files are replaced with `Logger.*` calls
- No new npm dependencies

**Non-Goals:**
- Structured JSON logging / log ingestion pipelines
- Remote log shipping
- Per-module log-level filtering (single global level toggle is sufficient)
- UI for viewing the log file inside Obsidian

## Decisions

### Decision 1: File sink via Obsidian's `vault.adapter`

**Choice:** Use `app.vault.adapter.write` / `app.vault.adapter.read` to append to a log file at `.obsidian/plugins/obsidian-tasks-caldev/sync.log`.

**Rationale:** No Node.js `fs` import needed (Obsidian sandboxes it on mobile); `DataAdapter` is the officially supported abstraction. Batch-append writes to avoid one I/O call per log line.

**Alternative considered:** `require('fs')` — works on desktop but breaks on mobile and is not forward-compatible with Obsidian's web renderer direction.

### Decision 2: In-memory buffer with periodic flush

**Choice:** Accumulate log entries in a `string[]` buffer. Flush to disk every 5 seconds (debounced) and on plugin unload.

**Rationale:** Obsidian's `vault.adapter.write` replaces the whole file; append requires read-modify-write. Batching keeps I/O low. 5-second window is imperceptible for offline analysis but avoids write-per-line overhead.

**Alternative considered:** `append` via `fs.appendFileSync` — not available cross-platform inside Obsidian.

### Decision 3: Log rotation by line count

**Choice:** Keep the last 10 000 lines. On flush, if the accumulated file exceeds 10 000 lines, trim from the top.

**Rationale:** Simple, predictable size bound. At ~100 bytes/line this is ~1 MB maximum. Line-count rotation avoids needing to stat the file size on every flush.

**Alternative considered:** Size-based rotation with a `.log.1` backup file — more complex, not worth it for a debugging aid.

### Decision 4: Logger initialisation via `initLogger(app)`

**Choice:** Export a new `initLogger(app: App): void` function called from `main.ts` `onload`. The `FileLogger` captures the `app` reference and uses it for all I/O.

**Rationale:** `Logger` is currently a static class. Adding a one-time init function preserves the static call API everywhere else (no refactor of call sites needed). 

### Decision 5: Console output rule — errors only

**Choice:** `console.error` is called only from `Logger.error()`. All other levels (`warn`, `info`, `debug`) write exclusively to the file sink when enabled, and are completely silent otherwise.

**Rationale:** Matches the user's explicit requirement: "I only want error messages to appear in Obsidian log."

## Risks / Trade-offs

- **Log loss on crash**: The in-memory buffer may not flush if Obsidian hard-crashes. → Mitigation: reduce flush interval to 5s; acceptable trade-off for performance.
- **File growth between flushes**: If a bug causes thousands of log entries per second the buffer could be large. → Mitigation: cap buffer at 2 000 entries before forcing a flush.
- **`vault.adapter` read-modify-write race**: Concurrent flushes could corrupt the file. → Mitigation: serialize flushes with a boolean `flushing` guard; skip if already flushing.
- **Mobile compatibility**: `vault.adapter` is available on mobile, but the plugin is desktop-focused; low risk.

## Migration Plan

1. Rewrite `src/sync/logger.ts` — new `FileLogger` class, updated routing in `Logger.*` statics, export `initLogger`
2. Update `src/main.ts` — call `initLogger(this.app)` in `onload`, call `shutdownLogger()` in `onunload`
3. Replace stray `console.*` calls across the codebase with `Logger.*` equivalents
4. Update settings UI description for the debug toggle
5. Test: enable debug → confirm file created; disable debug → confirm console is quiet; trigger error → confirm `console.error` fires

No data migration needed — the log file is ephemeral tooling, not persisted plugin state.

## Open Questions

- Should the log file path be configurable in settings, or is `.obsidian/plugins/obsidian-tasks-caldev/sync.log` sufficient? (Assumption: hardcoded path is fine for now)
- Maximum retention: 10 000 lines — acceptable? (Can be adjusted in follow-up)
