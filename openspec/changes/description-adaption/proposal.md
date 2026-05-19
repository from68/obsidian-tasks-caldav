## Why

The CalDAV DESCRIPTION field currently embeds Obsidian deep links as raw plain-text URLs tied to the file path (`obsidian://open?vault=X&file=Y&block=Z`). This causes two problems: (1) CalDAV clients that render markdown show the full raw URL instead of a readable label, and (2) if a note is moved or renamed, the `file=` component breaks the link entirely.

## What Changes

- **Replace `obsidian://open` URI scheme** with the Advanced URI plugin scheme (`obsidian://advanced-uri?vault=X&block=Z`) — the file path is dropped, so links survive note moves and renames.
- **Wrap the URI in a markdown hyperlink** in the DESCRIPTION field: `[Open in Obsidian](obsidian://advanced-uri?...)` instead of `Obsidian Link: obsidian://advanced-uri?...` — clients that render markdown show the label text; those that don't still show a usable URL.
- The `buildObsidianURI` function is replaced by a new `buildAdvancedURI` function that omits the file-path parameter.
- The `buildDescriptionWithURI` function is updated to emit a markdown link instead of plain text.

## Capabilities

### New Capabilities

- `advanced-uri-description`: Build the CalDAV DESCRIPTION Obsidian back-link using the Advanced URI plugin scheme (block-only navigation, markdown-formatted link label).

### Modified Capabilities

<!-- No existing spec-level requirements are changing — the URI format and description formatting are implementation details not yet captured in a spec. -->

## Impact

- `src/obsidian/uriBuilder.ts` — `buildObsidianURI` replaced by `buildAdvancedURI`; `buildDescriptionWithURI` updated to markdown format.
- `src/sync/engine.ts` — call site updated to use `buildAdvancedURI`.
- `tests/` — unit tests for `uriBuilder.ts` updated to cover new URI scheme and markdown output.
- **Runtime dependency**: requires the [Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) community plugin to be installed in the user's vault for links to resolve.
