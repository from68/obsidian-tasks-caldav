import { Plugin, Notice, Editor, MarkdownView, MarkdownFileInfo, Menu } from "obsidian";
import { CalDAVConfiguration, PluginData } from "./types";
import { DEFAULT_SETTINGS } from "./settings";
import { CalDAVSettingsTab } from "./ui/settingsTab";
import { SyncScheduler } from "./sync/scheduler";
import { SyncEngine } from "./sync/engine";
import { loadMappings, saveMappings, backfillCalendarUrlForLegacyMappings, getMappingByBlockId } from "./sync/mapping";
import { setDebugMode, Logger } from "./sync/logger";
import { CalDAVClient } from "./caldav/client";
import { CalendarPickerModal } from "./ui/calendarPickerModal";
import type { DiscoveredCalendar } from "./types";

/**
 * Main plugin class for CalDAV Task Synchronization
 */
export default class CalDAVTaskSyncPlugin extends Plugin {
	settings!: CalDAVConfiguration;
	syncScheduler: SyncScheduler | null = null;
	syncEngine: SyncEngine | null = null;
	private syncIntervalId: number | null = null;
	/** In-memory discovery cache shared between settings tab and move command */
	lastDiscoveredCalendars: DiscoveredCalendar[] = [];

	/**
	 * Plugin initialization - called when plugin is loaded
	 */
	async onload() {
		Logger.info("Loading CalDAV Task Sync plugin");

		// Load saved settings
		await this.loadSettings();

		// Initialize debug logging mode based on settings
		setDebugMode(this.settings.enableDebugLogging);

		// Run migration before starting sync (task 5.3)
		await this.maybeRunMigration();

		// Initialize sync engine (Phase 5 - US1: T041)
		this.syncEngine = new SyncEngine(
			this.app,
			this.app.vault,
			this.settings,
			async () => await this.savePluginData(),
		);

		// Add settings tab (Phase 3 - US4: T023)
		this.addSettingTab(new CalDAVSettingsTab(this.app, this));

		// Initialize sync scheduler (Phase 4 - US5: T027-T028)
		// T015: Pass isAutoSync parameter to performSync
		this.syncScheduler = new SyncScheduler(
			this.app,
			this.settings,
			async (isAutoSync: boolean) => await this.performSync(isAutoSync),
		);

		// Start automatic sync if enabled (migration may have disabled it)
		if (this.settings.enableAutoSync) {
			this.syncScheduler.start();
		}

		// Register manual sync command (Phase 4 - US5: T029)
		this.addCommand({
			id: "manual-sync",
			name: "Sync tasks now",
			callback: async () => {
				if (this.syncScheduler) {
					await this.syncScheduler.manualSync();
				}
			},
		});

		// Move task to calendar command (task 7.1, 7.5)
		this.addCommand({
			id: "move-task-to-calendar",
			name: "Move task to calendar…",
			editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				const view = ctx instanceof MarkdownView ? ctx : null;
				if (!view) return false;
				// Only show if discovery has succeeded (task 7.5)
				const discoveryCache = this.syncEngine?.getDiscoveryCache();
				if (!discoveryCache || discoveryCache.size === 0) return false;

				// Only show if cursor line has a known mapping
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const blockIdMatch = line.match(/\^(task-[a-z0-9]+)/);
				if (!blockIdMatch) return false;
				const mapping = getMappingByBlockId(blockIdMatch[1]!);
				if (!mapping) return false;

				if (!checking) {
					const calendars = Array.from(discoveryCache.values()).map((cal) => ({
						url: cal.url,
						displayName: typeof cal.displayName === "string" ? cal.displayName : cal.url,
						supportsVTODO: true,
					}));
					new CalendarPickerModal(this.app, calendars, (destUrl) => {
						if (!this.syncEngine) return;
						void this.syncEngine.moveTask(mapping.blockId, destUrl).then(() => {
							new Notice(`Task moved to ${calendars.find(c => c.url === destUrl)?.displayName ?? destUrl}`);
						}).catch((error: unknown) => {
							new Notice(`Move failed: ${error instanceof Error ? error.message : String(error)}`);
						});
					}).open();
				}
				return true;
			},
		});

		// Context menu entry for move command (task 7.2)
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				const discoveryCache = this.syncEngine?.getDiscoveryCache();
				if (!discoveryCache || discoveryCache.size === 0) return;

				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const blockIdMatch = line.match(/\^(task-[a-z0-9]+)/);
				if (!blockIdMatch) return;
				const mapping = getMappingByBlockId(blockIdMatch[1]!);
				if (!mapping) return;

