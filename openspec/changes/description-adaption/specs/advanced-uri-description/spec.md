## ADDED Requirements

### Requirement: Advanced URI block-only navigation
The plugin SHALL generate Obsidian deep links using the Advanced URI scheme (`obsidian://advanced-uri`) with only the vault name and block ID — the file path SHALL NOT be included in the URI.

#### Scenario: URI contains vault and block, no file path
- **WHEN** `buildAdvancedURI("My Vault", "task-a1b2c3d4-e5f6-7890-abcd-ef1234567890")` is called
- **THEN** the returned string is `obsidian://advanced-uri?vault=My%20Vault&block=task-a1b2c3d4-e5f6-7890-abcd-ef1234567890`

#### Scenario: Vault name is URL-encoded
- **WHEN** `buildAdvancedURI("My Vault", "task-a1b2c3d4-e5f6-7890-abcd-ef1234567890")` is called
- **THEN** spaces and special characters in the vault name are percent-encoded

#### Scenario: Block ID is not URL-encoded
- **WHEN** a valid block ID of the form `task-{uuid}` is provided
- **THEN** the block ID appears verbatim in the URI without percent-encoding (UUID characters are URL-safe)

#### Scenario: Empty vault name throws
- **WHEN** `buildAdvancedURI("", "task-a1b2c3d4-e5f6-7890-abcd-ef1234567890")` is called
- **THEN** an `Error` is thrown with a message indicating vault name is required

#### Scenario: Invalid block ID throws
- **WHEN** `buildAdvancedURI("My Vault", "not-a-valid-block-id")` is called
- **THEN** an `Error` is thrown with a message indicating the block ID format is invalid

### Requirement: DESCRIPTION field uses markdown hyperlink
The CalDAV DESCRIPTION field for an Obsidian back-link SHALL be formatted as a markdown hyperlink `[Open in Obsidian](<uri>)` rather than a plain-text URL.

#### Scenario: No existing content produces markdown link only
- **WHEN** `buildDescriptionWithURI("obsidian://advanced-uri?vault=V&block=B")` is called with no existing content
- **THEN** the returned string is `[Open in Obsidian](obsidian://advanced-uri?vault=V&block=B)`

#### Scenario: Existing content is prepended before the markdown link
- **WHEN** `buildDescriptionWithURI("obsidian://advanced-uri?vault=V&block=B", "Links:\n- foo: https://example.com")` is called
- **THEN** the returned string starts with the existing content, followed by two newlines, followed by `[Open in Obsidian](obsidian://advanced-uri?vault=V&block=B)`

### Requirement: Engine uses Advanced URI for task creation
When creating a new CalDAV task that has a valid block ID, the sync engine SHALL call `buildAdvancedURI` (not the old `buildObsidianURI`) and embed the result as a markdown link in the DESCRIPTION field.

#### Scenario: New task with block ID gets Advanced URI description
- **WHEN** a new Obsidian task with a valid block ID is synced to CalDAV for the first time
- **THEN** the CalDAV DESCRIPTION field contains `[Open in Obsidian](obsidian://advanced-uri?vault=<vault>&block=<blockId>)`
- **AND** no file path appears in the DESCRIPTION field
