## Context

The plugin embeds an Obsidian deep link in the CalDAV DESCRIPTION field so users can jump from their CalDAV client directly to the source task. The current implementation uses the built-in `obsidian://open` scheme with a `file=` parameter:

```
obsidian://open?vault=MyVault&file=Projects%2Ftasks.md&block=task-abc123
```

This is produced by `buildObsidianURI` in `src/obsidian/uriBuilder.ts` and embedded as plain text by `buildDescriptionWithURI`:

```
Obsidian Link: obsidian://open?vault=...
```

Two problems: the `file=` path breaks when notes are moved/renamed; the raw URL is verbose in CalDAV clients that render markdown.

## Goals / Non-Goals

**Goals:**
- Switch URI scheme to Advanced URI (`obsidian://advanced-uri`) with `block=` only — no file path.
- Embed the link as a markdown hyperlink `[Open in Obsidian](uri)` so label-rendering clients show clean text.
- Keep the change self-contained to `uriBuilder.ts` and the `engine.ts` call site.

**Non-Goals:**
- Detecting whether the Advanced URI plugin is installed (a prerequisite documented in README, not enforced at runtime).
- Changing how extracted hyperlinks from the task body are formatted (that is `hyperlinkProcessor.ts` territory).
- Bidirectional parsing of the Advanced URI format on the read path.

## Decisions

### D1 — Advanced URI scheme (`obsidian://advanced-uri?vault=X&block=Z`)

The [Advanced URI plugin](https://publish.obsidian.md/advanced-uri-doc/Actions/Navigation) supports block-only navigation: `obsidian://advanced-uri?vault=<vault>&block=<blockId>`. Obsidian resolves the block across all files in the vault, so a note rename does not break the link.

**Alternatives considered:**
- Keep `obsidian://open` — rejected because it requires `file=`, which breaks on moves.
- Use `obsidian://advanced-uri?uid=<uid>` — not suitable; UIDs are per-note, not per-block.

### D2 — Markdown link format in DESCRIPTION

The DESCRIPTION value stored on CalDAV will be:

```
[Open in Obsidian](obsidian://advanced-uri?vault=MyVault&block=task-abc123)
```

Many CalDAV clients (Thunderbird, Evolution, DAVx⁵ companion apps) render DESCRIPTION as markdown or at least make URLs clickable. In plain-text clients the label text `Open in Obsidian` appears before the parenthesised URL, which is still human-readable.

**Alternatives considered:**
- `Open in Obsidian: <uri>` (plain text with label) — readable but verbose.
- Raw URI only — no human-readable label; worse for plain-text clients.

### D3 — Rename `buildObsidianURI` → `buildAdvancedURI`, drop `filePath` parameter

The file path is no longer needed. Renaming makes the function's contract obvious and prevents callers from accidentally passing a stale path.

`buildDescriptionWithURI` retains its name (its role — composing a DESCRIPTION string from a URI — is unchanged) but now emits a markdown link.

## Risks / Trade-offs

- **Advanced URI plugin dependency**: Links will not work unless the user has the Advanced URI community plugin installed. Mitigation: document in README and settings tooltip; this is a soft dependency (graceful fallback: link simply does nothing if plugin absent).
- **Existing CalDAV DESCRIPTION values not migrated**: Tasks synced before this change retain the old `obsidian://open` URI format. Mitigation: old URIs still work as long as the file hasn't moved; no active migration needed.
- **Markdown in DESCRIPTION is non-standard (RFC 5545)**: RFC 5545 DESCRIPTION is plain text. Storing a markdown link is a de-facto convention, not a standard. Clients that do not render markdown will display the raw `[text](url)` string — still human-readable and functional. No mitigation needed.
