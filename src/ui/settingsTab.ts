/**
 * Settings tab UI for CalDAV Task Synchronization plugin
 * Implements User Story 4 (Configure CalDAV Connection) and User Story 5 (Configure Auto-Sync)
 */

import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	SecretComponent,
	DropdownComponent,
	ButtonComponent,
} from "obsidian";
import CalDAVTaskSyncPlugin from "../main";
import { CalDAVClient } from "../caldav/client";
import { CalDAVAuthError, CalDAVNetworkError } from "../caldav/errors";
import { setDebugMode } from "../sync/logger";
import { HyperlinkSyncMode, DiscoveredCalendar } from "../types";
import { getAllMappings, removeMapping } from "../sync/mapping";

export class CalDAVSettingsTab extends PluginSettingTab {
	plugin: CalDAVTaskSyncPlugin;
	/** In-memory cache of last discovery result — not persisted to data.json */
	private discoveryCache: DiscoveredCalendar[] = [];
	private isDiscovering = false;

	constructor(app: App, plugin: CalDAVTaskSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Connection Settings Section
		this.addConnectionSection(containerEl);

		// Sync Settings Section
		this.addSyncSection(containerEl);

		// Filter Settings Section
		this.addFilterSection(containerEl);
	}

	/**
	 * Add connection settings section
	 */
	private addConnectionSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Connection").setHeading();

		const infoEl = containerEl.createDiv({ cls: "callout" });
		infoEl.createEl("strong", { text: "Secure storage" });
		infoEl.createEl("p", {
			text: "Your CalDAV password is stored securely in the system keychain using Obsidian's secret storage API for additional security. Consider using app-specific passwords if your CalDAV provider supports them.",
		});

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Caldav Server URL (must start with https://)")
			.addText((text) =>
				text
					.setPlaceholder("https://caldav.example.com")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Username")
			.setDesc("Your CalDAV username")
			.addText((text) =>
				text
					.setPlaceholder("Enter username or email")
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Password")
			.setDesc("Select a password from SecretStorage")
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.settings.password)
					.onChange((value) => {
						this.plugin.settings.password = value;
						void this.plugin.saveSettings();
					}),
			);

		// Default calendar row with dropdown + Discover button (tasks 6.2–6.5)
		this.addDefaultCalendarRow(containerEl);

		// Stale-mappings banner (task 6.7)
		this.addStaleMappingsBanner(containerEl);

		// Test Connection Button (task 6.6)
		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your CalDAV credentials (no calendar required)")
			.addButton((button) =>
				button
					.setButtonText("Test connection")
					.setCta()
					.onClick(async () => {
						await this.testConnection();
					}),
			);
	}

	/**
	 * Render the Default calendar row: dropdown + Discover button (tasks 6.2–6.5)
	 */
	private addDefaultCalendarRow(containerEl: HTMLElement): void {
		let dropdown: DropdownComponent;
		let discoverBtn: ButtonComponent;
		let statusDesc: HTMLElement;

		const setting = new Setting(containerEl)
			.setName("Default calendar")
			.setDesc("The calendar where new tasks will be created")
			.addDropdown((dd) => {
				dropdown = dd;
				this.populateDropdown(dd);
				dd.onChange(async (value) => {
					if (!value) return;
					// Find the calendar in cache to get displayName/ctag
					const cal =
						this.discoveryCache.find((c) => c.url === value) ??
						(this.plugin.settings.defaultCalendar?.url === value
							? this.plugin.settings.defaultCalendar
							: null);
					if (cal) {
						this.plugin.settings.defaultCalendar = {
							url: cal.url,
							displayName:
								"displayName" in cal
									? cal.displayName
									: (this.plugin.settings.defaultCalendar
											?.displayName ?? ""),
							ctag: "ctag" in cal ? cal.ctag : undefined,
						};
						await this.plugin.saveSettings();
						// Re-initialize client with new default
						if (this.plugin.syncEngine) {
							this.plugin.syncEngine.updateFilter();
						}
					}
				});
				return dd;
			})
			.addButton((btn) => {
				discoverBtn = btn;
				btn.setButtonText("Discover calendars").onClick(async () => {
					await this.runDiscovery(dropdown, discoverBtn, statusDesc);
				});
				return btn;
			});

		statusDesc = setting.descEl;
	}

