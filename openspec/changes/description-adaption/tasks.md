## 1. URI Builder — switch to Advanced URI scheme

- [x] 1.1 Rename `buildObsidianURI` to `buildAdvancedURI` and remove the `filePath` parameter; update the URI template to `obsidian://advanced-uri?vault=<encodedVault>&block=<blockId>`
- [x] 1.2 Update `buildDescriptionWithURI` to emit a markdown hyperlink: `[Open in Obsidian](<uri>)` instead of `Obsidian Link: <uri>`
- [x] 1.3 Export `buildAdvancedURI` and keep `buildDescriptionWithURI` exported; remove `buildObsidianURI` export

## 2. Engine call site update

- [x] 2.1 In `src/sync/engine.ts`, update the import from `uriBuilder` to use `buildAdvancedURI`
- [x] 2.2 Replace the `buildObsidianURI(vaultName, task.filePath, task.blockId)` call with `buildAdvancedURI(vaultName, task.blockId)`
