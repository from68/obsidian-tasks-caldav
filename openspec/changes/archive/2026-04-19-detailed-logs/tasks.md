## 1. Rewrite Logger Core

- [x] 1.1 Add `FileLogger` class to `src/sync/logger.ts` with in-memory buffer, periodic flush (5s debounce), and `vault.adapter` write
- [x] 1.2 Add `initLogger(app: App): void` export that wires up `FileLogger` with the Obsidian `App` reference
- [x] 1.3 Add `shutdownLogger(): Promise<void>` export that flushes the buffer synchronously on unload
- [x] 1.4 Update `Logger.warn()` to route to file-only (remove unconditional `console.warn`)
- [x] 1.5 Update `Logger.info()` to route to file-only (remove `console.debug`)
- [x] 1.6 Update `Logger.debug()` to route to file-only (remove `console.debug`)
- [x] 1.7 Keep `Logger.error()` writing to both `console.error` and file (when enabled)
- [x] 1.8 Implement log entry format: `[ISO8601] [LEVEL] message` with optional error serialisation

## 2. Log Rotation

- [x] 2.1 On each flush cycle, read the existing `sync.log` file (if it exists) and count lines
- [x] 2.2 If total lines exceed 10 000, trim to the last 10 000 before writing back

## 3. Plugin Integration

- [x] 3.1 Call `initLogger(this.app)` in `main.ts` `onload` after settings are loaded
- [x] 3.2 Call `shutdownLogger()` in `main.ts` `onunload` and await it
- [x] 3.3 Pass `enableDebugLogging` state to `FileLogger` (already via `setDebugMode`)

## 4. Replace Stray Console Calls

- [x] 4.1 `src/vault/taskWriter.ts`: replace `console.warn` / `console.debug` / `console.error` with `Logger.*`
- [x] 4.2 `src/caldav/vtodo.ts`: replace `console.warn` with `Logger.warn`
- [x] 4.3 `src/sync/engine.ts`: replace `console.warn` with `Logger.warn`
- [x] 4.4 Verify no remaining raw `console.log/warn/debug` outside `logger.ts` (grep check)

## 5. Settings UI Update

- [x] 5.1 Update the `enableDebugLogging` description in `src/ui/settingsTab.ts` to say "Write detailed debug log to sync.log file (does not affect Obsidian console)"

## 6. Verification

- [x] 6.1 Build the plugin and confirm TypeScript compiles without errors
- [x] 6.2 Run `npm test && npm run lint` and fix any failures
- [x] 6.3 Manual smoke test: disable debug → trigger sync → confirm no console output except errors
- [x] 6.4 Manual smoke test: enable debug → trigger sync → confirm `sync.log` created with timestamped entries