	/**
	 * Populate the dropdown from discovery cache and stored default (task 6.3 state machine)
	 */
	private populateDropdown(dropdown: DropdownComponent): void {
		// Clear existing options
		dropdown.selectEl.empty();

		const storedDefault = this.plugin.settings.defaultCalendar;

		if (this.discoveryCache.length === 0) {
			if (storedDefault) {
				// has-default + no-cache → show stored display name as single option
				dropdown.addOption(
					storedDefault.url,
					storedDefault.displayName,
				);
				dropdown.setValue(storedDefault.url);
				dropdown.setDisabled(false);
			} else {
				// no-default + no-cache → disabled placeholder
				dropdown.addOption("", "Click Discover calendars to load list");
				dropdown.setValue("");
				dropdown.setDisabled(true);
			}
			return;
		}

		// has-cache → show all options
		dropdown.addOption("", "— select a calendar —");
		for (const cal of this.discoveryCache) {
			dropdown.addOption(cal.url, cal.displayName);
		}
		dropdown.setDisabled(false);

		// Pre-select stored default if it's in the list
		if (
			storedDefault &&
			this.discoveryCache.some((c) => c.url === storedDefault.url)
		) {
			dropdown.setValue(storedDefault.url);
		} else {
			dropdown.setValue("");
		}
	}

	/**
	 * Run calendar discovery and update the dropdown (task 6.4)
	 */
	private async runDiscovery(
		dropdown: DropdownComponent,
		discoverBtn: ButtonComponent,
		statusEl: HTMLElement,
	): Promise<void> {
		if (this.isDiscovering) return;
		this.isDiscovering = true;
		discoverBtn.setButtonText("Discovering…").setDisabled(true);
		dropdown.setDisabled(true);

		try {
			const client = new CalDAVClient(this.app, this.plugin.settings);
			this.discoveryCache = await client.discoverCalendars();
			this.populateDropdown(dropdown);
			statusEl.setText(
				`${this.discoveryCache.length} calendar(s) found. Select one as default.`,
			);
		} catch (error) {
			const msg =
				error instanceof CalDAVAuthError
					? "Authentication failed — check your username and password."
					: error instanceof CalDAVNetworkError
						? "Network error — check your server URL and connection."
						: error instanceof Error
							? error.message
							: "Discovery failed.";
			statusEl.setText(`Discovery error: ${msg}`);
		} finally {
			this.isDiscovering = false;
			discoverBtn.setButtonText("Discover calendars").setDisabled(false);
			dropdown.setDisabled(false);
		}
	}

	/**
	 * Show a banner if any mappings reference a calendar not in the discovery cache (task 6.7)
	 */
	private addStaleMappingsBanner(containerEl: HTMLElement): void {
		const discoveredUrls = new Set(this.discoveryCache.map((c) => c.url));
		if (this.discoveryCache.length === 0) return;

		const allMappings = getAllMappings();
		const staleCalendars = new Set<string>();
		for (const mapping of allMappings.values()) {
			if (
				mapping.calendarUrl &&
				!discoveredUrls.has(mapping.calendarUrl)
			) {
				staleCalendars.add(mapping.calendarUrl);
			}
		}

		if (staleCalendars.size === 0) return;

		const bannerEl = containerEl.createDiv({ cls: "callout mod-warning" });
		bannerEl.createEl("strong", {
			text: "⚠️ stale calendar mappings detected",
		});
		bannerEl.createEl("p", {
			text:
				`${staleCalendars.size} calendar(s) referenced by your task mappings are not in the current discovery cache: ` +
				Array.from(staleCalendars).join(", "),
		});

		const clearBtn = bannerEl.createEl("button", {
			text: "Clear stale mappings",
		});
		clearBtn.addEventListener("click", () => {
			const current = getAllMappings();
			for (const [blockId, mapping] of current.entries()) {
				if (
					mapping.calendarUrl &&
					!discoveredUrls.has(mapping.calendarUrl)
				) {
					removeMapping(blockId);
				}
			}
			void this.plugin.saveSettings().then(() => {
				bannerEl.remove();
				new Notice("Stale mappings cleared.");
			});
		});
	}

