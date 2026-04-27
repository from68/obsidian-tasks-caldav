## ADDED Requirements

### Requirement: Missing-UID Notice is rate-limited during auto-sync
When one or more mapped CalDAV UIDs cannot be found in any discovered calendar, the plugin SHALL show the user a Notice at most once per cooldown window (1 hour) rather than on every auto-sync cycle. The in-log WARN entries SHALL continue to appear on every cycle regardless.

#### Scenario: First occurrence shows Notice
- **WHEN** a sync cycle detects at least one mapped UID absent from all calendars
- **AND** no Notice has been shown in the current session or the cooldown has expired
- **THEN** a Notice is displayed informing the user that some tasks were not found and suggesting "Discover calendars"

#### Scenario: Subsequent occurrences within cooldown suppress Notice
- **WHEN** a sync cycle detects at least one mapped UID absent from all calendars
- **AND** a Notice was already shown within the last 1 hour
- **THEN** no Notice is displayed
- **AND** WARN log entries are still written for the missing UIDs

#### Scenario: Cooldown resets on plugin reload
- **WHEN** Obsidian is restarted or the plugin is reloaded
- **THEN** the cooldown timer resets
- **AND** the next sync cycle with missing UIDs SHALL show the Notice again