				menu.addItem((item) =>
					item
						.setTitle("Move task to calendar…")
						.setIcon("arrow-right-circle")
						.onClick(() => {
							const calendars = Array.from(discoveryCache.values()).map((cal) => ({
								url: cal.url,
								displayName: typeof cal.displayName === "string" ? cal.displayName : cal.url,
								supportsVTODO: true,
							}));
							new CalendarPickerModal(this.app, calendars, (destUrl) => {
								if (!this.syncEngine) return;
								void this.syncEngine.moveTask(mapping.blockId, destUrl).then(() => {
									new Notice(`Task moved to ${calendars.find(c => c.url === destUrl)?.displayName ?? destUrl}`);
								}).catch((error: unknown) => {
									new Notice(`Move failed: ${error instanceof Error ? error.message : String(error)}`);
								});
							}).open();
						}),
				);
			}),
		);
	}

	/**
	 * Plugin cleanup - called when plugin is unloaded
	 */
	onunload() {
		Logger.info("Unloading CalDAV Task Sync plugin");

		// Stop sync scheduler
		if (this.syncScheduler) {
			this.syncScheduler.stop();
		}

		// Clean up sync interval (legacy)
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	/**
	 * Perform sync operation (Phase 5 - US1: T041)
	 * @param isAutoSync Whether this is an automatic sync (T015, 002-sync-polish)
	 * @returns Number of tasks synced
	 */
	private async performSync(isAutoSync: boolean = false): Promise<number> {
		if (!this.syncEngine) {
			Logger.error("Sync engine not initialized");
			return 0;
		}

		try {
			// Perform sync from Obsidian to CalDAV (T015: Pass isAutoSync)
			await this.syncEngine.syncObsidianToCalDAV(isAutoSync);
			return 0; // TODO: Return actual count in future
		} catch (error) {
			Logger.error("Sync failed", error);
			throw error;
		}
	}

	/**
	 * Detect old-version data and migrate if needed (task 5.1).
	 * Conditions: version < 2 OR (defaultCalendar == null && calendarPath != "")
	 */
	private async maybeRunMigration(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const legacyPath = this.settings.calendarPath;
		const needsMigration =
			(data && data.version < 2) ||
			(!this.settings.defaultCalendar && !!legacyPath);

		if (!needsMigration) return;

		Logger.info("Detected legacy calendarPath setting — attempting migration");
		await this.migrateCalendarPath();
	}

	/**
	 * Migrate legacy calendarPath to defaultCalendar via discovery (task 5.2).
	 * (a) Exactly one match → adopt, backfill mappings, save.
	 * (b) Zero or multi-match → show persistent notice, disable auto-sync.
	 * (c) Network failure → defer (retry hook registered on next successful discovery).
	 */
	async migrateCalendarPath(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const legacyPath = this.settings.calendarPath;
		if (!legacyPath) return;

		const client = new CalDAVClient(this.app, this.settings);
		let discovered;

		try {
			discovered = await client.discoverCalendars();
		} catch (error) {
			// (c) Discovery failed — defer migration
			Logger.warn(`Migration deferred: discovery failed — ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const matches = discovered.filter((cal) => cal.url.includes(legacyPath));

		if (matches.length === 1) {
			// (a) Exactly one match — silent migration
			const adopted = matches[0]!;
			this.settings.defaultCalendar = {
				url: adopted.url,
				displayName: adopted.displayName,
				ctag: adopted.ctag,
			};
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this.settings.calendarPath = "";
			backfillCalendarUrlForLegacyMappings(adopted.url);
			await this.savePluginData();
			Logger.info(`Migration complete: defaultCalendar set to ${adopted.url}`);
		} else {
			// (b) Ambiguous or no match — prompt user
			const reason = matches.length === 0
				? `No discovered calendar matches the legacy path "${legacyPath}".`
				: `Multiple calendars match the legacy path "${legacyPath}": ${matches.map((c) => c.url).join(", ")}.`;
			new Notice(
				`CalDAV plugin: ${reason} ` +
				'Please open Settings → CalDAV and pick a default calendar. Auto-sync has been disabled until you do.',
				0,
			);
			this.settings.enableAutoSync = false;
			await this.savePluginData();
			Logger.warn(`Migration blocked: ${reason}`);
		}
	}

	/**
	 * Load settings from plugin data storage
	 */
	async loadSettings() {
		const data = (await this.loadData()) as PluginData | null;

		if (data && data.settings) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);

			// Load sync mappings if they exist
			if (data.syncState && data.syncState.mappings) {
				loadMappings(data.syncState.mappings);
			} else {
				// Initialize empty mappings if no sync state exists
				loadMappings({});
			}
		} else {
			this.settings = Object.assign({}, DEFAULT_SETTINGS);
			// Initialize empty mappings for new installations
			loadMappings({});
		}
	}

	/**
	 * Save settings to plugin data storage
	 */
	async saveSettings() {
		await this.savePluginData();
	}

	/**
	 * Save all plugin data (settings and sync state)
	 */
	async savePluginData() {
		const data: PluginData = {
			// version 2: calendar-project-config — adds defaultCalendar + per-mapping calendarUrl
			version: 2,
			settings: this.settings,
			syncState: {
				mappings: saveMappings(),
			},
		};

		await this.saveData(data);
	}
}