	/**
	 * Add sync settings section (US5: T024-T032)
	 * Extended for US2: T017-T018 (002-sync-polish)
	 */
	private addSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Sync").setHeading();

		// Enable Auto-Sync Toggle (T026)
		new Setting(containerEl)
			.setName("Enable automatic sync")
			.setDesc("Automatically sync tasks at regular intervals")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableAutoSync)
					.onChange(async (value) => {
						this.plugin.settings.enableAutoSync = value;
						await this.plugin.saveSettings();

						// Restart sync scheduler if needed
						if (this.plugin.syncScheduler) {
							if (value) {
								this.plugin.syncScheduler.start();
							} else {
								this.plugin.syncScheduler.stop();
							}
						}
					}),
			);

		// Sync Interval (T025)
		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("Time between automatic syncs (minimum 10 seconds)")
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.syncInterval))
					.onChange(async (value) => {
						const interval = parseInt(value);
						if (interval >= 10) {
							this.plugin.settings.syncInterval = interval;
							await this.plugin.saveSettings();

							// Restart sync scheduler with new interval
							if (this.plugin.syncScheduler) {
								this.plugin.syncScheduler.stop();
								this.plugin.syncScheduler.start();
							}
						} else {
							new Notice(
								"Sync interval must be at least 10 seconds",
							);
						}
					}),
			);

		// Debug Logging Toggle (T017-T018, 002-sync-polish)
		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc(
				"Write detailed debug log to sync.log file (does not affect Obsidian console)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableDebugLogging = value;
						setDebugMode(value);
						await this.plugin.saveSettings();
					}),
			);

		// Hyperlink Sync Mode (005-hyperlink-sync-config)
		new Setting(containerEl)
			.setName("Hyperlink handling")
			.setDesc(
				"How markdown hyperlinks [text](url) in task descriptions are handled when syncing to CalDAV",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(HyperlinkSyncMode.Keep, "Keep as-is")
					.addOption(HyperlinkSyncMode.Move, "Move to notes")
					.addOption(HyperlinkSyncMode.Strip, "Strip hyperlinks")
					.setValue(this.plugin.settings.hyperlinkSyncMode)
					.onChange(async (value) => {
						this.plugin.settings.hyperlinkSyncMode =
							value as HyperlinkSyncMode;
						await this.plugin.saveSettings();
					}),
			);

		// Description update control (006-desc-update-control)
		new Setting(containerEl)
			.setName("Update task descriptions from calendar")
			.setDesc(
				"When enabled, changes to task titles in your CalDAV app will be applied to Obsidian tasks during sync. " +
					"When disabled (default), task descriptions only flow from Obsidian to CalDAV.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncDescriptionFromCalDAV)
					.onChange(async (value) => {
						this.plugin.settings.syncDescriptionFromCalDAV = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	/**
	 * Add filter settings section (US6: T061-T064, T070)
	 * Extended for 004-sync-due-date-only: T006-T008
	 */
	private addFilterSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Filters").setHeading();

		// Info about filter logic
		const infoEl = containerEl.createDiv({
			cls: "setting-item-description",
		});
		infoEl.createEl("p", {
			text: "Tasks that match any exclusion filter will not be synced to caldav.",
		});

		// Sync Only Tasks with Due Dates (T006-T008, 004-sync-due-date-only)
		new Setting(containerEl)
			.setName("Sync only tasks with due dates")
			.setDesc(
				"When enabled, only tasks with due dates will be synced. Previously synced tasks will continue to sync even if their due date is removed.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnlyTasksWithDueDate)
					.onChange(async (value) => {
						this.plugin.settings.syncOnlyTasksWithDueDate = value;
						await this.plugin.saveSettings();

						// Update filter in sync engine
						this.updateSyncFilter();
					}),
			);

		// Excluded Folders (T062 with validation T070)
		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Comma-separated list of folders to exclude (must end with /), example: archive/, templates/",
			)
			.addText((text) =>
				text
					.setPlaceholder("Archive/, Templates/")
					.setValue(this.plugin.settings.excludedFolders.join(", "))
					.onChange(async (value) => {
						// Parse and validate folder paths (T070)
						const folders = value
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f.length > 0);

						// Validate: all folders must end with '/'
						const invalidFolders = folders.filter(
							(f) => !f.endsWith("/"),
						);
						if (invalidFolders.length > 0) {
							new Notice(
								`Invalid folder paths (must end with /): ${invalidFolders.join(
									", ",
								)}`,
							);
							return;
						}

						this.plugin.settings.excludedFolders = folders;
						await this.plugin.saveSettings();

						// Update filter in sync engine
						this.updateSyncFilter();
					}),
			);

		// Excluded Tags (T063 with validation T070)
		new Setting(containerEl)
			.setName("Excluded tags")
			.setDesc(
				"Comma-separated list of tags to exclude (must start with #). Example: #private, #local-only",
			)
			.addText((text) =>
				text
					.setPlaceholder("#private, #local-only")
					.setValue(this.plugin.settings.excludedTags.join(", "))
					.onChange(async (value) => {
						// Parse and validate tags (T070)
						const tags = value
							.split(",")
							.map((t) => t.trim())
							.filter((t) => t.length > 0);

						// Validate: all tags must start with '#'
						const invalidTags = tags.filter(
							(t) => !t.startsWith("#"),
						);
						if (invalidTags.length > 0) {
							new Notice(
								`Invalid tags (must start with #): ${invalidTags.join(
									", ",
								)}`,
							);
							return;
						}

						this.plugin.settings.excludedTags = tags;
						await this.plugin.saveSettings();

						// Update filter in sync engine
						this.updateSyncFilter();
					}),
			);

		// Completed Task Age Threshold (T064)
		new Setting(containerEl)
			.setName("Completed task age")
			.setDesc(
				"Exclude completed tasks older than this many days (0 = sync all completed tasks)",
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.completedTaskAgeDays))
					.onChange(async (value) => {
						const days = parseInt(value);
						if (isNaN(days) || days < 0) {
							new Notice(
								"Completed task age must be 0 or greater",
							);
							return;
						}

						this.plugin.settings.completedTaskAgeDays = days;
						await this.plugin.saveSettings();

						// Update filter in sync engine
						this.updateSyncFilter();
					}),
			);
	}

	/**
	 * Update sync filter when settings change
	 */
	private updateSyncFilter(): void {
		// Reinitialize sync engine's filter if engine exists
		if (this.plugin.syncEngine) {
			this.plugin.syncEngine.updateFilter();
		}
	}

	/**
	 * Test connection to CalDAV server.
	 * Login-only — works even when no default calendar is configured (task 6.6).
	 */
	private async testConnection(): Promise<void> {
		if (!this.plugin.settings.serverUrl) {
			new Notice("Please enter a server URL");
			return;
		}

		if (!this.plugin.settings.serverUrl.startsWith("https://")) {
			new Notice("Server URL must start with https://");
			return;
		}

		const password = this.app.secretStorage.getSecret(
			this.plugin.settings.password,
		);
		if (!this.plugin.settings.username || !password) {
			new Notice("Please enter username and password");
			return;
		}

		const notice = new Notice("Testing connection…", 0);

		try {
			const client = new CalDAVClient(this.app, this.plugin.settings);
			const success = await client.testConnection();

			notice.hide();

			if (success) {
				let msg = "✓ Connection successful!";
				if (!this.plugin.settings.defaultCalendar) {
					msg +=
						" Remember to click Discover calendars and select a default calendar before syncing.";
				}
				new Notice(msg, 6000);
			} else {
				new Notice("✗ connection failed. Please check your settings.");
			}
		} catch (error) {
			notice.hide();

			if (error instanceof CalDAVAuthError) {
				new Notice(
					"✗ authentication failed. Please check your username and password.",
				);
			} else if (error instanceof CalDAVNetworkError) {
				new Notice(
					"✗ network error. Please check your server URL and internet connection.",
				);
			} else if (error instanceof Error) {
				new Notice(`✗ connection failed: ${error.message}`);
			} else {
				new Notice("✗ connection failed. Please check your settings.");
			}
		}
	}
}
