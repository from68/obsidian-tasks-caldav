## ADDED Requirements

### Requirement: Discover calendars from server URL
The plugin SHALL provide a user-triggered discovery action that queries the configured CalDAV server using the entered base URL and credentials, and returns every writable calendar on the authenticated principal that advertises VTODO support.

#### Scenario: Successful discovery populates dropdown
- **WHEN** the user clicks "Discover calendars" with a valid `serverUrl`, `username`, and stored password
- **THEN** the plugin performs a CalDAV principal/home-set lookup, filters to calendars whose supported component set includes VTODO, and populates the "Default calendar" dropdown with each calendar's display name, falling back to the URL when display name is absent

#### Scenario: Non-VTODO calendars are excluded
- **WHEN** the server returns calendars supporting only VEVENT (pure event calendars)
- **THEN** those calendars MUST NOT appear in the dropdown, so users cannot accidentally select a calendar the plugin cannot write tasks to

#### Scenario: Authentication failure surfaces inline
- **WHEN** discovery fails with HTTP 401/403
- **THEN** the settings UI SHALL display an inline authentication error next to the Discover button and SHALL NOT clear any previously selected default calendar

#### Scenario: Network failure preserves prior selection
- **WHEN** discovery fails due to network error or timeout
- **THEN** the plugin SHALL show the network error inline, keep the existing selected default calendar intact, and allow retry without re-entering credentials

### Requirement: Persist default calendar as structured record
The plugin SHALL persist the selected default calendar as a structured record containing URL, display name, and (when available) ctag — not as a free-text substring path — so that selection is unambiguous across servers that host multiple calendars at overlapping URL prefixes.

#### Scenario: Selection is written to settings
- **WHEN** the user picks a calendar from the dropdown
- **THEN** `settings.defaultCalendar` is set to `{ url, displayName, ctag? }` and `saveSettings()` is awaited before the UI reflects the change

#### Scenario: URL match uses exact equality
- **WHEN** the sync engine resolves the default calendar against the discovery list
- **THEN** it MUST compare `calendar.url` by exact string equality (after tsdav's canonicalization), NOT by `String.includes()` as in the current implementation

### Requirement: Migrate legacy calendarPath setting
On first load after upgrading to this feature, the plugin SHALL migrate any existing `calendarPath` value by performing a discovery call and matching the legacy path against discovered calendars.

#### Scenario: Exact substring match migrates silently
- **WHEN** exactly one discovered calendar's URL contains the legacy `calendarPath`
- **THEN** that calendar is stored as `defaultCalendar`, `calendarPath` is removed from settings, and no user intervention is required

#### Scenario: Ambiguous or missing match prompts the user
- **WHEN** zero calendars match, or multiple calendars match the legacy path
- **THEN** the plugin SHALL leave `defaultCalendar` unset, show a non-blocking notice directing the user to settings, and disable auto-sync until a default calendar is selected

#### Scenario: Offline upgrade defers migration
- **WHEN** the server is unreachable at upgrade time
- **THEN** the plugin SHALL retain `calendarPath` in settings (treated as a fallback), retry migration on the next successful discovery, and log a debug message

### Requirement: Settings UI reflects discovery state
The settings tab SHALL replace the existing Calendar Path text field with a dropdown control plus a Discover button, with clear affordances for each discovery state.

#### Scenario: Empty state before discovery
- **WHEN** no discovery has been performed and no default calendar is stored
- **THEN** the dropdown is disabled with placeholder text "Click Discover calendars to load list" and the Test Connection button remains usable with just serverUrl/credentials

#### Scenario: Discovery in progress
- **WHEN** a discovery call is in-flight
- **THEN** the Discover button is disabled with a spinner/label indicating progress, and the dropdown is not editable until discovery resolves

#### Scenario: Stored selection survives reload
- **WHEN** the user closes and reopens the settings tab after selecting a calendar
- **THEN** the dropdown SHALL show the stored `defaultCalendar.displayName` as the selected option even before re-running discovery
